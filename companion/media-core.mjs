/** Durable media requests. Local state is not an OS sandbox or a credential vault. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const MEDIA_VERSION = '0.7.3-codex.3';
export const PROVIDERS = Object.freeze({
  'agy-native': { kinds: ['image'], references: 5 },
  'gemini-bridge': { kinds: ['image', 'video', 'music'], prefix: 'gemini', config: 'geminiBin', references: 5, server: 'gemini-web-bridge' },
  'grok-bridge': { kinds: ['image', 'video'], prefix: 'grok', config: 'grokBin', references: 1, server: 'grok-web-bridge' },
  'chatgpt-bridge': { kinds: ['image'], prefix: 'chatgpt', config: 'chatgptBin', references: 4, server: 'chatgpt-web-bridge' },
});
export function mediaError(code, message) { return Object.assign(new Error(message), { code }); }
export function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function fileHash(file) {
  const fd = fs.openSync(file, 'r'); const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = fs.readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, n)); } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function plainPath(file) {
  const full = path.resolve(file);
  for (let current = full;; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw mediaError('SYMLINK_REFUSED', `Symlink/junction path refused: ${current}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (path.dirname(current) === current) break;
  }
  return full;
}
export function privateDir(dir) { plainPath(dir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
export function atomicJSON(file, value) {
  plainPath(file); const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function readJSON(file) { plainPath(file); return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
export function mediaRoot(env = process.env) {
  return path.resolve(env.AGY_STAFF_MEDIA_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'agy-staff', 'media'));
}
export function loadConfig(root = mediaRoot(), env = process.env) {
  const file = path.join(root, 'config.json');
  const config = fs.existsSync(file) ? readJSON(file) : {};
  if (config.schema !== undefined && config.schema !== 1) throw mediaError('CONFIG_VERSION', 'Unknown media configuration schema.');
  return { schema: 1, agyBin: env.AGY_BIN || 'agy', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe',
    geminiBin: env.GEMINI_WEB_BRIDGE_BIN, grokBin: env.GROK_WEB_BRIDGE_BIN, chatgptBin: env.CHATGPT_WEB_BRIDGE_BIN, ...config };
}
export async function withLease(dir, fn) {
  privateDir(dir); const lock = path.join(dir, '.operation-lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // A numeric PID is never used to terminate a process. Only ESRCH permits stale-lock recovery.
    let old; try { old = readJSON(path.join(lock, 'owner.json')); } catch { /* incomplete claim is busy */ }
    let dead = false;
    if (Number.isInteger(old?.pid) && old.pid > 1) {
      try { process.kill(old.pid, 0); } catch (err) { dead = err.code === 'ESRCH'; }
    }
    if (!dead) throw mediaError('BUSY', 'Another operation holds this media job/configuration. Do not submit a replacement.');
    const check = readJSON(path.join(lock, 'owner.json'));
    if (check.nonce !== old.nonce) throw mediaError('BUSY', 'Lock changed during inspection.');
    fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
    fs.mkdirSync(lock, { mode: 0o700 });
  }
  const nonce = randomUUID(); atomicJSON(path.join(lock, 'owner.json'), { pid: process.pid, nonce });
  try { return await fn(); }
  finally {
    try { if (readJSON(path.join(lock, 'owner.json')).nonce === nonce) { fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); } } catch { /* don't remove another owner's lock */ }
  }
}
export function assetName(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id) || /[. ]$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) {
    throw mediaError('ASSET_ID', 'Use a Windows-safe asset ID, e.g. NL-MUSIC-001 (1–96 ASCII letters/digits/._-; no reserved device names).');
  }
  return id;
}
export function jobDirectory(root, id) { return plainPath(path.join(root, 'jobs', digest(assetName(id).toLowerCase()))); }
export function readJob(root, id) { return readJSON(path.join(jobDirectory(root, id), 'job.json')); }
export function saveJob(dir, job) { job.updated_at = new Date().toISOString(); atomicJSON(path.join(dir, 'job.json'), job); return job; }
export function hasJob(root, id) { return fs.existsSync(path.join(jobDirectory(root, id), 'job.json')); }
export function createJob(root, request, spec) {
  const dir = jobDirectory(root, request.asset_id); privateDir(path.dirname(dir));
  const fingerprint = digest(JSON.stringify(request));
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const prior = readJob(root, request.asset_id);
    if (prior.fingerprint !== fingerprint) throw mediaError('ASSET_CONFLICT', 'This asset ID already has different parameters. Preserve it and explicitly use a new ID for a new generation.');
    return { dir, job: prior, existing: true };
  }
  const job = { schema: 1, version: MEDIA_VERSION, asset_id: request.asset_id, fingerprint,
    request_id: 'agy-media-' + digest(request.asset_id.toLowerCase()).slice(0, 40),
    request, provider_spec: spec, state: 'prepared', may_have_submitted: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), candidates: [], files: [] };
  saveJob(dir, job); return { dir, job, existing: false };
}
export function summarize(job) {
  return { asset_id: job.asset_id, kind: job.request.kind, provider: job.request.provider, state: job.state,
    request_id: job.request_id, upstream_job_id: job.upstream_job_id || null, tab_id: job.tab_id || null,
    may_have_submitted: job.may_have_submitted, progress: job.progress || null,
    candidates: job.candidates || [], files: job.files || [], metadata: job.metadata || null,
    error: job.error || null, website_stop_confirmed: job.website_stop_confirmed ?? null,
    next: job.state === 'collected' ? 'Review the actual media; technical validation is not artistic/semantic acceptance.' :
      `media ${job.state === 'ready' || job.state === 'downloading' ? 'collect' : job.state === 'needs_attention' ? 'resume' : 'wait'} --asset-id ${job.asset_id}` };
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
