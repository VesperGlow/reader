// ReaderApp: 自包含的阅读器模块。
// - SPA 模式：由 router 调用 ReaderApp.init(#reader-view) 与 openBook(id, {embedded:true})。
// - 兼容模式：单独打开 reader.html?id=1 时自动 init(document.body) 并 openBook(id)。
// 同一会话内最多保留 2 本书的运行时缓存（keep-alive），再次打开同书不重新加载/解析。
window.ReaderApp = (function () {
  'use strict';

  const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'IMG', 'SVG', 'TABLE', 'HR']);
  const READER_CACHE_VERSION = window.readerCache?.CACHE_VERSION || 1;
  const RUNTIME_LIMIT = 2;

  // bookId(string) -> state，order 维护 LRU（末尾为最近使用）。
  const runtime = new Map();
  const order = [];

  let root = null;
  let els = {};
  let initialized = false;
  let active = null; // 当前展示的书 state
  let onExit = null;
  let repaginating = false;
  let repaginationPending = false;
  let progressSaveChain = Promise.resolve();
  let resizeTimer = null;

  // state: { bookId, info, kind, sourceModel, pages, currentPage, tocEntries, viewportW, viewportH }

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
      themeButton: scope.querySelector('#theme-button'),
      pageLabel: scope.querySelector('#page-label'),
    };
    bindEvents();
    initialized = true;
  }

  function bindEvents() {
    els.prevZone && (els.prevZone.onclick = previous);
    els.centerZone && (els.centerZone.onclick = toggleTools);
    els.nextZone && (els.nextZone.onclick = next);
    els.tocButton && (els.tocButton.onclick = () => openToc());
    els.tocClose && (els.tocClose.onclick = () => closeToc());
    els.tocScrim && (els.tocScrim.onclick = () => closeToc());
    els.themeButton && (els.themeButton.onclick = toggleTheme);
    els.back && (els.back.onclick = event => { if (onExit) { event.preventDefault?.(); onExit(); } });

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(requestRepagination, 250);
    });
    document.addEventListener('keydown', event => {
      if (!isVisible()) return;
      if (['ArrowLeft', 'PageUp'].includes(event.key)) previous();
      if (['ArrowRight', 'PageDown', ' '].includes(event.key)) next();
      // SPA 模式下由 Router 统一处理 ESC，避免重复触发 history.back。
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
        // 不淘汰当前书，把它挪到末尾后再看
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
    const urls = state?.sourceModel?.assetUrls;
    if (urls) for (const url of urls.values()) URL.revokeObjectURL(url);
  }

  // ---- 打开书籍 ----
  async function openBook(bookId, options = {}) {
    if (!initialized) init(options.root || document);
    bookId = String(bookId);
    if (options.onExit) onExit = options.onExit;
    show();

    // 复用：当前正展示的书，或运行时缓存里的书。
    const reused = (active && active.bookId === bookId) ? active : runtime.get(bookId);
    if (reused) {
      console.info('[reader runtime] hit', { bookId });
      if (active && active !== reused) saveProgress();
      active = reused;
      touchLRU(bookId);
      if (reused.viewportW !== els.viewport.clientWidth || reused.viewportH !== els.viewport.clientHeight) {
        await paginateState(reused, true);
      }
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
      renderPage(state.currentPage);
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
    renderPage(active.currentPage);
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
      .finally(() => console.timeEnd('restore progress'));

    setLoading('正在读取书籍…');
    const sourceModel = await loadBookSource(bookId, info);
    const state = { bookId, info, kind: info.kind, sourceModel, pages: [], currentPage: 0, tocEntries: [], viewportW: 0, viewportH: 0 };
    active = state;
    await paginateState(state, false);
    const progress = await savedProgress;
    state.currentPage = Math.min(Math.max(0, Number(progress.page) || 0), Math.max(0, state.pages.length - 1));
    return state;
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

  // ---- 分页 ----
  async function paginateState(state, preservePosition = true) {
    if (!state.sourceModel || repaginating) return;
    repaginating = true;
    console.time('paginate');
    const oldRatio = state.pages.length > 1 ? state.currentPage / (state.pages.length - 1) : 0;
    if (state === active) setLoading('正在分页…');
    await nextFrame();
    try {
      state.pages = state.sourceModel.kind === 'txt'
        ? paginateText(state.sourceModel.text)
        : paginateHtmlBlocks(state.sourceModel.blocks);
      if (!state.pages.length) state.pages = [makeTextPage('')];
      validatePageContinuity(state);
      state.tocEntries = mapTocToPages(state, state.sourceModel.toc || []);
      state.viewportW = els.viewport.clientWidth;
      state.viewportH = els.viewport.clientHeight;
      if (preservePosition) state.currentPage = Math.min(state.pages.length - 1, Math.round(oldRatio * Math.max(0, state.pages.length - 1)));
      if (state !== active) return;
      if (!els.loading.classList.contains('hidden')) return; // 初次加载，渲染交给调用方
      renderPage(state.currentPage);
      updatePageLabel();
      if (preservePosition) queueProgressSave(state.currentPage);
    } finally {
      console.timeEnd('paginate');
      repaginating = false;
      if (repaginationPending) {
        repaginationPending = false;
        setTimeout(() => active && paginateState(active, true), 0);
      }
    }
  }

  function createProbe(extraClass = '') {
    const viewport = els.viewport;
    const probe = document.createElement('div');
    probe.className = 'pagination-probe';
    probe.style.width = `${viewport.clientWidth}px`;
    probe.style.height = `${viewport.clientHeight}px`;
    const content = document.createElement('div');
    content.className = `page-content ${extraClass}`;
    probe.appendChild(content);
    document.body.appendChild(probe);
    return { probe, content };
  }

  function paginateText(text) {
    const result = [];
    const { probe, content } = createProbe('txt');
    let offset = 0;
    while (offset < text.length) {
      const remaining = text.length - offset;
      let high = Math.min(remaining, 4096);
      while (high < remaining && textFits(content, text.slice(offset, offset + high))) high = Math.min(remaining, high * 2);
      let low = 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (textFits(content, text.slice(offset, offset + middle))) low = middle;
        else high = middle - 1;
      }
      let length = Math.max(1, low);
      if (length < remaining) length = naturalBreak(text, offset, length);
      result.push(makeTextPage(text.slice(offset, offset + length), offset));
      offset += length;
    }
    probe.remove();
    return result;
  }

  function textFits(content, text) {
    content.textContent = text;
    return content.scrollHeight <= content.clientHeight + 1;
  }

  function naturalBreak(text, offset, length) {
    const sample = text.slice(offset, offset + length);
    const minimum = Math.floor(length * 0.72);
    const newline = sample.lastIndexOf('\n');
    if (newline >= minimum) return newline + 1;
    const whitespace = Math.max(sample.lastIndexOf(' '), sample.lastIndexOf('\t'));
    return whitespace >= minimum ? whitespace + 1 : length;
  }

  function paginateHtmlBlocks(blocks) {
    const result = [];
    const { probe, content } = createProbe('epub');
    let pageBlocks = [];

    const flush = () => {
      if (!pageBlocks.length) return;
      result.push(makeHtmlPage(pageBlocks));
      pageBlocks = [];
      content.replaceChildren();
    };

    for (const original of blocks) {
      const candidate = original.cloneNode(true);
      content.appendChild(candidate);
      if (content.scrollHeight <= content.clientHeight + 1) {
        pageBlocks.push(original);
        continue;
      }
      candidate.remove();
      flush();

      const retry = original.cloneNode(true);
      content.appendChild(retry);
      if (content.scrollHeight <= content.clientHeight + 1) {
        pageBlocks.push(original);
        continue;
      }
      content.replaceChildren();

      if (original.textContent.trim() && !['IMG', 'SVG'].includes(original.tagName)) {
        const pieces = splitOversizedBlock(original, content);
        for (const piece of pieces) result.push(makeHtmlPage([piece]));
      } else {
        pageBlocks.push(original);
        content.appendChild(original.cloneNode(true));
        flush();
      }
    }
    flush();
    probe.remove();
    return result;
  }

  function splitOversizedBlock(block, content) {
    const text = block.textContent;
    const pieces = [];
    const makePiece = () => ['TABLE', 'FIGURE'].includes(block.tagName) ? document.createElement('div') : block.cloneNode(false);
    let offset = 0;
    while (offset < text.length) {
      let low = 1;
      let high = text.length - offset;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const test = makePiece();
        test.textContent = text.slice(offset, offset + middle);
        content.replaceChildren(test);
        if (content.scrollHeight <= content.clientHeight + 1) low = middle;
        else high = middle - 1;
      }
      let length = Math.max(1, low);
      if (length < text.length - offset) length = naturalBreak(text, offset, length);
      const piece = makePiece();
      piece.removeAttribute('id');
      piece.textContent = text.slice(offset, offset + length);
      pieces.push(piece);
      offset += length;
    }
    content.replaceChildren();
    return pieces;
  }

  function makeTextPage(text, start = 0) {
    const fragment = document.createDocumentFragment();
    const content = document.createElement('div');
    content.className = 'page-content txt';
    content.dataset.textStart = start;
    content.appendChild(document.createTextNode(text));
    fragment.appendChild(content);
    return fragment;
  }

  function makeHtmlPage(blocks) {
    const fragment = document.createDocumentFragment();
    const content = document.createElement('div');
    content.className = 'page-content epub';
    for (const block of blocks) content.appendChild(block.cloneNode(true));
    fragment.appendChild(content);
    return fragment;
  }

  function validatePageContinuity(state) {
    const renderedText = state.pages.map(page => page.textContent).join('');
    const sourceText = state.sourceModel.kind === 'txt'
      ? state.sourceModel.text
      : state.sourceModel.blocks.map(block => block.textContent).join('');
    if (renderedText !== sourceText) throw new Error('分页连续性校验失败：检测到文字丢失或重复');
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

  function mapTocToPages(state, entries) {
    if (state.sourceModel.kind === 'txt') {
      const starts = state.pages.map(page => Number(page.querySelector('.page-content')?.dataset.textStart || 0));
      return entries.map(entry => {
        let page = 0;
        for (let index = 0; index < starts.length && starts[index] <= entry.offset; index++) page = index;
        return { ...entry, page };
      });
    }
    return entries.map(entry => {
      let page = state.pages.findIndex(fragment => {
        const content = fragment.querySelector('.page-content');
        if (!content) return false;
        if (entry.fragment && Array.from(content.querySelectorAll('[id]')).some(element => element.id === entry.fragment)) return true;
        return Array.from(content.querySelectorAll('[data-source-path]')).some(element => element.dataset.sourcePath === entry.path);
      });
      return { ...entry, page: Math.max(0, page) };
    });
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
          blocks.push(child.cloneNode(true));
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
    doc.querySelectorAll('script,iframe,object,embed,form,input,button').forEach(node => node.remove());
    doc.querySelectorAll('*').forEach(element => {
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
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

  // ---- 渲染 / 翻页 ----
  function renderPage(index) {
    if (!active || !active.pages[index]) return;
    els.page.replaceChildren(active.pages[index].cloneNode(true));
    updateTocActive();
  }

  function turnPage(direction) {
    if (repaginating || !active) return;
    const target = active.currentPage + (direction === 'next' ? 1 : -1);
    if (target < 0 || target >= active.pages.length) return;
    active.currentPage = target;
    renderPage(active.currentPage);
    updatePageLabel();
    queueProgressSave(active.currentPage);
  }

  function previous() { turnPage('prev'); }
  function next() { turnPage('next'); }
  function toggleTools() { els.themeRoot.classList.toggle('tools-hidden'); }
  function toggleTheme() { els.themeRoot.classList.toggle('dark'); }

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
      active.currentPage = Math.min(active.pages.length - 1, Math.max(0, entry.page));
      renderPage(active.currentPage);
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
    const percentage = active.pages.length <= 1 ? 100 : Math.round((active.currentPage / (active.pages.length - 1)) * 100);
    els.pageLabel.textContent = `${active.currentPage + 1} / ${active.pages.length} · ${percentage}%`;
  }

  function queueProgressSave(page) {
    if (!active) return;
    const bookId = active.bookId;
    const totalPages = active.pages.length;
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

  function requestRepagination() {
    if (!active || !isVisible()) return;
    if (repaginating) repaginationPending = true;
    else paginateState(active, true);
  }

  function setReaderFontSize(size) {
    const pixels = Math.max(14, Math.min(32, Number(size) || 18));
    document.documentElement.style.setProperty('--reader-font-size', `${pixels}px`);
    requestRepagination();
  }
  window.setReaderFontSize = setReaderFontSize;

  function getState() {
    return active ? { bookId: active.bookId, page: active.currentPage } : null;
  }

  async function restoreState(state) {
    if (!state || !state.bookId) return;
    await openBook(state.bookId, {});
    if (active && Number.isFinite(state.page)) {
      active.currentPage = Math.min(Math.max(0, state.page), Math.max(0, active.pages.length - 1));
      renderPage(active.currentPage);
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
