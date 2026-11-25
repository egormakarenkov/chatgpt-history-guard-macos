import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const modulePath = require.resolve('../guard/main.cjs');
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function environment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-runtime-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.CODEX_ELECTRON_USER_DATA_PATH; });
  const paths = { appData: dir, userData: dir, sessionData: dir }; const app = new EventEmitter();
  app.getPath = name => paths[name];
  app.setPath = (name, value) => { assert.ok(fs.existsSync(value), 'Electron requires setPath directory to exist'); paths[name] = value; };
  app.whenReady = () => Promise.resolve();
  const ipcMain = new EventEmitter(); const handlers = new Map(); ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  const contents = new Map(); const webContents = { getAllWebContents: () => [...contents.values()], fromId: id => contents.get(id) };
  const callbacks = {}; const session = { defaultSession: { webRequest: { onBeforeRequest(filter, listener) { callbacks.filter = filter; callbacks.listener = listener; } } } };
  let menu; const Menu = { setApplicationMenu(value) { menu = value; } }; const opened = [];
  const shell = { async openExternal(url) { opened.push(url); } };
  delete require.cache[modulePath]; const runtime = require(modulePath);
  const electron = { app, ipcMain, webContents, session, Menu, shell };
  return { ...electron, runtime, paths, callbacks, handlers, contents, opened, getMenu: () => menu };
}
function content(id, url = 'app://-/index.html') {
  const result = new EventEmitter(); result.id = id; result.mainFrame = {}; result.getURL = () => url; result.send = () => {};
  result.setWindowOpenHandler = handler => { result.windowHandler = handler; }; result.closeDevTools = () => { result.devToolsClosed = true; }; return result;
}
test('guard profile and cache directories exist before Electron initialization and survive bootstrap override', async t => {
  const e = environment(t); e.runtime.install(e); await Promise.resolve();
  assert.equal(path.basename(e.paths.userData), 'ChatGPT History Guard v2'); assert.equal(e.paths.sessionData, e.paths.userData);
  assert.equal(process.env.CODEX_ELECTRON_USER_DATA_PATH, e.paths.userData);
});
test('snapshot IPC refuses foreign app origins and iframe senders', t => {
  const e = environment(t); const { policy } = e.runtime.install(e); policy.setPrincipal({ accountId: 'account', userId: 'user' });
  for (const [url, iframe] of [['app://evil/index.html', false], ['app://-/index.html', true], ['https://chatgpt.com', false]]) {
    const sender = content(1, url); const event = { sender, senderFrame: iframe ? {} : sender.mainFrame };
    e.ipcMain.emit('personal-history-guard:v2:snapshot', event); assert.equal(event.returnValue.status, 'locked');
  }
  const sender = content(2); const event = { sender, senderFrame: sender.mainFrame }; e.ipcMain.emit('personal-history-guard:v2:snapshot', event); assert.equal(event.returnValue.status, 'ready');
});
test('direct browser cloud requests are denied even for an approved ID and later listeners retain their filters', async t => {
  const e = environment(t); const { policy } = e.runtime.install(e); await Promise.resolve();
  const sender = content(1); e.contents.set(1, sender); policy.setPrincipal({ accountId: 'a', userId: 'u' });
  const tx = policy.begin({ url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', body: {} }); policy.acceptCreated(tx, ID);
  let observer = 0;
  e.session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://example.com/*'] }, (_details, callback) => { observer++; callback({ cancel: false }); });
  let result; e.callbacks.listener({ webContentsId: 1, url: `https://chatgpt.com/backend-api/conversation/${ID}`, method: 'GET' }, value => { result = value; }); assert.equal(result.cancel, true);
  e.callbacks.listener({ webContentsId: 1, url: 'https://example.com/test', method: 'GET' }, value => { result = value; }); assert.equal(result.cancel, false); assert.equal(observer, 1);
  e.callbacks.listener({ webContentsId: 1, url: 'https://other.example/test', method: 'GET' }, value => { result = value; }); assert.deepEqual(result, {}); assert.equal(observer, 1);
});
test('developer shortcuts, cloud external links and developer menu entries are blocked', async t => {
  const e = environment(t); e.runtime.install(e); const sender = content(1); e.app.emit('web-contents-created', {}, sender);
  let stopped = false; sender.emit('before-input-event', { preventDefault() { stopped = true; } }, { key: 'i', meta: true, alt: true }); assert.equal(stopped, true);
  sender.emit('devtools-opened'); assert.equal(sender.devToolsClosed, true);
  sender.setWindowOpenHandler(() => ({ action: 'allow' })); assert.equal(sender.windowHandler({ url: 'https://chatgpt.com/c/old' }).action, 'deny');
  await assert.rejects(e.shell.openExternal('https://chatgpt.com')); await e.shell.openExternal('https://example.com'); assert.deepEqual(e.opened, ['https://example.com']);
  const item = { role: 'toggleDevTools', visible: true, enabled: true }; const menu = { items: [{ submenu: { items: [item] } }] }; e.Menu.setApplicationMenu(menu); assert.equal(item.enabled, false); assert.equal(item.visible, false); assert.equal(e.getMenu(), menu);
});
test('preload exposes decisions and authenticated revocation, never grants IDs', async () => {
  const { install } = require('../guard/preload.cjs'); const ipc = new EventEmitter(); let bridge;
  ipc.sendSync = () => ({ status: 'locked', accountScope: null, allowedIds: [], reason: 'Unavailable' });
  ipc.invoke = async (channel, value) => channel === 'personal-history-guard:v2:reset' && value === 'owner password';
  install({ contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'personalHistoryGuard'); bridge = value; } }, ipcRenderer: ipc });
  assert.equal(bridge.version, 2); assert.equal(bridge.getSnapshot().status, 'locked'); assert.equal(bridge.grant, undefined); assert.equal(Object.isFrozen(bridge), true);
  let current; const unsubscribe = bridge.subscribe(value => { current = value; }); ipc.emit('personal-history-guard:v2:changed', {}, { status: 'ready' }); assert.equal(current.status, 'ready'); unsubscribe();
  assert.equal(await bridge.resetApprovals('owner password'), true); assert.equal(await bridge.resetApprovals({}), false);
});
