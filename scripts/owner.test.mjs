import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let configurePolicy;
try { ({ configurePolicy } = await import('./owner.mjs')); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
test('owner setup is single-use and resetting cannot grant conversations', t => {
  assert.equal(typeof configurePolicy, 'function', 'owner command is missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-owner-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'policy.json');
  assert.equal(configurePolicy('setup', file, 'correct-owner-password'), true);
  assert.equal(configurePolicy('setup', file, 'different-owner-password'), false);
  assert.equal(configurePolicy('reset', file, 'different-owner-password'), false);
  assert.equal(configurePolicy('reset', file, 'correct-owner-password'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).scopes, {});
  assert.throws(() => configurePolicy('grant', file, 'correct-owner-password'), /Unknown owner operation/);
});
