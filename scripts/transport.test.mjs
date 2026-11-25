import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const runtimePath = '../guard/main.cjs';
let createTransport;
try { ({ createTransport } = require(runtimePath)); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const { HistoryPolicy } = require('../guard/policy.cjs');
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function setup(t) {
  assert.equal(typeof createTransport, 'function', 'host transport protection is missing');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-transport-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policy = new HistoryPolicy({ filePath: path.join(directory, 'policy.json') });
  const auth = { principal: { accountId: 'account-one', userId: 'user-one', expiresAtMs: Date.now() + 60000 }, signal: new AbortController().signal };
  return { policy, auth, protect: createTransport({ policy }) };
}
function request(route, body, method = 'POST') { return { resolvedUrl: `https://chatgpt.com/backend-api${route}`, method, body: body === undefined ? undefined : JSON.stringify(body), headers: {}, signal: new AbortController().signal }; }
function result(response, signal = new AbortController().signal) { return { response, metrics: { attachAuth: true, hasToken: true, timings: {} }, signal, workspaceIpAuthorizationError: null }; }
function streamed(parts) { return new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }); }

test('old conversation is rejected before the real transport runs', async t => {
  const { protect, auth } = setup(t); let calls = 0;
  const response = await protect(request(`/conversation/${OLD}`, undefined, 'GET'), async () => { calls++; return result(new Response('private')); }, async () => auth);
  assert.equal(calls, 0); assert.equal(response.response.status, 403); assert.doesNotMatch(await response.response.text(), /private/);
});
test('new creation is approved from an SSE response before the consumer receives its ID', async t => {
  const { protect, auth, policy } = setup(t);
  const body = `data: {"conversation_id":"${ID}"}\n\ndata: [DONE]\n\n`;
  const response = await protect(request('/f/conversation', { messages: [] }), async () => result(streamed([body.slice(0, 21), body.slice(21)])), async () => auth);
  assert.equal(policy.snapshot().allowedIds.length, 0);
  const reader = response.response.body.getReader(); let received = '';
  while (true) { const item = await reader.read(); if (item.done) break; received += new TextDecoder().decode(item.value); if (received.includes(ID)) assert.deepEqual(policy.snapshot().allowedIds, [ID]); }
  assert.equal(received, body);
});
test('delta SSE conversation metadata also enrolls only the actual server ID', async t => {
  const { protect, auth, policy } = setup(t);
  const response = await protect(request('/f/conversation', { messages: [] }), async () => result(streamed([`event: delta_encoding\ndata: "v1"\n\nevent: delta\ndata: {"p":"","o":"add","v":{"conversation_id":"${ID}"}}\n\n`])), async () => auth);
  await response.response.text(); assert.deepEqual(policy.snapshot().allowedIds, [ID]);
});
test('preflight metadata never enrolls conversation IDs', async t => {
  const { protect, auth, policy } = setup(t);
  const response = await protect(request('/conversation/init', {}), async () => result(Response.json({ conversation_id: OLD })), async () => auth);
  await response.response.text(); assert.deepEqual(policy.snapshot().allowedIds, []);
});
test('failed creation and missing identity cannot approve or expose old data', async t => {
  const { protect, auth, policy } = setup(t);
  await protect(request('/f/conversation', {}), async () => result(Response.json({ conversation_id: OLD }, { status: 500 })), async () => auth);
  assert.deepEqual(policy.snapshot().allowedIds, []);
  let called = false;
  const blocked = await protect(request('/f/conversation', {}), async () => { called = true; return result(new Response('secret')); }, async () => ({ principal: null }));
  assert.equal(blocked.response.status, 403); assert.equal(called, false);
});
test('account change aborts a pending stream and never transfers approvals', async t => {
  const { protect, auth, policy } = setup(t); const controller = new AbortController(); auth.signal = controller.signal;
  const response = await protect(request('/f/conversation', {}), async () => result(streamed([`data: {"conversation_id":"${ID}"}\n\n`])), async () => auth);
  controller.abort(); await assert.rejects(response.response.text()); assert.deepEqual(policy.snapshot().allowedIds, []);
});
test('expired identity and renderer-supplied Authorization are rejected', async t => {
  const { protect, auth } = setup(t); let calls = 0;
  const send = async () => { calls++; return result(new Response('secret')); };
  const expired = await protect(request('/f/conversation', {}), send, async () => ({ ...auth, principal: { ...auth.principal, expiresAtMs: 1 } }));
  assert.equal(expired.response.status, 403);
  const req = request('/f/conversation', {}); req.headers.Authorization = 'Bearer renderer-controlled-token';
  const spoofed = await protect(req, send, async () => auth); assert.equal(spoofed.response.status, 403); assert.equal(calls, 0);
});
test('Codex requests preserve their response and never depend on ChatGPT identity', async t => {
  const { protect } = setup(t); const original = result(Response.json({ threads: ['local'] }));
  const response = await protect(request('/codex/threads', undefined, 'GET'), async () => original, async () => { throw Error('must not fetch auth'); });
  assert.equal(response, original); assert.deepEqual(await response.response.json(), { threads: ['local'] });
});
test('creation stream without a recognized ID fails closed and oversized SSE is bounded', async t => {
  const { protect, auth, policy } = setup(t);
  for (const body of ['data: {"message":"missing id"}\n\n', 'data: ' + 'x'.repeat(1024 * 1024 + 1)]) {
    const response = await protect(request('/f/conversation', {}), async () => result(streamed([body])), async () => auth);
    await assert.rejects(response.response.text()); assert.deepEqual(policy.snapshot().allowedIds, []);
  }
});
test('SSE CRLF split between byte chunks still verifies the new conversation', async t => {
  const { protect, auth, policy } = setup(t);
  const text = `data: {"conversation_id":"${ID}"}\r\n\r\n`;
  const response = await protect(request('/f/conversation', {}), async () => result(streamed([...text])), async () => auth);
  assert.equal(await response.response.text(), text); assert.deepEqual(policy.snapshot().allowedIds, [ID]);
});
test('owner revocation stops a previously approved response stream', async t => {
  const { protect, auth, policy } = setup(t); policy.setPrincipal(auth.principal);
  const tx = policy.begin({ url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', body: {} });
  policy.acceptCreated(tx, ID); policy.configureOwner('long-owner-password');
  let controller;
  const response = await protect(request(`/conversation/${ID}`, undefined, 'GET'), async () => result(new Response(new ReadableStream({ start(c) { controller = c; } }))), async () => auth);
  const consuming = response.response.text(); policy.reset('long-owner-password'); controller.enqueue(new TextEncoder().encode('revoked content')); controller.close();
  await assert.rejects(consuming);
});
test('non-conversation endpoints cannot smuggle old conversation IDs in request bodies', async t => {
  const { protect, auth } = setup(t); let called = false;
  const response = await protect(request('/unrecognized/chat-operation', { nested: { conversation_id: OLD } }), async () => { called = true; return result(new Response('old data')); }, async () => auth);
  assert.equal(response.response.status, 403); assert.equal(called, false);
});
test('the packaged global search endpoint cannot return cloud conversation results', async t => {
  const { protect, auth } = setup(t); let called = false;
  const response = await protect(request('/global/search', { query: 'private', source_requests: [{ type: 'conversation', filters: {}, include_files: false }] }), async () => { called = true; return result(Response.json({ title: 'private cloud title' })); }, async () => auth);
  assert.equal(response.response.status, 403); assert.equal(called, false);
});

test('actual cloud library endpoints are blocked before transport', async t => {
  const { protect, auth } = setup(t);
  for (const route of ['/files/library', '/files/library/mounted/search', '/files/manage_library']) {
    let called = false;
    const response = await protect(request(route, {}), async () => { called = true; return result(new Response('private file')); }, async () => auth);
    assert.equal(response.response.status, 403); assert.equal(called, false);
  }
});

test('normal account bootstrap restores persisted approvals from trusted host identity', async t => {
  const { protect, auth, policy } = setup(t);
  policy.setPrincipal(auth.principal);
  const transaction = policy.begin({url:'https://chatgpt.com/backend-api/f/conversation', method:'POST', body:{}});
  policy.acceptCreated(transaction, ID); policy.setPrincipal(null);
  const original = result(Response.json({ user: 'bootstrap' }));
  assert.equal(await protect(request('/me', undefined, 'GET'), async () => original, async () => auth), original);
  assert.deepEqual(policy.snapshot().allowedIds, [ID]);
  auth.signal.dispatchEvent(new Event('abort'));
  assert.equal(policy.snapshot().status, 'locked');
});
