// ReaderApp: 自包含的阅读器模块（CSS 分栏分页版）。
// - SPA 模式：由 router 调用 ReaderApp.init(#reader-view) 与 openBook(id, {embedded:true})。
// - 兼容模式：单独打开 reader.html?id=1 时自动 init(document.body) 并 openBook(id)。
// 渲染：把整本书的内容放进一个多栏容器（每栏=一屏），靠 translateX 切页，浏览器负责按行填满与重排。
// 同一会话内最多保留 2 本书的运行时缓存（keep-alive）。
window.ReaderApp = (function () {
  'use strict';

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
  let progressSaveTimer = null;
  const PROGRESS_SAVE_DELAY = 1200; // 翻页停下这么久后才真正写一次，合并快速翻页的连续写入
  let resizeTimer = null;
  let suppressZoneClick = 0; // 滑动翻页后短暂吞掉热区补发的 click，避免一次滑动翻两页/误切工具栏

  // state: { bookId, info, kind, contentNode, toc, tocEntries,
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
    const guardZone = handler => () => { if (Date.now() < suppressZoneClick) return; handler(); };
    els.prevZone && (els.prevZone.onclick = guardZone(previous));
    els.centerZone && (els.centerZone.onclick = guardZone(toggleTools));
    els.nextZone && (els.nextZone.onclick = guardZone(next));
    bindSwipe();
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

  // 左右滑动翻页（无动画，直接跳页）。横向位移够大且明显大于纵向才算翻页，
  // 否则当作点击/纵向手势放行。左滑=下一页，右滑=上一页，与点击热区方向一致。
  function bindSwipe() {
    if (!els.viewport) return;
    let startX = 0, startY = 0, tracking = false;
    els.viewport.addEventListener('touchstart', event => {
      tracking = event.touches.length === 1;
      if (tracking) { startX = event.touches[0].clientX; startY = event.touches[0].clientY; }
    }, { passive: true });
    els.viewport.addEventListener('touchend', event => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.5) return; // 位移太小或偏纵向：不是翻页
      suppressZoneClick = Date.now() + 500;
      if (dx < 0) next(); else previous();
    }, { passive: true });
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
    runtime.delete(bookId);
    const index = order.indexOf(bookId);
    if (index !== -1) order.splice(index, 1);
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
    const savedProgress = api(`/api/books/${bookId}/progress`)
      .then(response => response.json())
      .catch(() => ({ page: 0, total_pages: null }));

    setLoading('正在读取书籍…');
    // 解析已在服务端完成：EPUB 返回清洗好的正文 HTML + 目录，TXT 返回原文 + 目录偏移。
    const model = await fetchContent(bookId);
    const contentNode = assembleContent(model);
    const state = {
      bookId, info, kind: info.kind, contentNode,
      toc: model.toc || [], tocEntries: [],
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
      const text = model.text || '';
      const toc = (model.toc || []).map((entry, index) => ({ offset: Number(entry.offset) || 0, index }))
        .sort((a, b) => a.offset - b.offset);
      let pos = 0;
      for (const { offset, index } of toc) {
        const at = Math.max(pos, Math.min(text.length, offset));
        if (at > pos) node.appendChild(document.createTextNode(text.slice(pos, at)));
        const anchor = document.createElement('span');
        anchor.className = 'toc-anchor';
        anchor.dataset.toc = String(index);
        node.appendChild(anchor);
        pos = at;
      }
      node.appendChild(document.createTextNode(text.slice(pos)));
      return node;
    }
    const node = document.createElement('div');
    node.className = 'book-content epub';
    node.innerHTML = model.html || '';
    return node;
  }

  async function fetchBookInfo(bookId) {
    const books = await (await api('/api/books')).json();
    return books.find(book => String(book.id) === String(bookId)) || null;
  }

  async function fetchContent(bookId) {
    const response = await api(`/api/books/${bookId}/content`);
    return await response.json();
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
      const byId = Array.from(node.querySelectorAll('[id], [data-frag-ids]')).find(element =>
        element.id === entry.fragment || (element.dataset.fragIds || '').split(' ').includes(entry.fragment));
      if (byId) return byId;
    }
    return Array.from(node.querySelectorAll('[data-source-path]')).find(element => element.dataset.sourcePath === entry.path) || null;
  }

  // 点目录时按“当前已稳定的版面”实时算页码，而不是用 measure() 时预存的值。
  // measure 可能发生在图片/字体尚未加载完之前（手机端尤甚），预存页码会偏前；
  // 这里 target 与 baseLeft 同受 translateX 平移，相减后与当前翻页位置无关，结果精确。
  function tocTargetPage(state, entry, index) {
    const target = findTocTarget(state, entry, index);
    if (!target) return Math.max(0, entry.page || 0);
    const baseLeft = state.contentNode.getBoundingClientRect().left;
    const page = Math.round((target.getBoundingClientRect().left - baseLeft) / state.pageStep);
    return Math.min(Math.max(0, page), Math.max(0, state.pageCount - 1));
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
      const index = Number(button.dataset.tocIndex);
      const entry = active.tocEntries[index];
      goToPage(active, tocTargetPage(active, entry, index));
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

  // 翻页时只防抖排期，不立即写；停下 PROGRESS_SAVE_DELAY 后落一次，把连续翻页合并成一次写入。
  function queueProgressSave(page) {
    if (!active) return;
    const bookId = active.bookId;
    const totalPages = active.pageCount;
    if (progressSaveTimer) clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(() => {
      progressSaveTimer = null;
      commitProgressSave(bookId, totalPages, page);
    }, PROGRESS_SAVE_DELAY);
  }

  function commitProgressSave(bookId, totalPages, page) {
    progressSaveChain = progressSaveChain.then(() => api(`/api/books/${bookId}/progress`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page, total_pages: totalPages }), keepalive: true,
    })).catch(error => console.error('保存阅读进度失败', error));
  }

  // 离开页面/切书等场景立即落盘（绕过防抖），确保不丢进度。
  function saveProgress() {
    if (!active) return;
    if (progressSaveTimer) { clearTimeout(progressSaveTimer); progressSaveTimer = null; }
    commitProgressSave(active.bookId, active.pageCount, active.currentPage);
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
