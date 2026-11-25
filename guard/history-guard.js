// UI defense in depth. Only the isolated host can approve cloud conversation IDs.
(() => {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const root = document.documentElement;
  const hiddenClasses = ['personal-history-guard-hidden-link', 'personal-history-guard-hidden-control', 'personal-history-guard-hidden-preview'];
  const locked = () => ({ status: 'locked', accountScope: null, allowedIds: [], reason: 'Protection unavailable' });
  let snapshot = locked();
  let bridge;
  let bridgeFailed = false;
  let overlay = null;
  let scheduled = false;
  let observer;

  function route(path) {
    if (typeof path !== 'string') return { type: 'invalid' };
    try { path = decodeURIComponent(path).split(/[?#]/, 1)[0]; } catch (_) { return { type: 'invalid' }; }
    if (/^\/local(?:\/|$)/i.test(path)) return { type: 'local' };
    if (/(?:^|\/)share(?:\/|$)/i.test(path)) return { type: 'shared' };
    const match = path.match(/(?:^|\/)c(?:\/([^/]*))?(?:\/|$)/i);
    if (match) return { type: 'cloud', id: match[1]?.toLowerCase() };
    if (/^\/(?:g|projects?|shared|history|search|library)(?:\/|$)/i.test(path)) return { type: 'aggregate' };
    return { type: 'home' };
  }
  const initial = new URL(location.href).searchParams.get('initialRoute');
  let activeRoute = route(initial ?? (location.pathname.endsWith('/index.html') ? '/' : location.pathname));

  function readSnapshot() {
    try {
      if (bridgeFailed || !bridge || bridge.version !== 2 || typeof bridge.getSnapshot !== 'function' || typeof bridge.subscribe !== 'function') throw Error();
      const value = bridge.getSnapshot();
      if (!value || !['ready', 'locked'].includes(value.status) || !Array.isArray(value.allowedIds) ||
          !value.allowedIds.every(id => typeof id === 'string' && UUID.test(id)) ||
          !(value.reason === null || typeof value.reason === 'string') ||
          !(value.accountScope === null || (typeof value.accountScope === 'string' && value.accountScope.trim())) ||
          (value.status === 'ready' && !value.accountScope)) throw Error();
      snapshot = { status: value.status, accountScope: value.accountScope, allowedIds: value.allowedIds.map(id => id.toLowerCase()), reason: value.reason };
    } catch (_) { snapshot = locked(); }
    return snapshot;
  }

  function denied(target, state) {
    if (target.type === 'local' || target.type === 'home') return false;
    return target.type !== 'cloud' || !UUID.test(target.id || '') || state.status !== 'ready' || !state.allowedIds.includes(target.id);
  }

  function showBlocked() {
    root.classList.add('personal-history-guard-blocked');
    if (!document.body) return;
    const unavailable = snapshot.status !== 'ready';
    if (overlay && overlay.dataset.unavailable === String(unavailable)) return;
    overlay?.remove();
    overlay = document.createElement('div');
    overlay.id = 'personal-history-guard-overlay';
    overlay.dataset.unavailable = String(unavailable);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', unavailable ? 'Protection unavailable' : 'Cloud chat hidden');
    const box = document.createElement('div');
    box.className = 'personal-history-guard-box';
    const title = document.createElement('h2');
    title.textContent = unavailable ? 'Protection unavailable' : 'Cloud chat hidden on this Mac';
    const detail = document.createElement('p');
    detail.textContent = unavailable ? 'Cloud conversations are blocked. Start a new chat or use local Codex.' : 'This conversation remains available on the owner’s other devices.';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Go to new chat';
    button.addEventListener('click', () => { location.href = new URL('./index.html?initialRoute=%2F', location.href).href; });
    box.append(title, detail, button);
    overlay.append(box);
    document.body.append(overlay);
  }

  function clearBlocked() {
    root.classList.remove('personal-history-guard-blocked');
    overlay?.remove();
    overlay = null;
  }

  function linkRoute(link) {
    try {
      const url = new URL(link.getAttribute('href'), location.href);
      // Also hide direct web links that could disclose account history.
      if (url.origin !== location.origin && !/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)$/.test(url.origin)) return { type: 'home' };
      return route(url.searchParams.get('initialRoute') ?? url.pathname);
    } catch (_) { return { type: 'invalid' }; }
  }

  function isAggregateControl(control) {
    if (control instanceof HTMLAnchorElement && linkRoute(control).type === 'local') return false;
    const labels = [control.getAttribute('aria-label'), control.getAttribute('title'), control.textContent];
    return labels.some(label => typeof label === 'string' && /^(?:search(?: chats?| chat history)?|chat history|history|projects?|shared chats?|library)$/i.test(label.trim()));
  }

  function previewContainer(link) {
    const container = link.closest('li, [role="listitem"], [data-testid*="conversation"], [data-testid*="history-item"]') || link.parentElement;
    if (!container || container.matches('nav, aside, body, #root') || container.querySelector('nav, aside')) return link;
    // Do not hide another entry (especially local Codex) with a cloud preview.
    if ([...container.querySelectorAll('a[href]')].some(other => other !== link)) return link;
    return container;
  }

  function tidyNavigation(state) {
    // Recompute from current host state so an account switch also hides old titles.
    for (const element of document.querySelectorAll(hiddenClasses.map(name => `.${name}`).join(','))) {
      element.classList.remove(...hiddenClasses);
    }
    for (const link of document.querySelectorAll('a[href]')) {
      if (denied(linkRoute(link), state)) {
        link.classList.add('personal-history-guard-hidden-link');
        previewContainer(link).classList.add('personal-history-guard-hidden-preview');
      }
    }
    for (const control of document.querySelectorAll('nav button, nav a, aside button, aside a, [role="navigation"] button, [role="navigation"] a')) {
      if (isAggregateControl(control)) control.classList.add('personal-history-guard-hidden-control');
    }
  }

  function observe() {
    observer?.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'aria-label', 'title'] });
  }
  function enforce() {
    scheduled = false;
    observer?.disconnect();
    const state = readSnapshot();
    if (denied(activeRoute, state)) showBlocked(); else clearBlocked();
    tidyNavigation(state);
    root.classList.remove('personal-history-guard-starting');
    observe();
  }
  function scheduleEnforce() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(enforce);
  }

  // Called synchronously before the conversation route can render or fetch.
  Object.defineProperty(window, '__personalHistoryGuardOnConversation', {
    configurable: false, writable: false,
    value(rawId) {
      activeRoute = rawId === null ? { type: 'home' } : typeof rawId === 'string' ? { type: 'cloud', id: rawId.toLowerCase() } : { type: 'invalid' };
      const state = readSnapshot();
      const blocked = denied(activeRoute, state);
      observer?.disconnect();
      if (blocked) showBlocked(); else clearBlocked();
      observe();
      scheduleEnforce();
      return blocked;
    },
  });

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const link = target?.closest('a[href]');
    const control = target?.closest('button, a');
    if ((link && denied(linkRoute(link), readSnapshot())) || (control && isAggregateControl(control))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const newChat = [control?.getAttribute('aria-label'), control?.getAttribute('title'), control?.textContent]
      .some(label => typeof label === 'string' && /^new chat$/i.test(label.trim()));
    if (newChat) {
      activeRoute = { type: 'home' };
      clearBlocked();
      scheduleEnforce();
    }
  }, true);

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      if (args[2] != null) {
        const url = new URL(args[2], location.href);
        activeRoute = route(url.searchParams.get('initialRoute') ?? url.pathname);
      }
      enforce();
      return result;
    };
  }
  addEventListener('popstate', () => {
    activeRoute = route(new URL(location.href).searchParams.get('initialRoute') ?? location.pathname);
    enforce();
  });
  addEventListener('hashchange', scheduleEnforce);
  document.addEventListener('DOMContentLoaded', enforce, { once: true });
  observer = new MutationObserver(scheduleEnforce);
  try {
    bridge = window.personalHistoryGuard;
    readSnapshot();
    if (!bridge || bridge.version !== 2 || typeof bridge.subscribe !== 'function' || typeof bridge.subscribe(() => enforce()) !== 'function') throw Error();
  } catch (_) { bridgeFailed = true; snapshot = locked(); }
  enforce();
})();
