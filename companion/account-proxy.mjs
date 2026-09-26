/** One CLIProxyAPI process per leased account. No global auth swapping or public ports. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { acquireLease, profileDir, safePath, writeJSON, credentialIdentity, loadRegistry } from './account-store.mjs';

export function proxyConfig(authDir, port, key) {
  return { host: '127.0.0.1', port, 'auth-dir': authDir, 'api-keys': [key],
    'remote-management': { 'allow-remote': false, 'secret-key': '', 'disable-control-panel': true, 'disable-auto-update-panel': true },
    debug: false, 'request-log': false, 'logging-to-file': false, 'usage-statistics-enabled': false,
    discovery: { enabled: false }, plugins: { enabled: false }, pprof: { enable: false },
    'passthrough-headers': true, 'request-retry': 0, 'max-retry-credentials': 1, 'max-retry-interval': 0,
    'disable-cooling': false, 'save-cooldown-status': true,
    'quota-exceeded': { 'switch-project': false, 'switch-preview-model': false, 'antigravity-credits': false },
    routing: { strategy: 'fill-first' }, 'disable-image-generation': true,
    streaming: { 'bootstrap-retries': 0 }, 'nonstream-keepalive-interval': 0 };
}
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(e => e ? reject(e) : resolve(port)); });
  });
}
export function executable(binary, args) {
  if (/\.(cmd|bat|ps1)$/i.test(binary)) throw new Error('Shell shim is not supported.');
  return /\.(mjs|js|cjs)$/i.test(binary) ? { command: process.execPath, args: [binary, ...args] } : { command: binary, args };
}
export async function stopChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error('Owned proxy did not exit; lease retained.');
}
export async function startAccountProxy(root, alias, { signal, spawnFn = spawn, fetchFn = fetch } = {}) {
  const release = await acquireLease(root, `profile-${alias}`);
  let child, runDir, closing;
  const close = () => closing ||= Promise.resolve().then(async () => {
    await stopChild(child);
    if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
    release();
  });
  try {
    signal?.throwIfAborted();
    const s = loadRegistry(root), a = s?.accounts.find(x => x.alias === alias);
    if (!a?.enabled || a.needsLogin || a.blocked) throw new Error('Account is not enabled/ready.');
    if (credentialIdentity(root, alias) !== a.identity) throw new Error('Account credential identity changed.');
    runDir = safePath(root, 'runs', randomUUID()); fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const port = await freePort(), key = randomBytes(32).toString('hex'), baseURL = `http://127.0.0.1:${port}`;
    const file = path.join(runDir, 'config.json'); writeJSON(file, proxyConfig(path.join(profileDir(root, alias), 'auth'), port, key));
    const bin = executable(s.proxyBin, ['-config', file, '-local-model']);
    const env = { ...process.env };
    for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_GEMINI_BASE_URL']) delete env[name];
    child = spawnFn(bin.command, bin.args, { cwd: runDir, env, windowsHide: true, stdio: 'ignore' });
    let spawnError; child.on('error', e => { spawnError = e; });
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      signal?.throwIfAborted();
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('CLIProxyAPI failed to start; verify its version and configuration.');
      try {
        const r = await fetchFn(baseURL + '/v1/models', { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000) });
        if (r.ok) { await r.arrayBuffer(); return { alias, baseURL, key, close }; }
        await r.body?.cancel();
      } catch (e) { if (signal?.aborted) throw e; }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('CLIProxyAPI readiness timed out. No model request was sent.');
  } catch (e) { await close(); throw e; }
}
