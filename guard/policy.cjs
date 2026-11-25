'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^[0-9a-f]{64}$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const validOwner = owner => isRecord(owner) && owner.algorithm === 'scrypt' && /^[0-9a-f]{32}$/.test(owner.salt) && /^[0-9a-f]{64}$/.test(owner.hash) && Object.keys(owner).length === 3;
const normalizeId = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

class HistoryPolicy {
  #filePath; #clock; #scopes = Object.create(null); #owner = null; #scope = null;
  #reason = null; #corrupt = false; #transactions = new WeakSet(); #epoch = 0;
  #transactionData = new WeakMap(); #failures = 0; #cooldown = 0;
  constructor({ filePath, clock = Date.now } = {}) {
    this.#filePath = typeof filePath === 'string' ? path.resolve(filePath) : null;
    this.#clock = clock;
    if (!this.#filePath) { this.failClosed(); return; }
    try {
      const info = fs.lstatSync(this.#filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error();
      const data = JSON.parse(fs.readFileSync(this.#filePath, 'utf8'));
      if (validOwner(data?.owner)) this.#owner = data.owner;
      if (!isRecord(data) || data.version !== 2 || !isRecord(data.scopes) || (data.owner !== null && !validOwner(data.owner)) || Object.keys(data).sort().join(',') !== 'owner,scopes,version') throw new Error();
      for (const [scope, ids] of Object.entries(data.scopes)) {
        if (!SCOPE.test(scope) || !Array.isArray(ids) || ids.some(id => !normalizeId(id) || id !== id.toLowerCase()) || new Set(ids).size !== ids.length) throw new Error();
        this.#scopes[scope] = new Set(ids);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.#corrupt = true; this.failClosed(); }
    }
  }
  #invalidate() { this.#epoch++; this.#transactions = new WeakSet(); this.#transactionData = new WeakMap(); }
  setPrincipal(principal) {
    let scope = null;
    if (isRecord(principal) && typeof principal.accountId === 'string' && principal.accountId.trim() && typeof principal.userId === 'string' && principal.userId.trim() && principal.accountId.length <= 1024 && principal.userId.length <= 1024) {
      scope = crypto.createHash('sha256').update(JSON.stringify([principal.userId, principal.accountId])).digest('hex');
    }
    if (scope !== this.#scope) this.#invalidate();
    this.#scope = scope;
  }
  snapshot() {
    return { status: !this.#reason && this.#scope ? 'ready' : 'locked', accountScope: this.#scope, allowedIds: !this.#reason && this.#scope ? [...(this.#scopes[this.#scope] || [])].sort() : [], reason: this.#reason || (!this.#scope ? 'Account identity unavailable' : null) };
  }
  failClosed() { this.#reason = 'History policy unavailable'; this.#invalidate(); }
  #tx(kind, reason) {
    const tx = Object.freeze({ kind, accountScope: this.#scope, ...(reason ? { reason } : {}) });
    if (kind === 'creation') { this.#transactions.add(tx); this.#transactionData.set(tx, { epoch: this.#epoch, scope: this.#scope }); }
    return tx;
  }
  #allowed(id) { return !!id && !!this.#scopes[this.#scope]?.has(id); }
  begin({ url, method = 'GET', body } = {}) {
    const deny = () => this.#tx('deny', 'Cloud operation restricted');
    let parsed, route;
    try {
      if (typeof url !== 'string' || url.length > 16384) return deny();
      parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com' || parsed.port || parsed.username || parsed.password || parsed.hash) return deny();
      // Inspect the original path as WHATWG URL normalization would erase dot segments.
      const raw = url.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1] || '/';
      const decoded = decodeURIComponent(raw);
      if (decoded !== raw || decoded.includes('%') || decoded.includes('\\') || decoded.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded) || /[\u0000-\u0020\u007f]/.test(decoded)) return deny();
      route = decoded.replace(/^\/(backend-api|api)(?=\/|$)/, '');
    } catch { return deny(); }
    const sensitive = /^\/(?:conversation(?:s)?|f\/conversation|share(?:d)?|shared_conversations?|gizmos|projects|search|global\/search|sidebar|library|files\/(?:library|manage_library))(?:\/|$)/i.test(route);
    if (/^\/codex(?:\/|$)/.test(route)) return this.#tx('passthrough');
    if (sensitive && (this.#reason || !this.#scope)) return deny();
    if (sensitive && !/^\/(?:backend-api|api)\//.test(parsed.pathname)) return deny();
    if (sensitive) for (const [key] of parsed.searchParams) if (/(?:id|conversation|share)/i.test(key)) return deny();
    if (typeof method !== 'string') return deny();
    method = method.toUpperCase();
    let value = body;
    if (!sensitive && (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)) return this.#tx('passthrough');
    if (!sensitive && typeof value === 'string' && !/^[\s]*[\[{]/.test(value)) {
      for (const [key] of new URLSearchParams(value)) if (key === 'conversation_id' || key === 'shared_conversation_id' || key === 'new_branch') return deny();
      return this.#tx('passthrough');
    }
    try {
      if (typeof value === 'string') value = value === '' ? undefined : JSON.parse(value);
      if (value !== undefined && value !== null && !isRecord(value)) return deny();
    } catch { return deny(); }
    if (value && Object.prototype.hasOwnProperty.call(value, 'new_branch')) return deny();
    let ids = [], invalid = false, visited = new WeakSet();
    const walk = (node, depth, root) => {
      if (depth > 64) { invalid = true; return; }
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) { invalid = true; return; }
      visited.add(node);
      for (const [key, item] of Object.entries(node)) {
        if (key === 'conversation_id' || key === 'shared_conversation_id') {
          if (key === 'conversation_id' && root && item === null && ['/f/conversation', '/conversation/init', '/f/conversation/prepare'].includes(route)) continue;
          const id = normalizeId(item);
          if (!id) invalid = true; else ids.push(id);
        } else walk(item, depth + 1, false);
      }
    };
    try { walk(value, 0, true); } catch { return deny(); }
    if (invalid || ids.some(id => !this.#allowed(id))) return deny();
    if (!sensitive) return ids.length ? deny() : this.#tx('passthrough');
    if (method === 'POST' && (route === '/conversation/init' || route === '/f/conversation/prepare')) return this.#tx(ids.length ? 'approved' : 'passthrough');
    if (method === 'POST' && (route === '/conversation/resume' || route === '/f/conversation/resume')) return ids.length ? this.#tx('approved') : deny();
    if (method === 'POST' && route === '/f/conversation') {
      if (ids.length) return this.#tx('approved');
      return this.#tx('creation');
    }
    const paginated = route.match(/^\/conversations\/([^/]+)(?:\/messages)?$/);
    if (method === 'GET' && paginated && this.#allowed(normalizeId(paginated[1]))) {
      // These are the pagination options used by the bundled host client.
      const seen = new Set();
      for (const [key, option] of parsed.searchParams) {
        if (seen.has(key) || !['before', 'num_turns', 'include_has_versions'].includes(key)) return deny();
        seen.add(key);
        if (key === 'before' && (!route.endsWith('/messages') || !option || option.length > 4096)) return deny();
        if (key === 'num_turns' && (!/^[1-9][0-9]*$/.test(option) || !Number.isSafeInteger(Number(option)))) return deny();
        if (key === 'include_has_versions' && !['true', 'false'].includes(option)) return deny();
      }
      return this.#tx('approved');
    }
    const match = route.match(/^\/conversation\/([^/]+)(?:\/(resume|send))?$/);
    const knownOperation = ['GET', 'PATCH', 'DELETE'].includes(method) || (method === 'POST' && /^\/conversation\/[^/]+\/(?:resume|send)$/.test(route));
    if (match && knownOperation && (method === 'POST' || !match[2])) {
      const id = normalizeId(match[1]);
      if (this.#allowed(id)) return this.#tx('approved');
    }
    return deny();
  }
  #persist() {
    if (!this.#filePath) { this.failClosed(); return false; }
    let temporary;
    try {
      const dir = path.dirname(this.#filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      temporary = path.join(dir, `.policy-${crypto.randomBytes(12).toString('hex')}.tmp`);
      const scopes = Object.fromEntries(Object.entries(this.#scopes).map(([scope, ids]) => [scope, [...ids].sort()]));
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 2, owner: this.#owner, scopes })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.#filePath);
      fs.chmodSync(this.#filePath, 0o600);
      return true;
    } catch { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } this.failClosed(); return false; }
  }
  acceptCreated(transaction, value) {
    if (!transaction || !this.#transactions.has(transaction) || this.#reason || !this.#scope) return false;
    const record = this.#transactionData.get(transaction);
    this.#transactions.delete(transaction);
    if (!record || record.epoch !== this.#epoch || record.scope !== this.#scope) return false;
    const id = normalizeId(value);
    if (!id) return false;
    this.#scopes[this.#scope] ||= new Set();
    this.#scopes[this.#scope].add(id);
    return this.#persist();
  }
  configureOwner(password) {
    if (this.#owner || this.#corrupt || this.#reason || typeof password !== 'string' || password.length < 12 || password.length > 1024) return false;
    try {
      const salt = crypto.randomBytes(16).toString('hex');
      this.#owner = { algorithm: 'scrypt', salt, hash: crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex') };
      return this.#persist();
    } catch { this.failClosed(); return false; }
  }
  reset(password) {
    const now = this.#clock();
    if (!this.#owner || !Number.isFinite(now) || now < this.#cooldown) return false;
    if (this.#cooldown && now >= this.#cooldown) { this.#failures = 0; this.#cooldown = 0; }
    let valid = false;
    try {
      if (typeof password === 'string' && password.length >= 12 && password.length <= 1024) valid = crypto.timingSafeEqual(crypto.scryptSync(password, Buffer.from(this.#owner.salt, 'hex'), 32), Buffer.from(this.#owner.hash, 'hex'));
    } catch {}
    if (!valid) { if (++this.#failures >= 5) this.#cooldown = now + 60_000; return false; }
    this.#invalidate(); this.#scopes = Object.create(null);
    if (this.#corrupt) this.#reason = null;
    this.#corrupt = false; this.#failures = 0;
    return this.#persist();
  }
}

module.exports = { HistoryPolicy };
