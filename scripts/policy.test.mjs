import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let HistoryPolicy;
try { ({ HistoryPolicy } = require('../guard/policy.cjs')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const password = 'owner-only-password';
function fixture(t, options = {}) {
  assert.equal(typeof HistoryPolicy, 'function', 'host policy implementation must exist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'policy.json');
  const policy = new HistoryPolicy({ filePath, ...options });
  policy.setPrincipal({ accountId: 'account-a', userId: 'user-a' });
  return { policy, filePath };
}
const request = (url, method = 'GET', body) => ({ url: `https://chatgpt.com/backend-api${url}`, method, body });
function enroll(policy, id = A) {
  const tx = policy.begin(request('/f/conversation', 'POST', { conversation_id: null, messages: [] }));
  assert.equal(tx.kind, 'creation');
  assert.equal(policy.acceptCreated(tx, id), true);
  return tx;
}
test('new policy denies old IDs and persists only host-confirmed creation', t => {
  const { policy, filePath } = fixture(t);
  assert.equal(policy.begin(request(`/conversation/${A}`)).kind, 'deny');
  const tx = enroll(policy);
  assert.equal(policy.acceptCreated(tx, B), false);
  assert.equal(policy.acceptCreated({ ...tx }, B), false);
  assert.equal(policy.begin(request(`/conversation/${A}`)).kind, 'approved');
  const disk = JSON.parse(fs.readFileSync(filePath));
  assert.equal(disk.version, 2);
  assert.ok(!fs.readFileSync(filePath, 'utf8').includes('user-a'));
  const next = new HistoryPolicy({ filePath });
  next.setPrincipal({ accountId: 'account-a', userId: 'user-a' });
  assert.deepEqual(next.snapshot().allowedIds, [A]);
});
test('scopes include user and account and invalidate in-flight enrollment', t => {
  const { policy } = fixture(t);
  const tx = policy.begin(request('/f/conversation', 'POST', {}));
  const original = policy.snapshot().accountScope;
  policy.setPrincipal({ accountId: 'account-a', userId: 'user-b' });
  assert.notEqual(policy.snapshot().accountScope, original);
  assert.equal(policy.acceptCreated(tx, A), false);
  enroll(policy);
  policy.setPrincipal({ accountId: 'account-b', userId: 'user-b' });
  assert.deepEqual(policy.snapshot().allowedIds, []);
  policy.setPrincipal(null);
  assert.equal(policy.begin(request('/f/conversation', 'POST', {})).kind, 'deny');
});
test('aggregate and unknown sensitive operations cannot bypass by method or encoding', t => {
  const { policy } = fixture(t);
  enroll(policy);
  for (const url of ['/conversations', '/search', '/shared/foo', '/share/foo', '/gizmos', '/projects/x', '/sidebar', '/library', '/conversation/unknown', '/conversation/%252e%252e', '/conversation//'+A, '/%63onversations', '/conversation/'+A+'?conversation_id='+B, '/conversation/'+A+'?id='+B, '/conversation/'+A+'/../'+A]) {
    assert.equal(policy.begin(request(url)).kind, 'deny', url);
  }
  assert.equal(policy.begin(request('/conversation/init', 'POST', {})).kind, 'passthrough');
  assert.equal(policy.begin(request('/f/conversation/prepare', 'POST', {})).kind, 'passthrough');
  assert.equal(policy.begin(request('/conversation', 'POST', {})).kind, 'deny');
  assert.equal(policy.begin(request('/me')).kind, 'passthrough');
  assert.equal(policy.begin(request('/codex/tasks')).kind, 'passthrough');
  assert.equal(policy.begin({ url:'https://evil.test/backend-api/f/conversation', method:'POST', body:{} }).kind, 'deny');
});
test('bundled global search and shared_conversation routes cannot expose cloud history', t => {
  const {policy} = fixture(t);
  assert.equal(policy.begin(request('/global/search','POST',{query:'x',source_requests:[{type:'conversation',filters:{},include_files:false}]})).kind,'deny');
  for(const route of ['/shared_conversation/example','/shared_conversations','/shared_conversations/example']) assert.equal(policy.begin(request(route)).kind,'deny',route);
});
test('bundled file-library operations are restricted without affecting ordinary uploads', t => {
  const {policy} = fixture(t);
  for(const route of ['/files/library','/files/library/recents','/files/library/files','/files/library/mounted/search','/files/manage_library']) {
    assert.equal(policy.begin(request(route)).kind,'deny',route);
    assert.equal(policy.begin(request(route,'POST',{})).kind,'deny',route);
  }
  assert.equal(policy.begin(request('/files','POST',Buffer.from([1,2]))).kind,'passthrough');
});
test('owned conversation pagination permits only exact bundled read routes', t => {
  const {policy} = fixture(t);
  enroll(policy);
  for(const route of [`/conversations/${A}`,`/conversations/${A}/messages`,`/conversations/${A}/messages?before=next-page&num_turns=20&include_has_versions=true`]) assert.equal(policy.begin(request(route)).kind,'approved',route);
  for(const route of [`/conversations/${B}/messages`,`/conversations/${A}/unknown`,`/conversations/${A}/messages/unknown`, '/conversations/search','/conversations/batch',`/conversations/${A}/messages?conversation_id=${B}`,`/conversations/${A}/messages?query=old-history`,`/conversations/${A}/messages?num_turns=5&num_turns=6`,`/conversations/${A}/messages?num_turns=garbage`]) assert.equal(policy.begin(request(route)).kind,'deny',route);
  assert.equal(policy.begin(request(`/conversations/${A}/messages`,'POST',{})).kind,'deny');
});
test('nested IDs, malformed bodies, branch flags and stream resumes require approval', t => {
  const { policy } = fixture(t);
  enroll(policy);
  for (const body of ['{broken', {conversation_id:B}, { nested: {shared_conversation_id:B}}, {conversation_id:'bad'}, {new_branch:true}, {conversation_id:A,new_branch:true}, {conversation_id:null, nested:{conversation_id:null}}, []]) {
    assert.equal(policy.begin(request('/f/conversation','POST',body)).kind, 'deny', JSON.stringify(body));
  }
  assert.equal(policy.begin(request('/f/conversation','POST',JSON.stringify({conversation_id:A}))).kind,'approved');
  assert.equal(policy.begin(request('/f/conversation','POST',{conversation_id:null})).kind,'creation');
  assert.equal(policy.begin(request(`/conversation/${A}`,'DELETE')).kind,'approved');
  assert.equal(policy.begin(request('/unknown','POST',{nested:{conversation_id:B}})).kind,'deny');
  assert.equal(policy.begin(request('/unknown','POST',{conversation_id:A})).kind,'deny');
  assert.equal(policy.begin(request('/codex/tasks','POST',{conversation_id:'local-task'})).kind,'passthrough');
});
test('owner reset uses password, throttles failures and revokes all scopes and transactions', t => {
  let now = 100;
  const { policy, filePath } = fixture(t, { clock: () => now });
  assert.equal(policy.configureOwner('short'), false);
  assert.equal(policy.configureOwner(password), true);
  assert.equal(policy.configureOwner('replacement-password'), false);
  assert.ok(!fs.readFileSync(filePath,'utf8').includes(password));
  enroll(policy);
  const tx = policy.begin(request('/f/conversation','POST',{}));
  for(let i=0;i<5;i++) assert.equal(policy.reset('incorrect'),false);
  assert.equal(policy.reset(password),false);
  now += 60_001;
  assert.equal(policy.reset(password),true);
  assert.deepEqual(policy.snapshot().allowedIds,[]);
  assert.equal(policy.acceptCreated(tx,B),false);
  assert.equal(policy.reset(''),false);
});
test('corruption stays locked without rewriting, retaining only valid owner recovery metadata', t => {
  const { policy,filePath } = fixture(t);
  policy.configureOwner(password);
  enroll(policy);
  const damaged = JSON.parse(fs.readFileSync(filePath));
  damaged.scopes = { invalid: ['old-non-uuid'] };
  fs.writeFileSync(filePath,JSON.stringify(damaged));
  const before = fs.readFileSync(filePath,'utf8');
  const locked = new HistoryPolicy({filePath});
  locked.setPrincipal({accountId:'account-a',userId:'user-a'});
  assert.equal(locked.snapshot().status,'locked');
  assert.equal(locked.acceptCreated({kind:'creation'},A),false);
  assert.equal(locked.configureOwner(password),false);
  assert.equal(fs.readFileSync(filePath,'utf8'),before);
  assert.equal(locked.reset(password),true);
  assert.deepEqual(locked.snapshot().allowedIds,[]);
  fs.writeFileSync(filePath,'{broken');
  const unrecoverable = new HistoryPolicy({filePath});
  assert.equal(unrecoverable.reset(password),false);
  assert.equal(unrecoverable.configureOwner(password),false);
  assert.equal(fs.readFileSync(filePath,'utf8'),'{broken');
});
test('explicit host failure invalidates transactions and locks sensitive requests', t => {
  const {policy} = fixture(t);
  policy.configureOwner(password);
  const tx=policy.begin(request('/f/conversation','POST',{}));
  policy.failClosed('host failure');
  policy.setPrincipal({accountId:'account-a',userId:'user-a'});
  assert.equal(policy.snapshot().status,'locked');
  assert.equal(policy.acceptCreated(tx,A),false);
  assert.equal(policy.begin(request('/conversations')).kind,'deny');
  assert.equal(policy.reset(password),true);
  assert.equal(policy.snapshot().status,'locked');
});
test('approved IDs do not authorize unknown POST endpoints and read bodies cannot create approvals', t => {
  const {policy} = fixture(t);
  enroll(policy);
  assert.equal(policy.begin(request(`/conversation/${A}/unknown-operation`,'POST',{})).kind,'deny');
  assert.equal(policy.begin(request(`/conversation/${A}/resume`,'POST',{conversation_id:A})).kind,'approved');
  assert.equal(policy.acceptCreated(policy.begin(request(`/conversation/${A}`)),B),false);
  assert.equal(policy.begin(request(`/conversation/${A}/unknown-read`)).kind,'deny');
});
test('approved initialization and known resumes preserve existing owned conversations', t => {
  const {policy} = fixture(t);
  enroll(policy);
  for(const route of ['/conversation/init','/f/conversation/prepare','/f/conversation/resume','/conversation/resume']) {
    assert.equal(policy.begin(request(route,'POST',{conversation_id:A,messages:[]})).kind,'approved',route);
    assert.equal(policy.begin(request(route,'POST',{conversation_id:B})).kind,'deny',route);
  }
  for(const route of ['/f/conversation/resume','/conversation/resume']) {
    const tx=policy.begin(request(route,'POST',{}));
    assert.equal(tx.kind,'deny');
    assert.equal(policy.acceptCreated(tx,B),false);
  }
  assert.equal(policy.begin(request('/f/conversation/prepare','POST',{messages:[]})).kind,'passthrough');
});
test('non-sensitive uploads and login bodies pass through while object IDs stay restricted', t => {
  const {policy} = fixture(t);
  assert.equal(policy.begin(request('/files','POST',Buffer.from([0,1,2]))).kind,'passthrough');
  assert.equal(policy.begin(request('/login','POST','username=test&password=test')).kind,'passthrough');
  assert.equal(policy.begin(request('/unknown','POST',{nested:{conversation_id:B}})).kind,'deny');
  assert.equal(policy.begin(request('/unknown','POST',JSON.stringify({conversation_id:B}))).kind,'deny');
});
test('persisted owner survives restart and reset clears approvals in every account', t => {
  const {policy,filePath} = fixture(t);
  assert.equal(policy.configureOwner(password),true);
  enroll(policy);
  policy.setPrincipal({accountId:'account-b',userId:'user-a'});
  enroll(policy,B);
  const next = new HistoryPolicy({filePath});
  next.setPrincipal({accountId:'account-b',userId:'user-a'});
  assert.deepEqual(next.snapshot().allowedIds,[B]);
  assert.equal(next.reset(password),true);
  next.setPrincipal({accountId:'account-a',userId:'user-a'});
  assert.deepEqual(next.snapshot().allowedIds,[]);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath)).scopes,{});
  assert.equal(fs.readdirSync(path.dirname(filePath)).length,1);
  if(process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777,0o600);
});
