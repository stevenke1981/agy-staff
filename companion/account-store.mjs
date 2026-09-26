/** Local, user-scoped account metadata. OAuth tokens belong to CLIProxyAPI, not jobs. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const VERSION = '0.7.3-codex.3';
export function accountsRoot(env = process.env) {
  return path.resolve(env.AGY_STAFF_ACCOUNTS_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'agy-staff', 'accounts'));
}
export function assertAlias(alias) {
  if (typeof alias !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(alias) || ['auto', 'native', 'con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)].includes(alias)) throw new Error('Account alias must be a non-reserved lowercase name, e.g. google-1.');
  return alias;
}
export function safePath(root, ...parts) {
  const base = path.resolve(root), dest = path.resolve(base, ...parts);
  if (dest !== base && !dest.startsWith(base + path.sep)) throw new Error('Account path escaped its root.');
  for (let p = dest; ; p = path.dirname(p)) {
    try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('Symlinks/junctions are not allowed in managed account paths.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (path.dirname(p) === p) break;
  }
  return dest;
}
export function protectRoot(root, { platform = process.platform, runner = spawnSync } = {}) {
  safePath(root); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') { fs.chmodSync(root, 0o700); return; }
  const who = runner('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const sid = String(who.stdout || '').match(/S-1-5-[0-9-]+/)?.[0];
  if (who.status !== 0 || !sid) throw new Error('Cannot identify Windows user SID; no credentials were written.');
  const reset = runner('icacls.exe', [root, '/reset'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (reset.status !== 0 || reset.error) throw new Error('Cannot reset account-folder ACL; setup stopped.');
  const r = runner('icacls.exe', [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (r.status !== 0 || r.error) throw new Error('Cannot restrict account-folder ACL; setup stopped.');
}
export function writeJSON(file, value) {
  const tmp = file + '.tmp-' + randomUUID();
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function loadRegistry(root = accountsRoot()) {
  const f = safePath(root, 'registry.json');
  if (!fs.existsSync(f)) return null;
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (s.schema !== 1 || !Array.isArray(s.accounts) || !['sticky', 'round-robin'].includes(s.strategy) || typeof s.default !== 'string') throw new Error('Invalid account registry; not resetting it.');
  for (const a of s.accounts) { assertAlias(a.alias); if (typeof a.enabled !== 'boolean') throw new Error('Invalid account record.'); }
  if (new Set(s.accounts.map(a => a.alias)).size !== s.accounts.length) throw new Error('Duplicate account aliases.');
  if (!['native', 'auto'].includes(s.default) && !s.accounts.some(a => a.alias === s.default)) throw new Error('Default account is missing.');
  if (!Number.isInteger(s.maxAttempts) || s.maxAttempts < 1 || s.maxAttempts > 5) throw new Error('Invalid account attempt bound.');
  return s;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Atomic mkdir lease; stale locks are reclaimed only after their owner PID is absent.
 * PID reuse can retain an old lock (fail-closed), never authorize killing a process. */
export async function acquireLease(root, name, { timeout = 0 } = {}) {
  if (!/^[a-z0-9_.-]+$/i.test(name)) throw new Error('Invalid lease name.');
  const locks = safePath(root, 'locks'); fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  const dir = safePath(root, 'locks', name), token = randomUUID(), deadline = Date.now() + timeout;
  for (;;) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      writeJSON(path.join(dir, 'owner.json'), { pid: process.pid, token });
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'))).token === token) fs.rmSync(dir, { recursive: true });
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'))); } catch {}
      let dead = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 1) {
        try { process.kill(owner.pid, 0); } catch (err) { dead = err.code === 'ESRCH'; }
      }
      if (dead) {
        // Serialize reapers, then re-read ownership under that guard. This prevents
        // a competing reaper from renaming a newly-created live lease.
        const guard = dir + '.reaper'; let guarded = false;
        try {
          fs.mkdirSync(guard, { mode: 0o700 }); guarded = true;
          let fresh; try { fresh = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'))); } catch {}
          let stillDead = false;
          if (fresh?.token === owner.token && fresh.pid === owner.pid) {
            try { process.kill(fresh.pid, 0); } catch (err) { stillDead = err.code === 'ESRCH'; }
          }
          if (stillDead) {
            const tomb = dir + '.stale-' + randomUUID();
            fs.renameSync(dir, tomb); fs.rmSync(tomb, { recursive: true }); continue;
          }
        } catch (err) { if (!['ENOENT', 'EEXIST'].includes(err.code)) throw err; }
        finally { if (guarded) fs.rmdirSync(guard); }
      }
      if (Date.now() >= deadline) throw Object.assign(new Error(`Account resource is busy: ${name}`), { code: 'ACCOUNT_BUSY' });
      await sleep(30);
    }
  }
}
export async function updateRegistry(root, mutate) {
  const release = await acquireLease(root, 'registry', { timeout: 3000 });
  try { const data = loadRegistry(root); if (!data) throw new Error('Run accounts init first.'); const out = mutate(data); writeJSON(safePath(root, 'registry.json'), data); return out; }
  finally { release(); }
}
export function initRegistry(root, proxyBin, { protect = protectRoot } = {}) {
  if (!path.isAbsolute(proxyBin) || !fs.statSync(proxyBin).isFile() || /\.(cmd|bat|ps1)$/i.test(proxyBin)) throw new Error('Supply the absolute path to a trusted native CLIProxyAPI executable.');
  if (loadRegistry(root)) throw new Error('Account registry already exists; it was not overwritten.');
  protect(root);
  const s = { schema: 1, version: VERSION, proxyBin: fs.realpathSync(proxyBin), default: 'native', strategy: 'sticky', maxAttempts: 3, accounts: [] };
  // Exclusive create; concurrent setup cannot replace an existing registry.
  fs.writeFileSync(safePath(root, 'registry.json'), JSON.stringify(s, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { root, default: s.default, proxyBin: s.proxyBin };
}
export function profileDir(root, alias) { return safePath(root, 'profiles', assertAlias(alias)); }
export function credentialFiles(root, alias) {
  const dir = safePath(root, 'profiles', assertAlias(alias), 'auth');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => {
    const file = safePath(root, 'profiles', alias, 'auth', n);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw new Error('Invalid credential file.');
    let data; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Invalid credential JSON; log in again.'); }
    if (data.type !== 'antigravity') throw new Error('An account profile contains a non-Antigravity credential.');
    return { file, data };
  });
}
export function credentialIdentity(root, alias) {
  const files = credentialFiles(root, alias);
  if (files.length !== 1) throw new Error('Each account profile must contain exactly one Antigravity login.');
  const c = files[0].data;
  if (typeof c.refresh_token !== 'string' || !c.refresh_token || typeof c.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(c.email)) throw new Error('Credential needs a refresh token and account email; log in again.');
  return createHash('sha256').update(c.email.toLowerCase()).digest('hex');
}
export async function registerAccount(root, alias) {
  assertAlias(alias); const identity = credentialIdentity(root, alias);
  return updateRegistry(root, s => {
    if (s.accounts.some(a => a.alias !== alias && a.identity === identity)) throw new Error('This Google account is already registered under another alias.');
    let a = s.accounts.find(x => x.alias === alias);
    if (a && a.identity !== identity) throw new Error('Re-login changed account identity; use a new alias instead.');
    if (!a) { a = { alias, identity, enabled: true, needsLogin: false, blocked: false, cooldowns: {}, lastUsed: 0 }; s.accounts.push(a); }
    a.needsLogin = false; a.blocked = false;
    return { alias, registered: true }; // Deliberately no email or token.
  });
}
export function publicAccounts(root = accountsRoot()) {
  const s = loadRegistry(root); if (!s) return { initialized: false, default: 'native', accounts: [] };
  return { initialized: true, default: s.default, strategy: s.strategy, maxAttempts: s.maxAttempts,
    accounts: s.accounts.map(a => ({ alias: a.alias, enabled: a.enabled, needs_login: !!a.needsLogin, blocked: !!a.blocked,
      cooldowns: a.cooldowns || {}, last_used: a.lastUsed ? new Date(a.lastUsed).toISOString() : null })) };
}
export function retryDelay(value, now = Date.now(), fallback = 60000) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Math.max(1000, Math.min(Number.MAX_SAFE_INTEGER - now, Number(value) * 1000));
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(1000, date - now) : fallback;
}
export function availableAccounts(s, model, { wanted = 'auto', exclude = [], now = Date.now(), preferred } = {}) {
  const list = s.accounts.filter(a => a.enabled && !a.needsLogin && !a.blocked && !exclude.includes(a.alias) &&
    (wanted === 'auto' || a.alias === wanted) && Math.max(a.cooldowns?.[model] || 0, a.cooldowns?.['*'] || 0) <= now);
  return list.sort((a, b) => {
    if (s.strategy === 'sticky') {
      if (a.alias === preferred) return -1; if (b.alias === preferred) return 1;
      return s.accounts.indexOf(a) - s.accounts.indexOf(b);
    }
    return (a.lastUsed || 0) - (b.lastUsed || 0) || a.alias.localeCompare(b.alias);
  });
}
export async function recordOutcome(root, alias, model, status, retryAfter, now = Date.now()) {
  return updateRegistry(root, s => {
    const a = s.accounts.find(x => x.alias === alias); if (!a) throw new Error('Account disappeared.');
    a.lastUsed = now; a.cooldowns ||= {};
    if (status === 429) a.cooldowns[model] = Math.max(a.cooldowns[model] || 0, now + retryDelay(retryAfter, now));
    else if ([502, 503, 504].includes(status)) a.cooldowns['*'] = Math.max(a.cooldowns['*'] || 0, now + retryDelay(retryAfter, now, 15000));
    else if (status === 401) a.needsLogin = true;
    else if (status === 403) a.blocked = true;
    // Never erase a concurrent cooldown on success; let it expire naturally.
  });
}
