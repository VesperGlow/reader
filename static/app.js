// Shelf: 书架视图控制器。暴露 window.Shelf 供 router 调用。
// 主要状态：书单、过滤器、系列视图、批量管理/编辑模式、抽屉、封面缓存。
window.Shelf = (function () {
  'use strict';

  const $ = selector => document.querySelector(selector);

  let allBooks = [];
  let activeFilter = 'all';
  let activeSeries = null;
  let coverObserver;
  let coverQueue = Promise.resolve();
  let managementMode = null;
  const selectedIds = new Set();
  const coverUrls = new Set();
  const coverBlobs = new Map();
  const missingCovers = new Set();

  async function api(url, options = {}) {
    const response = await fetch(url, options);
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
    if (!response.ok) throw new Error(data?.message || '请求失败');
    return data;
  }

  // 鉴权 + 首次加载。返回 true 表示已登录、书架就绪；false 表示展示登录页。
  async function mount() {
    bindEvents();
    try {
      const user = await api('/api/me');
      $('#welcome').textContent = user.username;
      $('#shelf-view').classList.remove('hidden');
      let compact = false;
      try { compact = localStorage.getItem('reader-compact-shelf') === 'true'; } catch (_) {}
      $('#compact-shelf').checked = compact;
      $('#shelf-view').classList.toggle('compact-shelf', compact);
      await loadBooks();
      return true;
    } catch {
      $('#auth').classList.remove('hidden');
      return false;
    }
  }

  function show() { $('#shelf-view').classList.remove('hidden'); }
  function hide() { $('#shelf-view').classList.add('hidden'); }
  function getBook(id) { return allBooks.find(book => String(book.id) === String(id)) || null; }

  // 根据路由设置书架子状态。
  function applyRoute(route) {
    if (route.name === 'series') {
      activeSeries = route.series;
    } else {
      activeSeries = null;
      if (managementMode) stopManagement(true);
      if (isDrawerOpen()) closeDrawer(true);
    }
    renderBooks();
    if (route.name === 'settings') { openDrawer(false); $('#settings-panel').classList.remove('hidden'); }
    if (route.name === 'edit' && managementMode !== 'edit') startManagement('edit', false);
  }

  async function loadBooks() {
    allBooks = await api('/api/books');
    $('#book-count').textContent = `${allBooks.length} 本`;
    $('#count-all').textContent = allBooks.length;
    $('#count-epub').textContent = allBooks.filter(book => book.kind === 'epub').length;
    $('#count-txt').textContent = allBooks.filter(book => book.kind === 'txt').length;
    $('#count-recent').textContent = recentBooks(allBooks).length;
    renderBooks();
  }

  function renderBooks() {
    const query = $('#book-search').value.trim().toLocaleLowerCase();
    let books = activeFilter === 'all' ? allBooks : activeFilter === 'recent' ? recentBooks(allBooks) : allBooks.filter(book => book.kind === activeFilter);
    if (activeSeries) books = books.filter(book => normalizeSeries(book.series_name) === normalizeSeries(activeSeries));
    if (query) books = books.filter(book => [book.title, book.author, book.series_name].some(value => value?.toLocaleLowerCase().includes(query)));
    if (activeSeries) books.sort(compareSeriesOrder);

    const hasBooks = allBooks.length > 0;
    const items = activeSeries ? books.map(book => ({ type: 'book', book })) : groupShelfBooks(books);
    $('#empty').classList.toggle('hidden', hasBooks);
    $('#no-results').classList.toggle('hidden', !hasBooks || items.length > 0);
    $('#visible-count').textContent = items.length ? `${books.length} 本` : '';
    $('#series-back').classList.toggle('hidden', !activeSeries);
    $('.shelf-wrap').classList.toggle('series-view', Boolean(activeSeries));
    $('#shelf-title').textContent = activeSeries || shelfTitle();
    $('#books').innerHTML = items.map((item, index) => item.type === 'series' ? renderSeriesCard(item, index) : renderBookCard(item.book, index)).join('');
    bindRenderedCards();
    observeCovers();
  }

  function groupShelfBooks(books) {
    const grouped = new Map();
    for (const book of books) {
      const key = normalizeSeries(book.series_name);
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(book);
    }
    const emitted = new Set();
    const items = [];
    for (const book of books) {
      const key = normalizeSeries(book.series_name);
      const group = key ? grouped.get(key) : null;
      if (group?.length > 1) {
        if (!emitted.has(key)) {
          emitted.add(key);
          group.sort(compareSeriesOrder);
          items.push({ type: 'series', name: group[0].series_name.trim(), books: group });
        }
      } else {
        items.push({ type: 'book', book });
      }
    }
    return items;
  }

  function renderBookCard(book, index) {
    const selectable = managementMode ? ' selectable' : '';
    const selected = selectedIds.has(book.id) ? ' selected' : '';
    return `<article class="book-card${selectable}${selected}" data-book-card="${book.id}">
      <button class="book-cover" data-open="${book.id}" style="--cover-color:${coverColor(index, book.id)}" aria-label="阅读《${escapeAttribute(book.title)}》">
        <span class="cover-fallback"><span class="book-type">${book.kind.toUpperCase()}</span><strong>${escapeHtml(book.title)}</strong></span>
        ${book.kind === 'epub' ? coverImage(book) : ''}
      </button>
      <div class="book-info"><strong title="${escapeAttribute(book.title)}">${escapeHtml(book.title)}</strong><div class="book-meta"><small>${progressLabel(book)}</small><button class="delete-book" data-delete="${book.id}" title="删除《${escapeAttribute(book.title)}》">×</button></div></div>
    </article>`;
  }

  function renderSeriesCard(group, index) {
    const representative = group.books.find(book => book.kind === 'epub') || group.books[0];
    const ids = group.books.map(book => book.id).join(',');
    const selected = group.books.every(book => selectedIds.has(book.id)) ? ' selected' : '';
    return `<article class="book-card series-card${managementMode ? ' selectable' : ''}${selected}" data-series-card="${escapeAttribute(group.name)}" data-select-ids="${ids}">
      <button class="book-cover" style="--cover-color:${coverColor(index, representative.id)}" aria-label="打开系列《${escapeAttribute(group.name)}》">
        <span class="series-stack"><span class="stack-sheet" style="--stack-color:${coverColor(index + 2, representative.id)}"></span><span class="stack-sheet" style="--stack-color:${coverColor(index + 1, representative.id)}"></span>
          <span class="cover-fallback"><span class="book-type">系列</span><strong>${escapeHtml(group.name)}</strong></span>
          ${representative.kind === 'epub' ? coverImage(representative) : ''}
        </span>
      </button>
      <div class="book-info"><strong title="${escapeAttribute(group.name)}">${escapeHtml(group.name)}</strong><div class="book-meta"><small class="series-count">${group.books.length} 本书</small></div></div>
    </article>`;
  }

  function coverImage(book) {
    return `<img class="embedded-cover" data-cover-id="${book.id}" data-created="${book.updated_at || book.created_at}" alt="" loading="lazy">`;
  }

  function bindRenderedCards() {
    document.querySelectorAll('[data-open]').forEach(element => element.onclick = () => {
      const id = Number(element.dataset.open);
      if (managementMode === 'delete') return toggleSelection([id]);
      if (managementMode === 'edit') return openEditor(id);
      window.Router.navigate(`/read/${id}`);
    });
    document.querySelectorAll('[data-series-card]').forEach(element => element.querySelector('.book-cover').onclick = () => {
      if (managementMode === 'delete') return toggleSelection(element.dataset.selectIds.split(',').map(Number));
      window.Router.navigate(`/series/${encodeURIComponent(element.dataset.seriesCard)}`);
    });
    document.querySelectorAll('[data-delete]').forEach(element => element.onclick = deleteBook);
  }

  function recentBooks(books) {
    if (!books.length) return [];
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const recent = books.filter(book => book.created_at >= cutoff);
    return recent.length ? recent : books.slice(0, Math.min(8, books.length));
  }

  function compareSeriesOrder(left, right) {
    const a = Number.isFinite(left.series_index) ? left.series_index : Number.MAX_SAFE_INTEGER;
    const b = Number.isFinite(right.series_index) ? right.series_index : Number.MAX_SAFE_INTEGER;
    return a - b || left.created_at - right.created_at;
  }

  function normalizeSeries(value) { return value?.trim().toLocaleLowerCase() || ''; }
  function progressLabel(book) { return book.reading_progress == null ? '未读过' : `${Math.max(0, Math.min(100, book.reading_progress))}%`; }
  function shelfTitle() { return activeFilter === 'all' ? '书架' : document.querySelector(`[data-filter="${activeFilter}"] span`)?.textContent || '书架'; }

  function leaveSeries() {
    if (!activeSeries) return;
    window.Router.back();
  }

  async function deleteBook(event) {
    event.stopPropagation();
    const id = Number(event.currentTarget.dataset.delete);
    if (!confirm('从书架删除这本书？')) return;
    try {
      await removeBooks([id]);
      await loadBooks();
    } catch (error) { toast(error.message); }
  }

  async function removeBooks(ids) {
    for (const id of ids) {
      await api(`/api/books/${id}`, { method: 'DELETE' });
      window.ReaderApp?.destroyBook(id);
      await clearCoverCache(id);
    }
  }

  async function clearCoverCache(id) {
    if (!('caches' in window)) return;
    try {
      const cache = await caches.open('reader-covers-v1');
      for (const key of await cache.keys()) if (key.url.includes(`/cover-cache/${id}/`)) await cache.delete(key);
    } catch (_) {}
  }

  function observeCovers() {
    coverObserver?.disconnect();
    coverObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        coverObserver.unobserve(entry.target);
        coverQueue = coverQueue.then(() => loadEmbeddedCover(entry.target)).catch(() => {});
      }
    }, { rootMargin: '180px' });
    document.querySelectorAll('[data-cover-id]').forEach(image => coverObserver.observe(image));
  }

  async function loadEmbeddedCover(image) {
    if (!window.JSZip || !image.isConnected) return;
    const cacheKey = `/cover-cache/${image.dataset.coverId}/${image.dataset.created}`;
    if (missingCovers.has(cacheKey)) return;
    let blob = coverBlobs.get(cacheKey);
    if ('caches' in window) {
      try {
        const cached = await (await caches.open('reader-covers-v1')).match(cacheKey);
        if (cached?.status === 204) { missingCovers.add(cacheKey); return; }
        if (cached) blob = await cached.blob();
      } catch (_) {}
    }
    if (!blob) {
      blob = await extractEpubCover(image.dataset.coverId);
      if (!blob) {
        missingCovers.add(cacheKey);
        if ('caches' in window) try { await (await caches.open('reader-covers-v1')).put(cacheKey, new Response(null, { status: 204 })); } catch (_) {}
        return;
      }
      if ('caches' in window) try { await (await caches.open('reader-covers-v1')).put(cacheKey, new Response(blob, { headers: { 'content-type': blob.type } })); } catch (_) {}
    }
    coverBlobs.set(cacheKey, blob);
    const url = URL.createObjectURL(blob);
    coverUrls.add(url);
    image.src = url;
    image.onload = () => image.classList.add('loaded');
  }

  async function extractEpubCover(id) {
    const response = await fetch(`/api/books/${id}/file`);
    if (!response.ok) return null;
    const packageData = await openEpubPackage(await response.arrayBuffer());
    if (!packageData) return null;
    const { zip, opf, opfPath } = packageData;
    const items = localElements(opf, 'item');
    const coverId = localElements(opf, 'meta').find(meta => meta.getAttribute('name') === 'cover')?.getAttribute('content');
    const item = items.find(entry => entry.getAttribute('id') === coverId)
      || items.find(entry => (entry.getAttribute('properties') || '').split(/\s+/).includes('cover-image'))
      || items.find(entry => /(^|[/_.-])cover([/_.-]|$)/i.test(entry.getAttribute('href') || '') && /^image\//.test(entry.getAttribute('media-type') || ''));
    if (!item) return null;
    const path = resolvePath(opfPath, item.getAttribute('href') || '');
    const file = zip.file(path);
    if (!file) return null;
    return new Blob([await file.async('arraybuffer')], { type: item.getAttribute('media-type') || imageMime(path) });
  }

  async function extractEpubMetadata(file) {
    if (!window.JSZip || !file.name.toLocaleLowerCase().endsWith('.epub')) return null;
    try {
      const packageData = await openEpubPackage(await file.arrayBuffer());
      if (!packageData) return null;
      const metas = localElements(packageData.opf, 'meta');
      const author = localElements(packageData.opf, 'creator')[0]?.textContent?.trim() || '';
      let seriesName = metas.find(meta => meta.getAttribute('name') === 'calibre:series')?.getAttribute('content')?.trim() || '';
      let seriesIndex = numberOrNull(metas.find(meta => meta.getAttribute('name') === 'calibre:series_index')?.getAttribute('content'));
      if (!seriesName) {
        const collection = metas.find(meta => meta.getAttribute('property') === 'belongs-to-collection' && meta.textContent.trim());
        if (collection) {
          const id = collection.getAttribute('id');
          const refined = id ? metas.filter(meta => meta.getAttribute('refines') === `#${id}`) : [];
          const type = refined.find(meta => meta.getAttribute('property') === 'collection-type')?.textContent.trim();
          if (!type || type === 'series') {
            seriesName = collection.textContent.trim();
            seriesIndex = numberOrNull(refined.find(meta => meta.getAttribute('property') === 'group-position')?.textContent);
          }
        }
      }
      return { author, series_name: seriesName, series_index: seriesIndex };
    } catch (_) { return null; }
  }

  async function openEpubPackage(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const container = zip.file('META-INF/container.xml');
    if (!container) return null;
    const rootfile = localElements(parseXml(await container.async('string')), 'rootfile')[0];
    if (!rootfile) return null;
    const opfPath = normalizePath(rootfile.getAttribute('full-path'));
    const opfFile = zip.file(opfPath);
    if (!opfFile) return null;
    return { zip, opf: parseXml(await opfFile.async('string')), opfPath };
  }

  function parseXml(text) { return new DOMParser().parseFromString(text, 'application/xml'); }
  function localElements(doc, name) { return Array.from(doc.getElementsByTagName('*')).filter(element => element.localName === name); }
  function resolvePath(baseFile, relative) {
    const clean = decodePath(String(relative).split('#')[0].split('?')[0]);
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
  function decodePath(path) { try { return decodeURIComponent(path); } catch (_) { return path; } }
  function imageMime(path) { const ext = path.split('.').pop().toLowerCase(); return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg'; }
  function numberOrNull(value) { if (value == null || String(value).trim() === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }

  // ---- 抽屉（书架工具） ----
  function openDrawer(push = true) {
    if (isDrawerOpen()) return;
    if (push) history.pushState({ ...history.state, shelfDrawer: true }, '', location.href);
    $('#shelf-drawer').classList.add('open');
    $('#shelf-drawer').setAttribute('aria-hidden', 'false');
    $('#shelf-menu-button').setAttribute('aria-expanded', 'true');
    $('#shelf-scrim').classList.remove('hidden');
    document.body.classList.add('drawer-open');
    setTimeout(() => $('#book-search').focus(), 280);
  }

  function closeDrawer(fromHistory = false) {
    if (!isDrawerOpen()) return;
    if (!fromHistory && history.state?.shelfDrawer) { history.back(); return; }
    $('#shelf-drawer').classList.remove('open');
    $('#shelf-drawer').setAttribute('aria-hidden', 'true');
    $('#shelf-menu-button').setAttribute('aria-expanded', 'false');
    $('#shelf-scrim').classList.add('hidden');
    document.body.classList.remove('drawer-open');
    $('#settings-panel').classList.add('hidden');
  }

  function isDrawerOpen() { return $('#shelf-drawer').classList.contains('open'); }

  function startManagement(mode, push = true) {
    managementMode = mode;
    selectedIds.clear();
    if (push) history.pushState({ ...history.state, manage: true }, '', location.href);
    $('#batch-bar').classList.remove('hidden');
    $('#confirm-delete').classList.toggle('hidden', mode !== 'delete');
    updateSelectionBar();
    closeDrawer(true);
    renderBooks();
  }

  function stopManagement(fromHistory = false) {
    if (!managementMode) return;
    if (!fromHistory && history.state?.manage) { history.back(); return; }
    managementMode = null;
    selectedIds.clear();
    $('#batch-bar').classList.add('hidden');
    renderBooks();
  }

  function isManaging() { return Boolean(managementMode); }
  function isEditorOpen() { return $('#book-editor').open; }

  function toggleSelection(ids) {
    const select = ids.some(id => !selectedIds.has(id));
    ids.forEach(id => select ? selectedIds.add(id) : selectedIds.delete(id));
    updateSelectionBar();
    renderBooks();
  }

  function updateSelectionBar() {
    $('#selected-count').textContent = managementMode === 'edit' ? '点击一本书进行编辑' : `已选择 ${selectedIds.size} 本`;
    $('#confirm-delete').disabled = selectedIds.size === 0;
  }

  function openEditor(id) {
    const book = getBook(id);
    if (!book) return;
    $('#editor-book-id').value = book.id;
    $('#editor-title').value = book.title;
    $('#editor-author').value = book.author || '';
    $('#editor-series').value = book.series_name || '';
    $('#editor-series-index').value = book.series_index ?? '';
    $('#book-editor').showModal();
  }

  async function handleUpload(event) {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    $('#uploading').classList.remove('hidden');
    try {
      const metadataPromise = extractEpubMetadata(file);
      const form = new FormData();
      form.append('book', file);
      const book = await api('/api/books', { method: 'POST', body: form });
      const metadata = await metadataPromise;
      if (metadata && (metadata.author || metadata.series_name)) {
        await api(`/api/books/${book.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata) });
      }
      await loadBooks();
      toast('已放入书架');
      closeDrawer();
    } catch (error) { toast(error.message); }
    finally { $('#uploading').classList.add('hidden'); input.value = ''; }
  }

  function coverColor(index, id) { const colors = ['#704b3b', '#465c54', '#314b64', '#80643b', '#643f4d', '#4f526d']; return colors[(index + id) % colors.length]; }
  function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }
  function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }
  function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.remove('hidden'); setTimeout(() => element.classList.add('hidden'), 2200); }

  // ---- 事件绑定（mount 时一次） ----
  function bindEvents() {
    $('#library-filters').onclick = event => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      activeFilter = button.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button));
      renderBooks();
    };
    $('#book-search').oninput = renderBooks;
    $('#auth-form').onsubmit = async event => {
      event.preventDefault(); $('#auth-error').textContent = '';
      try {
        await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
        location.reload();
      } catch (error) { $('#auth-error').textContent = error.message; }
    };
    $('#file-input').onchange = handleUpload;
    $('#drawer-file-input').onchange = handleUpload;
    $('#logout').onclick = logout;
    $('#drawer-logout').onclick = logout;
    $('#shelf-menu-button').onclick = () => openDrawer();
    $('#shelf-drawer-close').onclick = () => closeDrawer();
    $('#shelf-scrim').onclick = () => closeDrawer();
    $('#series-back').onclick = leaveSeries;
    $('#manage-books').onclick = () => startManagement('delete');
    $('#edit-shelf').onclick = () => startManagement('edit');
    $('#cancel-manage').onclick = () => stopManagement();
    $('#confirm-delete').onclick = async () => {
      if (!selectedIds.size || !confirm(`确认删除选中的 ${selectedIds.size} 本书？`)) return;
      try { await removeBooks([...selectedIds]); stopManagement(); await loadBooks(); toast('已删除'); }
      catch (error) { toast(error.message); await loadBooks(); }
    };
    $('#settings-button').onclick = () => $('#settings-panel').classList.toggle('hidden');
    $('#compact-shelf').onchange = event => {
      try { localStorage.setItem('reader-compact-shelf', event.target.checked); } catch (_) {}
      $('#shelf-view').classList.toggle('compact-shelf', event.target.checked);
    };
    $('#editor-close').onclick = () => $('#book-editor').close();
    $('#book-editor-form').onsubmit = async event => {
      event.preventDefault();
      const id = Number($('#editor-book-id').value);
      const indexValue = $('#editor-series-index').value.trim();
      try {
        await api(`/api/books/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          title: $('#editor-title').value,
          author: $('#editor-author').value,
          series_name: $('#editor-series').value,
          series_index: indexValue ? Number(indexValue) : null,
          clear_series_index: !indexValue,
        }) });
        $('#book-editor').close();
        stopManagement();
        await loadBooks();
        toast('书籍信息已更新');
      } catch (error) { toast(error.message); }
    };
    window.addEventListener('beforeunload', () => coverUrls.forEach(url => URL.revokeObjectURL(url)));
  }

  async function logout() { await api('/api/logout', { method: 'POST' }); location.reload(); }

  return {
    mount, show, hide, getBook, applyRoute, loadBooks,
    isDrawerOpen, closeDrawer, openDrawer,
    isManaging, stopManagement, isEditorOpen,
  };
})();
