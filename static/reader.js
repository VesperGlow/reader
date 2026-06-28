// ReaderApp: 自包含的阅读器模块（CSS 分栏分页版）。
// - SPA 模式：由 router 调用 ReaderApp.init(#reader-view) 与 openBook(id, {embedded:true})。
// - 兼容模式：单独打开 reader.html?id=1 时自动 init(document.body) 并 openBook(id)。
// 渲染：把整本书的内容放进一个多栏容器（每栏=一屏），靠 translateX 切页，浏览器负责按行填满与重排。
// 同一会话内最多保留 2 本书的运行时缓存（keep-alive）。
window.ReaderApp = (function () {
  'use strict';

  const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'IMG', 'SVG', 'TABLE', 'HR']);
  const READER_CACHE_VERSION = window.readerCache?.CACHE_VERSION || 1;
  const RUNTIME_LIMIT = 2;
  const MAX_COLUMN = 720; // 桌面宽屏时限制单栏文字宽度，保证可读性

  const runtime = new Map(); // bookId(string) -> state
  const order = [];          // LRU：末尾为最近使用

  let root = null;
  let els = {};
  let initialized = false;
  let active = null; // 当前展示的书 state
  let onExit = null;
  let progressSaveChain = Promise.resolve();
  let resizeTimer = null;

  // state: { bookId, info, kind, contentNode, toc, tocEntries, assetUrls,
  //          currentPage, pageCount, pageWidth, pageHeight, restoreRatio }

  function init(rootElement) {
    if (initialized) return;
    root = rootElement || document;
    const scope = root === document ? document : root;
    els = {
      view: scope.querySelector ? (scope.id === 'reader-view' ? scope : scope.querySelector('#reader-view')) : null,
      themeRoot: scope.querySelector && scope.querySelector('#reader-view') ? scope.querySelector('#reader-view') : (root === document ? document.body : root),
      title: scope.querySelector('#reader-title'),
      kind: scope.querySelector('#reader-kind'),
      back: scope.querySelector('#reader-back'),
      tocButton: scope.querySelector('#toc-button'),
      viewport: scope.querySelector('#viewport'),
      loading: scope.querySelector('#loading'),
      page: scope.querySelector('#reader-page'),
      prevZone: scope.querySelector('#prev-zone'),
      centerZone: scope.querySelector('#center-zone'),
      nextZone: scope.querySelector('#next-zone'),
      tocScrim: scope.querySelector('#toc-scrim'),
      tocDrawer: scope.querySelector('#toc-drawer'),
      tocClose: scope.querySelector('#toc-close'),
      tocList: scope.querySelector('#toc-list'),
      tocButton2: scope.querySelector('#toc-button-2'),
      themeButton: scope.querySelector('#theme-button'),
      pageLabel: scope.querySelector('#page-label'),
      slider: scope.querySelector('#page-slider'),
      fontButton: scope.querySelector('#font-button'),
      fontPopover: scope.querySelector('#font-popover'),
      fontSlider: scope.querySelector('#font-slider'),
      fontSmaller: scope.querySelector('#font-smaller'),
      fontLarger: scope.querySelector('#font-larger'),
    };
    bindEvents();
    loadPrefs();
    initialized = true;
  }

  function bindEvents() {
    els.prevZone && (els.prevZone.onclick = previous);
    els.centerZone && (els.centerZone.onclick = toggleTools);
    els.nextZone && (els.nextZone.onclick = next);
    els.tocButton && (els.tocButton.onclick = () => openToc());
    els.tocButton2 && (els.tocButton2.onclick = () => openToc());
    els.tocClose && (els.tocClose.onclick = () => closeToc());
    els.tocScrim && (els.tocScrim.onclick = () => closeToc());
    els.themeButton && (els.themeButton.onclick = toggleTheme);
    els.back && (els.back.onclick = event => { if (onExit) { event.preventDefault?.(); onExit(); } });
    els.slider && (els.slider.oninput = event => seekTo(Number(event.target.value), false));
    els.slider && (els.slider.onchange = () => active && queueProgressSave(active.currentPage));
    els.fontButton && (els.fontButton.onclick = () => els.fontPopover?.classList.toggle('hidden'));
    els.fontSlider && (els.fontSlider.oninput = event => setReaderFontSize(Number(event.target.value)));
    els.fontSmaller && (els.fontSmaller.onclick = () => stepFontSize(-1));
    els.fontLarger && (els.fontLarger.onclick = () => stepFontSize(1));

    // 地址栏滑入/滑出（dvh 变化）有时只动 visualViewport 而不触发 window.resize，两个都听。
    // 仅在视口尺寸真正变化时才重排，避免 visualViewport 的杂音事件造成无谓重排；
    // 改字号引起的重排走 setReaderFontSize 直接调用，不经过这里。
    const scheduleRelayout = () => {
      if (active && els.viewport.clientWidth === active.pageWidth && els.viewport.clientHeight === active.pageHeight) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(relayoutActive, 200);
    };
    window.addEventListener('resize', scheduleRelayout);
    window.visualViewport?.addEventListener('resize', scheduleRelayout);
    document.addEventListener('keydown', event => {
      if (!isVisible()) return;
      if (['ArrowLeft', 'PageUp'].includes(event.key)) previous();
      if (['ArrowRight', 'PageDown', ' '].includes(event.key)) next();
      if (event.key === 'Escape' && isTocOpen() && !window.Router) closeToc();
    });
    const flush = () => saveProgress();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }

  function isVisible() {
    if (!active) return false;
    if (els.view) return !els.view.classList.contains('hidden');
    return true;
  }

  function show() {
    if (els.view) els.view.classList.remove('hidden');
    document.body.classList.add('reader-open');
  }

  function hide() {
    saveProgress();
    if (els.view) els.view.classList.add('hidden');
    document.body.classList.remove('reader-open');
  }

  async function api(url, options = {}) {
    const response = await fetch(url, options);
    if (response.status === 401) {
      location.href = '/';
      throw new Error('请先登录');
    }
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || '打开失败');
    return response;
  }

  // ---- 运行时缓存（keep-alive） ----
  function touchLRU(bookId) {
    const index = order.indexOf(bookId);
    if (index !== -1) order.splice(index, 1);
    order.push(bookId);
  }

  function evictLRU() {
    while (order.length > RUNTIME_LIMIT) {
      const oldest = order[0];
      if (oldest === active?.bookId) {
        order.push(order.shift());
        if (order[0] === active?.bookId) break;
        continue;
      }
      destroyBook(oldest);
    }
  }

  function destroyBook(bookId) {
    bookId = String(bookId);
    const state = runtime.get(bookId);
    if (state) {
      releaseAssets(state);
      runtime.delete(bookId);
    }
    const index = order.indexOf(bookId);
    if (index !== -1) order.splice(index, 1);
  }

  function releaseAssets(state) {
    if (state?.assetUrls) for (const url of state.assetUrls.values()) URL.revokeObjectURL(url);
  }

  // ---- 打开书籍 ----
  async function openBook(bookId, options = {}) {
    if (!initialized) init(options.root || document);
    bookId = String(bookId);
    if (options.onExit) onExit = options.onExit;
    show();

    const reused = (active && active.bookId === bookId) ? active : runtime.get(bookId);
    if (reused) {
      console.info('[reader runtime] hit', { bookId });
      if (active && active !== reused) saveProgress();
      active = reused;
      touchLRU(bookId);
      applyActiveToDom();
      return;
    }
    if (active) saveProgress();

    console.info('[reader runtime] miss', { bookId });
    closeToc(true);
    setLoading('正在打开书页…');
    els.loading.classList.remove('hidden');
    try {
      const state = await loadBookState(bookId, options);
      runtime.set(bookId, state);
      touchLRU(bookId);
      active = state;
      evictLRU();
      activate(state);
      renderToc();
      els.loading.classList.add('hidden');
      updatePageLabel();
      queueProgressSave(state.currentPage);
    } catch (error) {
      fail(error.message);
    }
  }

  function applyActiveToDom() {
    if (!active) return;
    setHeader(active.info);
    const mounted = els.page.firstElementChild === active.contentNode;
    if (!mounted || active.pageWidth !== els.viewport.clientWidth || active.pageHeight !== els.viewport.clientHeight) {
      activate(active);
    } else {
      goToPage(active, active.currentPage);
    }
    renderToc();
    els.loading.classList.add('hidden');
    updatePageLabel();
  }

  function setHeader(info) {
    els.title.textContent = info.title;
    els.kind.textContent = (info.kind || '').toUpperCase();
    document.title = `${info.title} · 页间`;
  }

  async function loadBookState(bookId, options) {
    const info = options.book || await fetchBookInfo(bookId);
    if (!info) throw new Error('书籍不存在');
    setHeader(info);
    console.time('restore progress');
    const savedProgress = api(`/api/books/${bookId}/progress`)
      .then(response => response.json())
      .catch(() => ({ page: 0, total_pages: null }))
      .finally(() => console.timeEnd('restore progress'));

    setLoading('正在读取书籍…');
    const model = await loadBookSource(bookId, info);
    const contentNode = assembleContent(model);
    const state = {
      bookId, info, kind: info.kind, contentNode,
      toc: model.toc || [], tocEntries: [], assetUrls: model.assetUrls || null,
      currentPage: 0, pageCount: 1, pageWidth: 0, pageHeight: 0, restoreRatio: 0,
    };
    const progress = await savedProgress;
    state.restoreRatio = progress && progress.total_pages > 1
      ? Math.min(1, Math.max(0, Number(progress.page) / (Number(progress.total_pages) - 1)))
      : 0;
    return state;
  }

  function assembleContent(model) {
    if (model.kind === 'txt') {
      const node = document.createElement('div');
      node.className = 'book-content txt';
      const toc = (model.toc || []).map((entry, index) => ({ offset: Number(entry.offset) || 0, index }))
        .sort((a, b) => a.offset - b.offset);
      let pos = 0;
      for (const { offset, index } of toc) {
        const at = Math.max(pos, Math.min(model.text.length, offset));
        if (at > pos) node.appendChild(document.createTextNode(model.text.slice(pos, at)));
        const anchor = document.createElement('span');
        anchor.className = 'toc-anchor';
        anchor.dataset.toc = String(index);
        node.appendChild(anchor);
        pos = at;
      }
      node.appendChild(document.createTextNode(model.text.slice(pos)));
      return node;
    }
    const node = document.createElement('div');
    node.className = 'book-content epub';
    for (const block of model.blocks) node.appendChild(block);
    return node;
  }

  async function fetchBookInfo(bookId) {
    const books = await (await api('/api/books')).json();
    return books.find(book => String(book.id) === String(bookId)) || null;
  }

  async function loadBookSource(bookId, info) {
    const cached = await readBookCache(bookId, info);
    if (cached) {
      console.info('[reader cache] file hit', { bookId });
      try {
        const result = await buildSourceModel(bookId, cached.file, info, cached.metadata);
        if (!metadataMatches(cached.metadata, info.kind, info.updated_at)) void writeBookCache(bookId, info, cached.file, result.metadata);
        return result.model;
      } catch (error) {
        console.warn('[reader cache] cached file failed, falling back to network', error);
        await removeBookCache(bookId);
      }
    } else {
      console.info('[reader cache] miss', { bookId });
    }

    const file = await fetchBookFile(bookId);
    const result = await buildSourceModel(bookId, file, info, null);
    void writeBookCache(bookId, info, file, result.metadata);
    return result.model;
  }

  async function readBookCache(bookId, info) {
    if (!window.readerCache) return null;
    console.time('cache lookup');
    try {
      return await window.readerCache.get(bookId, info);
    } catch (error) {
      console.warn('[reader cache] read failed, falling back to network', error);
      return null;
    } finally {
      console.timeEnd('cache lookup');
    }
  }

  async function writeBookCache(bookId, info, file, metadata) {
    if (!window.readerCache) return;
    try {
      await window.readerCache.put(bookId, info, file, metadata);
      console.info('[reader cache] stored', { bookId });
    } catch (error) {
      console.warn('[reader cache] write failed', error);
    }
  }

  async function removeBookCache(bookId) {
    if (!window.readerCache) return;
    try { await window.readerCache.remove(bookId); } catch (error) { console.warn('[reader cache] remove failed', error); }
  }

  async function fetchBookFile(bookId) {
    console.time('fetch book');
    try {
      const response = await api(`/api/books/${bookId}/file`);
      return await response.blob();
    } finally {
      console.timeEnd('fetch book');
    }
  }

  async function buildSourceModel(bookId, file, info, metadata) {
    if (info.kind === 'txt') {
      const text = file instanceof Blob ? await file.text() : new TextDecoder().decode(file);
      console.time('parse toc');
      let toc;
      try {
        toc = metadataMatches(metadata, 'txt', info.updated_at) ? metadata.toc : extractTextToc(text);
      } finally {
        console.timeEnd('parse toc');
      }
      if (metadataMatches(metadata, 'txt', info.updated_at)) console.info('[reader cache] metadata hit', { bookId });
      return {
        model: { kind: 'txt', text, toc },
        metadata: { opfPath: null, manifest: [], spine: [], toc, cover: null, updatedAt: Number(info.updated_at), cacheVersion: READER_CACHE_VERSION },
      };
    }

    if (!window.JSZip) throw new Error('JSZip 组件加载失败');
    console.time('read arrayBuffer');
    let buffer;
    try {
      buffer = file instanceof Blob ? await file.arrayBuffer() : file;
    } finally {
      console.timeEnd('read arrayBuffer');
    }
    return parseEpub(bookId, buffer, metadataMatches(metadata, 'epub', info.updated_at) ? metadata : null, info.updated_at);
  }

  function metadataMatches(metadata, kind, updatedAt) {
    if (!metadata || metadata.cacheVersion !== READER_CACHE_VERSION || metadata.updatedAt !== Number(updatedAt) || !Array.isArray(metadata.toc)) return false;
    if (kind === 'txt') return true;
    return typeof metadata.opfPath === 'string' && Array.isArray(metadata.manifest) && Array.isArray(metadata.spine);
  }

  async function parseEpub(bookId, buffer, cachedMetadata = null, updatedAt = 0) {
    setLoading('正在解析 EPUB…');
    console.time('zip load');
    let zip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } finally {
      console.timeEnd('zip load');
    }

    let opfPath;
    let manifest;
    let spineIds;
    let toc;
    let cover;
    let opfDoc = null;
    console.time('parse opf');
    try {
      if (cachedMetadata) {
        opfPath = cachedMetadata.opfPath;
        manifest = new Map(cachedMetadata.manifest.map(([id, item]) => [id, { ...item }]));
        spineIds = cachedMetadata.spine.slice();
        cover = cachedMetadata.cover || null;
        console.info('[reader cache] metadata hit', { bookId });
      } else {
        const containerText = await requiredZipText(zip, 'META-INF/container.xml');
        const containerDoc = parseXml(containerText);
        const rootfile = localElements(containerDoc, 'rootfile')[0];
        if (!rootfile) throw new Error('EPUB 缺少 container rootfile');
        opfPath = normalizePath(rootfile.getAttribute('full-path'));
        opfDoc = parseXml(await requiredZipText(zip, opfPath));
        manifest = new Map();
        for (const item of localElements(opfDoc, 'item')) {
          const path = resolvePath(opfPath, item.getAttribute('href') || '');
          const record = { path, mediaType: item.getAttribute('media-type') || '', properties: item.getAttribute('properties') || '' };
          manifest.set(item.getAttribute('id'), record);
        }
        spineIds = localElements(opfDoc, 'itemref').map(item => item.getAttribute('idref')).filter(Boolean);
        cover = extractCoverInfo(opfDoc, manifest);
      }
    } finally {
      console.timeEnd('parse opf');
    }

    const mimeByPath = new Map();
    for (const item of manifest.values()) mimeByPath.set(item.path, item.mediaType);
    console.time('parse toc');
    try {
      toc = opfDoc
        ? await extractEpubToc(zip, opfPath, opfDoc, manifest)
        : cachedMetadata.toc.slice();
    } finally {
      console.timeEnd('parse toc');
    }
    const assetUrls = new Map();
    const blocks = [];

    console.time('render chapter');
    try {
      for (let index = 0; index < spineIds.length; index++) {
        const item = manifest.get(spineIds[index]);
        if (!item || !/xhtml|html|xml/i.test(item.mediaType)) continue;
        setLoading(`正在解析章节 ${index + 1} / ${spineIds.length}…`);
        const chapter = new DOMParser().parseFromString(await requiredZipText(zip, item.path), 'text/html');
        sanitizeDocument(chapter);
        await localizeAssets(chapter, item.path, zip, mimeByPath, assetUrls);
        const chapterBlocks = collectReadableBlocks(chapter.body);
        chapterBlocks.forEach(block => block.dataset.sourcePath = item.path);
        blocks.push(...chapterBlocks);
        await nextFrame();
      }
    } finally {
      console.timeEnd('render chapter');
    }
    if (!blocks.length) throw new Error('EPUB 中没有可阅读内容');
    return {
      model: { kind: 'epub', blocks, assetUrls, toc },
      metadata: {
        opfPath,
        manifest: Array.from(manifest.entries()),
        spine: spineIds,
        toc,
        cover,
        updatedAt: Number(updatedAt),
        cacheVersion: READER_CACHE_VERSION,
      },
    };
  }

  function extractCoverInfo(opfDoc, manifest) {
    const coverId = localElements(opfDoc, 'meta').find(meta => meta.getAttribute('name') === 'cover')?.getAttribute('content');
    let entry = coverId && manifest.has(coverId) ? [coverId, manifest.get(coverId)] : null;
    if (!entry) entry = Array.from(manifest.entries()).find(([, item]) => (item.properties || '').split(/\s+/).includes('cover-image'));
    if (!entry) entry = Array.from(manifest.entries()).find(([, item]) => /(^|[/_.-])cover([/_.-]|$)/i.test(item.path) && /^image\//.test(item.mediaType));
    return entry ? { id: entry[0], path: entry[1].path, mediaType: entry[1].mediaType } : null;
  }

  async function extractEpubToc(zip, opfPath, opfDoc, manifest) {
    const items = Array.from(manifest.values());
    const navItem = items.find(item => /(^|\s)nav(\s|$)/.test(item.properties || ''));
    if (navItem) {
      const navDoc = new DOMParser().parseFromString(await requiredZipText(zip, navItem.path), 'text/html');
      const navs = Array.from(navDoc.querySelectorAll('nav'));
      const nav = navs.find(element => element.getAttribute('epub:type') === 'toc' || element.getAttribute('type') === 'toc') || navs[0];
      if (nav) {
        const entries = Array.from(nav.querySelectorAll('a[href]')).map(anchor => {
          const href = anchor.getAttribute('href');
          const hash = href.includes('#') ? decodePath(href.split('#').slice(1).join('#')) : '';
          return { label: anchor.textContent.trim(), path: resolvePath(navItem.path, href), fragment: hash, depth: tocDepth(anchor) };
        }).filter(entry => entry.label);
        if (entries.length) return entries;
      }
    }
    const ncxId = localElements(opfDoc, 'spine')[0]?.getAttribute('toc');
    const ncxItem = manifest.get(ncxId) || items.find(item => /ncx/i.test(item.mediaType));
    if (!ncxItem) return [];
    const ncxDoc = parseXml(await requiredZipText(zip, ncxItem.path));
    return localElements(ncxDoc, 'navPoint').map(point => {
      const content = localElements(point, 'content')[0];
      const src = content?.getAttribute('src') || '';
      const hash = src.includes('#') ? decodePath(src.split('#').slice(1).join('#')) : '';
      return { label: localElements(point, 'text')[0]?.textContent.trim() || '未命名章节', path: resolvePath(ncxItem.path, src), fragment: hash, depth: ancestorDepth(point, 'navPoint') };
    });
  }

  function tocDepth(anchor) {
    let depth = 0;
    for (let node = anchor.parentElement; node; node = node.parentElement) if (node.tagName === 'OL' || node.tagName === 'UL') depth++;
    return Math.max(0, depth - 1);
  }

  function ancestorDepth(element, localName) {
    let depth = 0;
    for (let node = element.parentElement; node; node = node.parentElement) if (node.localName === localName) depth++;
    return depth;
  }

  function extractTextToc(text) {
    const entries = [];
    const pattern = /^(?:\s{0,4})(第[零〇一二三四五六七八九十百千万两\d]+[章节卷部回篇][^\n]{0,40}|(?:chapter|part)\s+[\divxlcdm]+[^\n]{0,40})\s*$/gim;
    for (const match of text.matchAll(pattern)) entries.push({ label: match[1].trim(), offset: match.index, depth: 0 });
    return entries.slice(0, 500);
  }

  function collectReadableBlocks(rootNode) {
    const blocks = [];
    const walk = parent => {
      for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent.trim()) {
            const paragraph = document.createElement('p');
            paragraph.textContent = child.textContent;
            blocks.push(paragraph);
          }
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (BLOCK_TAGS.has(child.tagName)) {
          // 丢弃空段落/空标题（EPUB 常用它们撑排版，会让排版忽松忽紧）。
          if (child.tagName === 'HR' || child.textContent.trim() || child.querySelector('img,svg,image')) {
            blocks.push(child.cloneNode(true));
          }
        } else if (hasBlockDescendant(child)) {
          walk(child);
        } else if (child.textContent.trim() || child.querySelector('img,svg')) {
          blocks.push(child.cloneNode(true));
        }
      }
    };
    walk(rootNode);
    return blocks;
  }

  function hasBlockDescendant(element) {
    return Array.from(element.querySelectorAll('*')).some(child => BLOCK_TAGS.has(child.tagName));
  }

  function sanitizeDocument(doc) {
    doc.querySelectorAll('script,iframe,object,embed,form,input,button,meta,base').forEach(node => node.remove());
    doc.querySelectorAll('*').forEach(element => {
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
      // 链接里的危险协议清掉：javascript:/vbscript: 一律去；data: 仅 SVG <image> 放行（图片走 src）。
      const tag = element.localName;
      for (const attribute of ['href', 'xlink:href']) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        if (/^\s*(?:javascript|vbscript):/i.test(value)) { element.removeAttribute(attribute); continue; }
        if (/^\s*data:/i.test(value) && tag !== 'image') element.removeAttribute(attribute);
      }
      // 去掉书内自带的内联排版，统一交给阅读器样式，避免间距/字号忽大忽小。
      element.removeAttribute('style');
      element.removeAttribute('align');
    });
    doc.querySelectorAll('style,link[rel="stylesheet"]').forEach(node => node.remove());
  }

  async function localizeAssets(doc, chapterPath, zip, mimeByPath, cache) {
    const elements = Array.from(doc.querySelectorAll('[src],image[href],image[xlink\\:href]'));
    await Promise.all(elements.map(async element => {
      const attribute = element.hasAttribute('src') ? 'src' : element.hasAttribute('href') ? 'href' : 'xlink:href';
      const value = element.getAttribute(attribute);
      if (!value || /^(data:|blob:|https?:)/i.test(value)) return;
      const path = resolvePath(chapterPath, value);
      const file = zip.file(path);
      if (!file) return;
      if (!cache.has(path)) {
        const blob = await file.async('blob');
        cache.set(path, URL.createObjectURL(new Blob([blob], { type: mimeByPath.get(path) || blob.type || 'application/octet-stream' })));
      }
      element.setAttribute(attribute, cache.get(path));
      element.removeAttribute('srcset');
      if (element.tagName === 'IMG' && typeof element.decode === 'function') {
        try { await element.decode(); } catch (_) {}
      }
    }));
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('EPUB XML 格式无效');
    return doc;
  }

  function localElements(doc, name) {
    return Array.from(doc.getElementsByTagName('*')).filter(element => element.localName === name);
  }

  async function requiredZipText(zip, path) {
    const file = zip.file(normalizePath(path));
    if (!file) throw new Error(`EPUB 缺少文件：${path}`);
    return file.async('string');
  }

  function resolvePath(baseFile, relative) {
    const clean = decodePath(String(relative).split('#')[0].split('?')[0]);
    if (!clean) return normalizePath(baseFile);
    const base = clean.startsWith('/') ? [] : normalizePath(baseFile).split('/').slice(0, -1);
    return normalizePath([...base, ...clean.split('/')].join('/'));
  }

  function normalizePath(path) {
    const parts = [];
    for (const part of String(path || '').replace(/^\//, '').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop(); else parts.push(part);
    }
    return parts.join('/');
  }

  function decodePath(path) {
    try { return decodeURIComponent(path); } catch (_) { return path; }
  }

  // ---- 分栏布局 / 翻页 ----
  function activate(state) {
    if (els.page.firstElementChild !== state.contentNode) els.page.replaceChildren(state.contentNode);
    measure(state);
    if (state.restoreRatio != null) {
      state.currentPage = Math.round(state.restoreRatio * Math.max(0, state.pageCount - 1));
      state.restoreRatio = null;
    }
    goToPage(state, state.currentPage);
  }

  function measure(state) {
    const node = state.contentNode;
    const width = els.viewport.clientWidth;
    const height = els.viewport.clientHeight;
    let sidePad = Math.round(Math.min(Math.max(width * 0.055, 16), 44));
    if (width - 2 * sidePad > MAX_COLUMN) sidePad = Math.round((width - MAX_COLUMN) / 2);
    // 关键：把容器宽度钉成整数、box-sizing 内联强制，保证栏距严格 = 整数屏宽，
    // 否则浏览器用小数宽拉伸单栏，会让 translateX 逐页漂移、文字接不上。
    node.style.boxSizing = 'border-box';
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
    node.style.padding = `28px ${sidePad}px 24px`;
    node.style.columnWidth = `${Math.max(1, width - 2 * sidePad)}px`;
    node.style.columnGap = `${2 * sidePad}px`;
    node.style.columnFill = 'auto';
    node.style.transform = 'translateX(0px)';
    state.pageWidth = width;
    state.pageHeight = height;
    state.pageStep = width;
    state.pageCount = Math.max(1, Math.round(node.scrollWidth / width));
    mapTocPages(state);
  }

  function goToPage(state, index) {
    state.currentPage = Math.min(Math.max(0, index), Math.max(0, state.pageCount - 1));
    state.contentNode.style.transform = `translateX(${-state.currentPage * state.pageStep}px)`;
    updateTocActive();
  }

  function mapTocPages(state) {
    const node = state.contentNode;
    const baseLeft = node.getBoundingClientRect().left;
    state.tocEntries = (state.toc || []).map((entry, index) => {
      const target = findTocTarget(state, entry, index);
      let page = 0;
      if (target) page = Math.max(0, Math.round((target.getBoundingClientRect().left - baseLeft) / state.pageStep));
      return { ...entry, page: Math.min(page, state.pageCount - 1) };
    });
  }

  function findTocTarget(state, entry, index) {
    const node = state.contentNode;
    if (state.kind === 'txt') return node.querySelector(`[data-toc="${index}"]`);
    if (entry.fragment) {
      const byId = Array.from(node.querySelectorAll('[id]')).find(element => element.id === entry.fragment);
      if (byId) return byId;
    }
    return Array.from(node.querySelectorAll('[data-source-path]')).find(element => element.dataset.sourcePath === entry.path) || null;
  }

  function turnPage(direction) {
    if (!active) return;
    const target = active.currentPage + (direction === 'next' ? 1 : -1);
    if (target < 0 || target >= active.pageCount) return;
    goToPage(active, target);
    updatePageLabel();
    queueProgressSave(active.currentPage);
  }

  function previous() { turnPage('prev'); }
  function next() { turnPage('next'); }

  function seekTo(page, save = true) {
    if (!active) return;
    goToPage(active, page);
    updatePageLabel();
    if (save) queueProgressSave(active.currentPage);
  }

  function relayoutActive() {
    if (!active || !isVisible()) return;
    // 重排前抓住当前页左上角的文字位置；重排后把它对回页顶，正文不漂移、不跳行。
    // 抓不到锚点（极少数情况）才退回旧的按比例映射。
    const anchor = captureTopAnchor(active);
    const fallbackRatio = active.pageCount > 1 ? active.currentPage / (active.pageCount - 1) : 0;
    measure(active);
    let page = anchor ? anchorPage(active, anchor) : null;
    if (page == null) page = Math.round(fallbackRatio * Math.max(0, active.pageCount - 1));
    goToPage(active, page);
    renderToc();
    updatePageLabel();
    queueProgressSave(active.currentPage);
  }

  // 用 DOM 文本锚点记录"当前页顶端是哪段文字"。EPUB（块元素）与 TXT（裸文本节点）通用。
  function captureTopAnchor(state) {
    const node = state.contentNode;
    const style = getComputedStyle(node);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const rect = els.viewport.getBoundingClientRect();
    return caretAt(rect.left + padLeft + 8, rect.top + padTop + 8);
  }

  function caretAt(x, y) {
    // 透明翻页热区盖在正文之上，会先被命中测试取到。临时让它们对命中透明，才能定位到文字。
    const zones = [els.prevZone, els.centerZone, els.nextZone].filter(Boolean);
    const saved = zones.map(zone => zone.style.pointerEvents);
    zones.forEach(zone => { zone.style.pointerEvents = 'none'; });
    try {
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
      }
      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        return range ? { node: range.startContainer, offset: range.startOffset } : null;
      }
      return null;
    } catch (_) {
      return null;
    } finally {
      zones.forEach((zone, index) => { zone.style.pointerEvents = saved[index]; });
    }
  }

  function anchorPage(state, anchor) {
    if (!anchor || !anchor.node || !anchor.node.isConnected) return null;
    if (!state.contentNode.contains(anchor.node)) return null;
    try {
      const range = document.createRange();
      const max = anchor.node.nodeType === Node.TEXT_NODE ? anchor.node.length : anchor.node.childNodes.length;
      range.setStart(anchor.node, Math.min(anchor.offset, max));
      range.collapse(true);
      const rects = range.getClientRects();
      const rect = rects.length ? rects[0] : range.getBoundingClientRect();
      if (!rect) return null;
      const baseLeft = state.contentNode.getBoundingClientRect().left;
      const page = Math.round((rect.left - baseLeft) / state.pageStep);
      return Math.max(0, Math.min(state.pageCount - 1, page));
    } catch (_) {
      return null;
    }
  }

  function toggleTools() {
    els.themeRoot.classList.toggle('tools-hidden');
    if (els.themeRoot.classList.contains('tools-hidden')) els.fontPopover?.classList.add('hidden');
  }

  function toggleTheme() {
    els.themeRoot.classList.toggle('dark');
    try { localStorage.setItem('reader-theme', els.themeRoot.classList.contains('dark') ? 'dark' : 'light'); } catch (_) {}
  }

  function stepFontSize(delta) {
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--reader-font-size'), 10) || 19;
    setReaderFontSize(current + delta);
  }

  function loadPrefs() {
    try {
      const size = Number(localStorage.getItem('reader-font-size'));
      if (Number.isFinite(size) && size > 0) {
        const pixels = Math.max(14, Math.min(32, size));
        document.documentElement.style.setProperty('--reader-font-size', `${pixels}px`);
        if (els.fontSlider) els.fontSlider.value = pixels;
      }
      const theme = localStorage.getItem('reader-theme');
      if (theme === 'dark') els.themeRoot.classList.add('dark');
      else if (theme === 'light') els.themeRoot.classList.remove('dark');
    } catch (_) {}
  }

  // ---- 目录 ----
  function renderToc() {
    const list = els.tocList;
    const entries = active?.tocEntries || [];
    if (!entries.length) {
      list.innerHTML = `<p class="toc-empty">${active?.kind === 'txt' ? '没有识别到“第…章”格式的章节标题。' : '这本 EPUB 没有提供可用目录。'}</p>`;
      return;
    }
    list.innerHTML = entries.map((entry, index) => `<button class="toc-item" data-toc-index="${index}" style="--toc-indent:${Math.min(4, entry.depth || 0) * 16}px">${escapeHtml(entry.label)}</button>`).join('');
    list.querySelectorAll('[data-toc-index]').forEach(button => button.onclick = () => {
      const entry = active.tocEntries[Number(button.dataset.tocIndex)];
      goToPage(active, entry.page);
      updatePageLabel();
      queueProgressSave(active.currentPage);
      closeToc();
    });
    updateTocActive();
  }

  function updateTocActive() {
    const entries = active?.tocEntries || [];
    if (!entries.length) return;
    let activeIndex = 0;
    for (let index = 0; index < entries.length; index++) if (entries[index].page <= active.currentPage) activeIndex = index;
    els.tocList.querySelectorAll('[data-toc-index]').forEach((button, index) => button.classList.toggle('active', index === activeIndex));
  }

  function openToc() {
    if (isTocOpen()) return;
    history.pushState({ ...history.state, tocDrawer: true }, '', location.href);
    els.tocDrawer.classList.add('open');
    els.tocDrawer.setAttribute('aria-hidden', 'false');
    els.tocButton.setAttribute('aria-expanded', 'true');
    els.tocScrim.classList.remove('hidden');
  }

  function closeToc(fromHistory = false) {
    if (!isTocOpen()) return;
    if (!fromHistory && history.state?.tocDrawer) { history.back(); return; }
    els.tocDrawer.classList.remove('open');
    els.tocDrawer.setAttribute('aria-hidden', 'true');
    els.tocButton.setAttribute('aria-expanded', 'false');
    els.tocScrim.classList.add('hidden');
  }

  function isTocOpen() { return els.tocDrawer?.classList.contains('open'); }

  function updatePageLabel() {
    if (!active) return;
    const percentage = active.pageCount <= 1 ? 100 : Math.round((active.currentPage / (active.pageCount - 1)) * 100);
    els.pageLabel.textContent = `${active.currentPage + 1} / ${active.pageCount} · ${percentage}%`;
    if (els.slider) {
      els.slider.max = Math.max(0, active.pageCount - 1);
      els.slider.value = active.currentPage;
    }
  }

  function queueProgressSave(page) {
    if (!active) return;
    const bookId = active.bookId;
    const totalPages = active.pageCount;
    progressSaveChain = progressSaveChain.then(() => api(`/api/books/${bookId}/progress`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page, total_pages: totalPages }), keepalive: true,
    })).catch(error => console.error('保存阅读进度失败', error));
  }

  function saveProgress() {
    if (active) queueProgressSave(active.currentPage);
  }

  function setLoading(message) { els.loading.textContent = message; }
  function fail(message) { els.loading.classList.remove('hidden'); setLoading(message); }
  function nextFrame() { return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }
  function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }

  function setReaderFontSize(size) {
    const pixels = Math.max(14, Math.min(32, Number(size) || 18));
    document.documentElement.style.setProperty('--reader-font-size', `${pixels}px`);
    if (els.fontSlider) els.fontSlider.value = pixels;
    try { localStorage.setItem('reader-font-size', pixels); } catch (_) {}
    relayoutActive();
  }
  window.setReaderFontSize = setReaderFontSize;

  function getState() {
    return active ? { bookId: active.bookId, page: active.currentPage } : null;
  }

  async function restoreState(state) {
    if (!state || !state.bookId) return;
    await openBook(state.bookId, {});
    if (active && Number.isFinite(state.page)) {
      goToPage(active, state.page);
      updatePageLabel();
    }
  }

  // 兼容入口：单独打开 reader.html?id=1
  if (document.body.classList.contains('reading-body')) {
    const id = new URLSearchParams(location.search).get('id');
    init(document.body);
    if (id) openBook(id, { standalone: true });
    else fail('缺少书籍编号');
  }

  return { init, openBook, hide, show, saveProgress, getState, restoreState, destroyBook, isTocOpen, closeToc };
})();
