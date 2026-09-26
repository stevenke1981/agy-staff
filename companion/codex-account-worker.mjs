#!/usr/bin/env node
/** Own the per-job gateway, native AGY process, and isolated API-mode home. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { accountsRoot, safePath, writeJSON, acquireLease } from './account-store.mjs';
import { createAccountGateway } from './account-gateway.mjs';
import { executable, stopChild } from './account-proxy.mjs';

export function prepareRuntime(root, session, gateway, env = process.env) {
  if (!/^[0-9a-f-]{36}$/.test(session || '')) throw new Error('Missing/invalid account session identifier.');
  const home = safePath(root, 'runtime-homes', session), dir = safePath(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'settings.json');
  if (fs.existsSync(file)) {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).modelProvider !== 'gemini') throw new Error('Managed API-mode runtime was modified.');
  } else writeJSON(file, { modelProvider: 'gemini' });
  // API mode deliberately avoids the OS Google-account keyring. Changing HOME alone
  // would NOT isolate native OAuth. AGY must actually contact our gateway to succeed.
  const out = { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'),
    GEMINI_API_KEY: gateway.key, GOOGLE_GEMINI_BASE_URL: gateway.baseURL, AGY_STAFF_ACCOUNT_WORKER: '1' };
  delete out.GOOGLE_API_KEY;
  for (const p of [out.APPDATA, out.LOCALAPPDATA, out.XDG_CONFIG_HOME]) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return { home, env: out };
}
export async function runWorker(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] !== '--binary' || !argv[1] || argv[2] !== '--') throw new Error('Internal worker invocation is invalid.');
  const root = accountsRoot(env), session = env.AGY_STAFF_ACCOUNT_SESSION, wanted = env.AGY_STAFF_ACCOUNT;
  if (!wanted || wanted === 'native' || !/^[0-9a-f-]{36}$/.test(session || '')) throw new Error('Missing account routing context.');
  const release = await acquireLease(root, `session-${session}`);
  const controller = new AbortController(); let child, gateway, resultSeen = false, generationSeen = false, interrupted = false;
  const cancel = () => { interrupted = true; controller.abort(); if (child?.exitCode === null) child.kill('SIGTERM'); };
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  try {
    gateway = await createAccountGateway({ root, wanted, signal: controller.signal,
      onEvent: event => { if (event.event === 'generation_completed') generationSeen = true;
        process.stderr.write(`[agy-account] ${JSON.stringify(event)}\n`); } });
    const runtime = prepareRuntime(root, session, gateway, env), cmd = executable(argv[1], argv.slice(3));
    child = spawn(cmd.command, cmd.args, { cwd: process.cwd(), env: runtime.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let spawnError;
    const exited = new Promise(resolve => { child.once('error', e => { spawnError = e; resolve(1); }); child.once('exit', code => resolve(code ?? 1)); });
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') cancel(); });
    process.stdin.pipe(child.stdin);
    // Proxy logs never reach AGY/Codex; AGY diagnostics redact both local auth keys.
    const diagnostics = createInterface({ input: child.stderr });
    diagnostics.on('line', line => process.stderr.write(line.replaceAll(gateway.key, '[REDACTED]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]') + '\n'));
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { process.stdout.write(line.replaceAll(gateway.key, '[REDACTED]') + '\n'); continue; }
      if (event.event === 'result') {
        await gateway.waitForIdle();
        resultSeen = true;
        if (event.result?.status === 'SUCCESS' && !generationSeen) {
          event.result = { ...event.result, status: 'ERROR', response: '', error: 'Account gateway did not complete a generation request. Native keyring fallback is not accepted.' };
        }
      }
      process.stdout.write(JSON.stringify(event).replaceAll(gateway.key, '[REDACTED]') + '\n');
    }
    const code = await exited;
    if (spawnError) throw new Error('Native AGY failed to launch.');
    if (interrupted) return 130;
    return code || (!resultSeen || !generationSeen ? 1 : 0);
  } finally {
    process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
    if (child?.stdin) process.stdin.unpipe(child.stdin);
    await stopChild(child); await gateway?.close(); release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runWorker(); }
  catch { process.stderr.write('agy-account: worker failed; inspect accounts list and the sanitized job diagnostics.\n'); process.exitCode = 1; }
}
