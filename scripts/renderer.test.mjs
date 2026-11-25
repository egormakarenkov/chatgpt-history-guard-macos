import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const script = readFileSync(new URL('../guard/history-guard.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../guard/history-guard.css', import.meta.url), 'utf8');
const old = '11111111-1111-4111-8111-111111111111';
const fresh = '22222222-2222-4222-8222-222222222222';
const ready = (allowedIds = [], accountScope = 'account-a') => ({ status: 'ready', accountScope, allowedIds, reason: null });

async function fixture({ snapshot = ready(), route = '/', missing = false, throws = false, subscribeThrows = false, earlyBody = false, stored = [], markup = '' } = {}) {
  const dom = new JSDOM(`<html class="personal-history-guard-starting"><head><style>${css}</style></head><body><div id="root"><nav>${markup}</nav><main>Private conversation content</main><form><button type="submit">Send</button></form><button id="new-chat">New chat</button></div></body></html>`, {
    url: `https://app.invalid/index.html?initialRoute=${encodeURIComponent(route)}`, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  let current = snapshot;
  const subscribers = new Set();
  // JSDOM close removes document nodes without a browser pagehide lifecycle.
  // Keep real observers, but disconnect them before that test-only teardown.
  const observers = [];
  const RealObserver = dom.window.MutationObserver;
  dom.window.MutationObserver = class extends RealObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  if (!missing) Object.defineProperty(dom.window, 'personalHistoryGuard', { value: Object.freeze({ version: 2, getSnapshot() { if (throws) throw Error('Host unavailable'); return current; }, subscribe(callback) { if (subscribeThrows) throw Error('IPC unavailable'); subscribers.add(callback); return () => subscribers.delete(callback); } }), configurable: false });
  dom.window.localStorage.setItem('personal-history-guard-allowed-cloud-chats-v1', JSON.stringify(stored));
  const before = dom.window.getComputedStyle(dom.window.document.querySelector('#root')).visibility;
  const body = dom.window.document.body;
  if (earlyBody) body.remove();
  dom.window.eval(script);
  if (earlyBody) {
    dom.window.document.documentElement.append(body);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  }
  const flush = () => new Promise(resolve => dom.window.setTimeout(resolve, 50));
  await flush();
  return { window: dom.window, document: dom.window.document, before, flush, update(value) { current = value; for (const callback of subscribers) callback(value); }, close() { for (const observer of observers) observer.disconnect(); dom.window.close(); } };
}
const blocked = f => f.document.documentElement.classList.contains('personal-history-guard-blocked');

test('sending on home never authorizes an old conversation', async t => {
  const f = await fixture(); t.after(f.close);
  f.document.querySelector('form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(f.window.__personalHistoryGuardOnConversation(old), true);
  assert.equal(blocked(f), true);
  f.document.querySelector('#new-chat').click();
  assert.equal(blocked(f), false);
  assert.equal(f.window.__personalHistoryGuardOnConversation(old), true);
});

test('host approvals show content but hostile localStorage does not', async t => {
  const f = await fixture({ snapshot: ready([fresh]), stored: [old], route: `/c/${old}` }); t.after(f.close);
  assert.equal(blocked(f), true);
  assert.equal(f.window.__personalHistoryGuardOnConversation(fresh), false);
  assert.equal(blocked(f), false);
  assert.equal(f.window.getComputedStyle(f.document.querySelector('main')).visibility, 'visible');
});

test('account switch immediately blocks previous approval and hides its preview', async t => {
  const f = await fixture({ snapshot: ready([fresh]), route: `/c/${fresh}`, markup: `<li id="preview"><a href="/c/${fresh}">Secret title</a><span>Secret preview</span></li><a id="local" href="/local/work">Local Codex</a>` }); t.after(f.close);
  assert.equal(blocked(f), false);
  f.update(ready([], 'account-b')); await f.flush();
  assert.equal(blocked(f), true);
  assert.equal(f.window.getComputedStyle(f.document.querySelector('#preview')).display, 'none');
  assert.notEqual(f.window.getComputedStyle(f.document.querySelector('#local')).display, 'none');
});

for (const config of [{ missing: true }, { throws: true }, { subscribeThrows: true }, { snapshot: {} }, { snapshot: ready(['opaque']) }, { snapshot: { status: 'ready', accountScope: null, allowedIds: [fresh], reason: null } }]) {
  test(`invalid bridge fails closed: ${JSON.stringify(config)}`, async t => {
    const f = await fixture({ ...config, route: `/c/${fresh}` }); t.after(f.close);
    assert.equal(f.window.__personalHistoryGuardOnConversation(fresh), true);
    assert.equal(blocked(f), true);
    assert.match(f.document.querySelector('#personal-history-guard-overlay').textContent, /protection unavailable/i);
  });
}

for (const route of ['/c/opaque-id', '/g/project/c/opaque-id', '/g/project/shared/c/opaque-id', '/share/opaque-id', `/share/${fresh}`]) {
  test(`cloud initial route blocks ${route}`, async t => {
    const f = await fixture({ route, snapshot: ready([fresh]) }); t.after(f.close);
    assert.equal(blocked(f), true);
  });
}

test('local routes stay visible even with unavailable bridge', async t => {
  const f = await fixture({ route: '/local/c/opaque', missing: true }); t.after(f.close);
  assert.equal(blocked(f), false);
  assert.equal(f.window.__personalHistoryGuardOnConversation(null), false);
  assert.equal(f.window.getComputedStyle(f.document.querySelector('#root')).visibility, 'visible');
});

test('startup hides content until the guard validates its snapshot', async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal(f.before, 'hidden');
  assert.equal(f.document.documentElement.classList.contains('personal-history-guard-starting'), false);
});

test('renderer cannot replace the route guard', async t => {
  const f = await fixture(); t.after(f.close);
  const guard = f.window.__personalHistoryGuardOnConversation;
  assert.equal(Reflect.set(f.window, '__personalHistoryGuardOnConversation', () => false), false);
  assert.equal(Reflect.deleteProperty(f.window, '__personalHistoryGuardOnConversation'), false);
  assert.equal(f.window.__personalHistoryGuardOnConversation, guard);
  assert.equal(guard(old), true);
});

test('history aggregates and blocked preview rows are hidden; local navigation stays visible', async t => {
  const f = await fixture({ markup: `<li id="old-row"><a id="old" href="/c/${old}">Old title</a><span>Private preview</span></li><a id="projects" href="/g/project">Projects</a><button id="search" aria-label="Search chats">Search</button><a id="library" href="/library">Library</a><a id="local" href="/local/work">Local Codex</a>` }); t.after(f.close);
  for (const id of ['old-row', 'projects', 'search', 'library']) assert.equal(f.window.getComputedStyle(f.document.getElementById(id)).display, 'none', id);
  assert.notEqual(f.window.getComputedStyle(f.document.getElementById('local')).display, 'none');
  const event = new f.window.MouseEvent('click', { bubbles: true, cancelable: true });
  f.document.getElementById('old').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
});

test('guard installed before body insertion blocks cloud content when body arrives', async t => {
  const f = await fixture({ earlyBody: true, route: `/c/${old}` }); t.after(f.close);
  assert.equal(blocked(f), true);
  assert.ok(f.document.querySelector('#personal-history-guard-overlay'));
  assert.equal(f.window.getComputedStyle(f.document.querySelector('main')).visibility, 'hidden');
});

test('live malformed snapshot revokes visible cloud content immediately', async t => {
  const f = await fixture({ route: `/c/${fresh}`, snapshot: ready([fresh]) }); t.after(f.close);
  assert.equal(blocked(f), false);
  f.update({ status: 'ready', accountScope: 'account-a', allowedIds: null, reason: null });
  assert.equal(blocked(f), true);
  assert.equal(f.window.getComputedStyle(f.document.querySelector('main')).visibility, 'hidden');
});

test('changed and newly inserted cloud links are hidden by real DOM observation', async t => {
  const f = await fixture({ markup: '<a id="entry" href="/local/work">Local Codex</a>' }); t.after(f.close);
  const entry = f.document.getElementById('entry');
  assert.notEqual(f.window.getComputedStyle(entry).display, 'none');
  entry.href = `/c/${old}`;
  const row = f.document.createElement('li');
  row.innerHTML = '<a href="/share/opaque">Shared secret</a><span>Shared preview</span>';
  f.document.querySelector('nav').append(row);
  await f.flush();
  assert.equal(f.window.getComputedStyle(entry).display, 'none');
  assert.equal(f.window.getComputedStyle(row).display, 'none');
});

test('history navigation rechecks routes synchronously and allows local return', async t => {
  const f = await fixture(); t.after(f.close);
  f.window.history.pushState(null, '', `/g/project/c/${old}`);
  assert.equal(blocked(f), true);
  f.window.history.replaceState(null, '', '/local/work');
  assert.equal(blocked(f), false);
  assert.equal(f.window.__personalHistoryGuardOnConversation(undefined), true);
});
