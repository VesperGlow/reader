// Router: 原生 SPA 路由。history.pushState/replaceState + popstate。
// 路由：
//   /              书架
//   /read/:id      阅读器
//   /series/:name  系列详情（书架过滤）
//   /settings      书架 + 设置抽屉
//   /edit          书架 + 编辑模式
// 返回键/ESC 优先级：阅读目录 → 书架抽屉 → 批量/编辑模式 → 阅读页回书架。
window.Router = (function () {
  'use strict';

  let started = false;

  function parse(path) {
    let match;
    if ((match = path.match(/^\/read\/(.+)$/))) return { name: 'reader', id: decodeURIComponent(match[1]) };
    if ((match = path.match(/^\/series\/(.+)$/))) return { name: 'series', series: decodeURIComponent(match[1]) };
    if (path === '/settings') return { name: 'settings' };
    if (path === '/edit') return { name: 'edit' };
    return { name: 'shelf' };
  }

  function navigate(path, options = {}) {
    const depth = (history.state?.depth || 0) + (options.replace ? 0 : 1);
    const state = { route: path, depth };
    if (options.replace) history.replaceState(state, '', path);
    else history.pushState(state, '', path);
    render(parse(path), state);
  }

  function back() {
    if ((history.state?.depth || 0) > 0) history.back();
    else navigate('/', { replace: true });
  }

  function render(route, state) {
    if (route.name === 'reader') {
      window.Shelf.hide();
      window.ReaderApp.openBook(route.id, { book: window.Shelf.getBook(route.id), onExit: back });
    } else {
      window.ReaderApp.hide();
      window.Shelf.show();
      window.Shelf.applyRoute(route);
    }
  }

  function isReaderRoute() { return parse(location.pathname).name === 'reader'; }

  function onPopstate(event) {
    const state = event.state || { route: location.pathname, depth: 0 };
    if (window.ReaderApp.isTocOpen() && !state.tocDrawer) { window.ReaderApp.closeToc(true); return; }
    if (window.Shelf.isDrawerOpen() && !state.shelfDrawer) { window.Shelf.closeDrawer(true); return; }
    if (window.Shelf.isManaging() && !state.manage) { window.Shelf.stopManagement(true); return; }
    render(parse(state.route || location.pathname), state);
  }

  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (window.Shelf.isEditorOpen()) return; // <dialog> 自行处理 ESC
    if (window.ReaderApp.isTocOpen()) { window.ReaderApp.closeToc(); return; }
    if (window.Shelf.isDrawerOpen()) { window.Shelf.closeDrawer(); return; }
    if (window.Shelf.isManaging()) { window.Shelf.stopManagement(); return; }
    if (isReaderRoute()) back();
  }

  async function start() {
    if (started) return;
    started = true;
    const authed = await window.Shelf.mount();
    if (!authed) return; // 登录页：路由暂不接管
    window.ReaderApp.init(document.querySelector('#reader-view'));
    const path = location.pathname;
    history.replaceState({ route: path, depth: 0 }, '', path);
    render(parse(path), history.state);
    window.addEventListener('popstate', onPopstate);
    document.addEventListener('keydown', onKeydown);
  }

  return { navigate, back, start, parse };
})();

window.Router.start();
