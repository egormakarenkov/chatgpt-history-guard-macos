'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HistoryPolicy } = require(fs.existsSync(path.join(__dirname, 'history-guard-policy.cjs')) ? './history-guard-policy.cjs' : './policy.cjs');
const CHANNEL = 'personal-history-guard:v2';
const LIMIT = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE = /^\/(?:conversation(?:s)?|f\/conversation|share(?:d)?|shared_conversations?|gizmos|projects|search|global\/search|sidebar|library|files\/(?:library|manage_library))(?:\/|$)/i;
let installed;

function cloudOperation(raw) {
  try {
    const url = new URL(raw);
    const route = decodeURIComponent(url.pathname).replace(/^\/(backend-api|api)(?=\/|$)/, '');
    return SENSITIVE.test(route) || /(?:conversation|shared_conversation)_id/i.test(url.search);
  } catch { return true; }
}
function denied(signal) {
  return { response: Response.json({ error: 'Cloud operation restricted by History Guard' }, { status: 403 }), signal: signal || new AbortController().signal, workspaceIpAuthorizationError: null, metrics: { attachAuth: false, hasToken: false, timings: {} } };
}
function serverId(event) {
  if (!event || typeof event !== 'object') return null;
  const candidate = event.conversation_id ?? (event.p === '/conversation_id' ? event.v : null) ??
    (event.p === '' || event.p === undefined ? event.v?.conversation_id : null);
  return typeof candidate === 'string' && UUID.test(candidate) ? candidate.toLowerCase() : null;
}
function inspectRequest(args) {
  if (cloudOperation(args.resolvedUrl)) return true;
  try {
    const url = new URL(args.resolvedUrl);
    if (url.hostname !== 'chatgpt.com' || !/^\/(?:backend-api|api)\//.test(url.pathname) || /^\/(?:backend-api|api)\/codex(?:\/|$)/.test(url.pathname)) return false;
    if (/%|\\|\/\//.test(url.pathname)) return true;
    const body = typeof args.body === 'string' ? args.body : args.body == null ? '' : JSON.stringify(args.body);
    return /conversation_id|shared_conversation_id|new_branch/i.test(body);
  } catch { return true; }
}

function createTransport({ policy, onChange = () => {} }) {
  const observedSignals = new WeakSet();
  function notify() { onChange(policy.snapshot()); }
  function observe(auth) {
    const principal = auth?.principal;
    if (!principal || !Number.isFinite(principal.expiresAtMs) || principal.expiresAtMs <= Date.now() || auth.signal?.aborted) {
      policy.setPrincipal(null); notify(); return false;
    }
    policy.setPrincipal(principal); notify();
    const scope = policy.snapshot().accountScope;
    if (auth.signal && !observedSignals.has(auth.signal)) {
      observedSignals.add(auth.signal);
      auth.signal.addEventListener('abort', () => { if (policy.snapshot().accountScope === scope) { policy.setPrincipal(null); notify(); } }, { once: true });
    }
    return true;
  }
  return async function protect(args, perform, getAuth) {
    // The original authenticated transport handles non-conversation APIs and Codex.
    if (!inspectRequest(args)) {
      // Normal ChatGPT bootstrap traffic also publishes trusted account identity,
      // allowing persisted approvals to become usable before a route is opened.
      const url = new URL(args.resolvedUrl);
      if (url.protocol === 'https:' && url.hostname === 'chatgpt.com' && /^\/(?:backend-api|api)\//.test(url.pathname) && !/^\/(?:backend-api|api)\/codex(?:\/|$)/.test(url.pathname)) {
        try { observe(await getAuth()); } catch { policy.setPrincipal(null); notify(); }
      }
      return perform(args);
    }
    let auth;
    try { auth = await getAuth(); } catch { policy.setPrincipal(null); notify(); return denied(args.signal); }
    const principal = auth?.principal;
    if (!observe(auth)) return denied(args.signal);
    const scope = policy.snapshot().accountScope;
    const headers = new Headers(args.headers || {});
    const bearer = headers.get('authorization');
    if (bearer && (!auth.token || bearer !== `Bearer ${auth.token}`)) return denied(args.signal);
    const requestedAccount = headers.get('chatgpt-account-id');
    if (requestedAccount && requestedAccount !== principal.accountId) return denied(args.signal);
    const transaction = policy.begin({ url: args.resolvedUrl, method: args.method, body: args.body, headers: args.headers });
    if (transaction.kind === 'deny') return denied(args.signal);
    const signals = [args.signal, auth.signal].filter(Boolean);
    const signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
    let approvedId = null;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (Date.now() >= principal.expiresAtMs || policy.snapshot().accountScope !== scope || policy.snapshot().status !== 'ready') throw new Error('History Guard account is unavailable');
      if (approvedId && !policy.snapshot().allowedIds.includes(approvedId)) throw new Error('History Guard approval was revoked');
      if (transaction.kind === 'approved' && policy.begin({ url: args.resolvedUrl, method: args.method, body: args.body }).kind !== 'approved') throw new Error('History Guard approval was revoked');
    };
    assertCurrent();
    const output = await perform({ ...args, signal, redirect: 'error', expectedPrincipal: { accountId: principal.accountId, userId: principal.userId } });
    assertCurrent();
    if (transaction.kind !== 'creation' || !output.response.ok) {
      if (!output.response.body) return output;
      const checked = output.response.body.pipeThrough(new TransformStream({ transform(chunk, controller) { assertCurrent(); controller.enqueue(chunk); } }), { signal });
      return { ...output, signal, response: new Response(checked, { status: output.response.status, statusText: output.response.statusText, headers: output.response.headers }) };
    }
    if (!output.response.body) return denied(signal);
    const accept = event => {
      const id = serverId(event);
      if (!id) return;
      assertCurrent();
      if (approvedId && approvedId !== id) throw new Error('History Guard rejected inconsistent conversation metadata');
      if (!approvedId) {
        if (!policy.acceptCreated(transaction, id)) throw new Error('History Guard could not record the new conversation');
        approvedId = id; notify();
      }
    };
    const type = output.response.headers.get('content-type') || '';
    let stream;
    if (type.includes('text/event-stream')) {
      const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = ''; let processed = 0;
      const processEvents = () => {
        pending = pending.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const payload = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (payload && payload !== '[DONE]') { try { accept(JSON.parse(payload)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; } }
          processed++;
        }
        if (pending.length > LIMIT || (!approvedId && processed > 4096)) throw new Error('History Guard could not verify the creation stream');
      };
      stream = output.response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) { assertCurrent(); pending += decoder.decode(chunk, { stream: true }); processEvents(); controller.enqueue(chunk); },
        flush() { pending += decoder.decode(); processEvents(); if (!approvedId) throw new Error('History Guard did not receive a verified conversation ID'); }
      }), { signal });
    } else if (type.includes('application/json')) {
      const reader = output.response.body.getReader(); const pieces = []; let length = 0;
      try {
        while (true) { assertCurrent(); const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > LIMIT) throw new Error('History Guard creation response is too large'); pieces.push(item.value); }
        const bytes = Buffer.concat(pieces); accept(JSON.parse(bytes.toString('utf8')));
        if (!approvedId) throw new Error('History Guard did not receive a verified conversation ID');
        stream = new Response(bytes).body;
      } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
    } else { await output.response.body.cancel(); return denied(signal); }
    return { ...output, signal, response: new Response(stream, { status: output.response.status, statusText: output.response.statusText, headers: output.response.headers }) };
  };
}

function appDocument(contents) {
  try { const url = new URL(contents.getURL()); return url.protocol === 'app:' && url.hostname === '-' && url.pathname === '/index.html'; } catch { return false; }
}
function cloudNavigation(raw) {
  try { const url = new URL(raw); return (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')) && !/^\/(?:auth|api\/auth)(?:\/|$)/.test(url.pathname); } catch { return false; }
}
function matchesFilter(url, filter) {
  if (!filter?.urls) return true;
  return filter.urls.some(pattern => pattern === '<all_urls>' || new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(url));
}
function install(electron) {
  if (installed) return installed;
  const { app, ipcMain, webContents, session, Menu, shell } = electron;
  // A separate profile avoids inheriting previously cached account history.
  const profile = path.join(app.getPath('appData'), 'ChatGPT History Guard v2');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  process.env.CODEX_ELECTRON_USER_DATA_PATH = profile;
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  const policy = new HistoryPolicy({ filePath: path.join(app.getPath('userData'), 'history-policy-v2.json') });
  const publish = snapshot => { for (const contents of webContents.getAllWebContents()) if (appDocument(contents)) contents.send(`${CHANNEL}:changed`, snapshot); };
  const transport = createTransport({ policy, onChange: publish });
  const senderAllowed = event => appDocument(event.sender) && event.senderFrame === event.sender.mainFrame;
  ipcMain.on(`${CHANNEL}:snapshot`, event => { event.returnValue = senderAllowed(event) ? policy.snapshot() : { status: 'locked', accountScope: null, allowedIds: [], reason: 'History policy unavailable' }; });
  ipcMain.handle(`${CHANNEL}:reset`, (event, password) => { if (!senderAllowed(event)) return false; const changed = policy.reset(password); if (changed) publish(policy.snapshot()); return changed; });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('devtools-opened', () => contents.closeDevTools());
    contents.on('before-input-event', (event, input) => { const key = input.key?.toLowerCase(); if (key === 'f12' || ((input.meta || input.control) && (input.alt || input.shift) && ['i', 'j', 'c'].includes(key))) event.preventDefault(); });
    contents.on('will-navigate', (event, url) => { if (cloudNavigation(url)) event.preventDefault(); });
    const original = contents.setWindowOpenHandler.bind(contents);
    contents.setWindowOpenHandler = handler => original(details => cloudNavigation(details.url) ? { action: 'deny' } : handler(details));
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  const guardedSessions = new WeakSet();
  function guardSession(current) {
    if (guardedSessions.has(current)) return; guardedSessions.add(current);
    const request = current.webRequest; const original = request.onBeforeRequest.bind(request);
    function register(filter, listener) {
      if (typeof filter === 'function' || filter === null) { listener = filter; filter = undefined; }
      original({ urls: ['<all_urls>'] }, (details, callback) => {
        // Cloud conversation traffic must use the authenticated host service,
        // never browser cookies or a renderer-selected authorization header.
        if (details.webContentsId != null && inspectRequest({ resolvedUrl: details.url })) { callback({ cancel: true }); return; }
        if (listener && matchesFilter(details.url, filter)) listener(details, callback); else callback({});
      });
    }
    request.onBeforeRequest = register; register(null);
  }
  app.on('session-created', guardSession);
  app.whenReady().then(() => guardSession(session.defaultSession)).catch(() => { policy.failClosed(); publish(policy.snapshot()); });
  const setMenu = Menu.setApplicationMenu.bind(Menu);
  Menu.setApplicationMenu = menu => {
    function clean(items) { for (const item of items || []) { if (item.role?.toLowerCase() === 'toggledevtools' || /developer tools|toggle devtools|inspect element/i.test(item.label || '')) { item.visible = false; item.enabled = false; } if (item.submenu) clean(item.submenu.items); } }
    clean(menu?.items); return setMenu(menu);
  };
  const openExternal = shell.openExternal.bind(shell);
  shell.openExternal = (url, ...args) => cloudNavigation(url) ? Promise.reject(new Error('Cloud chat navigation restricted by History Guard')) : openExternal(url, ...args);
  installed = { policy, protectFetch: transport }; return installed;
}
function protectFetch(args, perform, getAuth) {
  if (!installed) return Promise.resolve(denied(args.signal));
  return installed.protectFetch(args, perform, getAuth);
}
module.exports = { install, protectFetch, createTransport, cloudOperation, cloudNavigation, matchesFilter };
