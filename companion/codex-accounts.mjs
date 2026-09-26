/** Account administration. Login stays in the user's browser; never collect tokens in chat. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accountsRoot, assertAlias, safePath, writeJSON, loadRegistry, initRegistry, publicAccounts,
  acquireLease, profileDir, credentialIdentity, registerAccount, updateRegistry } from './account-store.mjs';
import { proxyConfig, executable, stopChild, startAccountProxy } from './account-proxy.mjs';

function parse(argv) {
  const [command = 'list', ...rest] = argv, positional = [], flags = {};
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (['--proxy-bin', '--file'].includes(x)) {
      if (!rest[i + 1] || rest[i + 1].startsWith('--') || flags[x]) throw new Error(`Provide one value for ${x}.`);
      flags[x] = rest[++i];
    } else if (x === '--no-browser') { if (flags[x]) throw new Error('Duplicate flag.'); flags[x] = true; }
    else if (x.startsWith('--')) throw new Error(`Unsupported account flag: ${x}`);
    else positional.push(x);
  }
  return { command, positional, flags };
}
/** Staging + validation precede swapping the one profile auth directory.
 * Profile lease excludes active workers and concurrent imports/logins. Registry updates
 * verify the identity before publication; failures restore the previous auth directory. */
export async function installCredential(root, alias, populate) {
  assertAlias(alias);
  if (!loadRegistry(root)) throw new Error('Run accounts init first.');
  const release = await acquireLease(root, `profile-${alias}`);
  const stageAlias = 'stage-' + randomUUID().slice(0, 32);
  const stage = profileDir(root, stageAlias), auth = path.join(stage, 'auth');
  const profile = profileDir(root, alias), dest = path.join(profile, 'auth');
  const backup = safePath(root, 'runs', 'auth-backup-' + randomUUID());
  let replaced = false, moved = false;
  try {
    fs.mkdirSync(auth, { recursive: true, mode: 0o700 });
    await populate(auth, stage);
    const identity = credentialIdentity(root, stageAlias), registry = loadRegistry(root);
    if (registry.accounts.some(a => a.alias !== alias && a.identity === identity)) throw new Error('This Google account is already registered under another alias.');
    if (registry.accounts.some(a => a.alias === alias && a.identity !== identity)) throw new Error('Re-login chose a different account. Use a new alias; previous login was preserved.');
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    if (fs.existsSync(dest)) { fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 }); fs.renameSync(dest, backup); moved = true; }
    fs.renameSync(auth, dest); replaced = true;
    const out = await registerAccount(root, alias);
    if (moved) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* Private backup retained if Windows has an open file handle. */ } }
    return out;
  } catch (e) {
    if (replaced) fs.rmSync(dest, { recursive: true, force: true });
    if (moved && fs.existsSync(backup)) fs.renameSync(backup, dest);
    throw e;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); release(); }
}
export async function importCredential(root, alias, input) {
  if (!path.isAbsolute(input)) input = path.resolve(input);
  const info = fs.lstatSync(input);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Import must be one regular credential JSON file (maximum 1 MB).');
  let data;
  try { data = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Credential is not valid JSON.'); }
  // Deliberately allowlist credential fields; never import proxy settings/URLs/disabled flags.
  if (data.type !== 'antigravity') throw new Error('Only an explicitly supplied Antigravity OAuth credential can be imported.');
  const clean = { type: 'antigravity' };
  for (const key of ['access_token', 'refresh_token', 'email', 'project_id', 'expired', 'token_type']) {
    if (data[key] !== undefined) { if (typeof data[key] !== 'string') throw new Error('Invalid credential field.'); clean[key] = data[key]; }
  }
  for (const key of ['timestamp', 'expires_in']) if (Number.isFinite(data[key])) clean[key] = data[key];
  return installCredential(root, alias, async auth => writeJSON(path.join(auth, 'antigravity.json'), clean));
}
export async function loginAccount(root, alias, { noBrowser = false, spawnFn = spawn } = {}) {
  return installCredential(root, alias, async (auth, stage) => {
    // CLIProxyAPI owns its OAuth flow and refresh; no embedded client ID/secret copied here.
    const config = path.join(stage, 'login.json'); writeJSON(config, proxyConfig(auth, 0, randomUUID()));
    const cmd = executable(loadRegistry(root).proxyBin, ['-config', config, '-antigravity-login', ...(noBrowser ? ['-no-browser'] : [])]);
    const child = spawnFn(cmd.command, cmd.args, { cwd: stage, windowsHide: true, stdio: 'inherit' });
    const cancel = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', c => resolve(c)); });
      if (code !== 0) throw new Error('Browser login did not finish successfully; previous login was kept.');
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); await stopChild(child); }
  });
}
export async function accountsMain(argv, { env = process.env, print = x => console.log(JSON.stringify(x, null, 2)) } = {}) {
  const { command, positional: p, flags: f } = parse(argv), root = accountsRoot(env);
  const valid = { init: ['--proxy-bin'], login: ['--no-browser'], import: ['--file'], list: [], use: [], strategy: [], enable: [], disable: [], models: [], help: [] };
  if (!(command in valid) || Object.keys(f).some(k => !valid[command].includes(k))) throw new Error('Invalid accounts command/flags. Use accounts help.');
  if (command === 'help') {
    print({ commands: ['init --proxy-bin ABSOLUTE_EXE', 'login ALIAS [--no-browser]', 'import ALIAS --file PI_AGY_CREDENTIAL_JSON', 'list', 'use auto|native|ALIAS', 'strategy sticky|round-robin', 'enable ALIAS', 'disable ALIAS', 'models ALIAS'],
      note: 'Use only accounts you own or are authorized to use. Complete each browser login once. Credentials are local, not printed. Native is the default until explicitly changed.' }); return 0;
  }
  if (command === 'init') { if (p.length || !f['--proxy-bin']) throw new Error('accounts init --proxy-bin ABSOLUTE_EXE'); print(initRegistry(root, f['--proxy-bin'])); return 0; }
  if (command === 'list') { if (p.length) throw new Error('accounts list takes no alias.'); print(publicAccounts(root)); return 0; }
  if (p.length !== 1) throw new Error('This account command requires exactly one argument.');
  if (command === 'login') print(await loginAccount(root, p[0], { noBrowser: !!f['--no-browser'] }));
  else if (command === 'import') { if (!f['--file']) throw new Error('accounts import ALIAS --file FILE'); print(await importCredential(root, p[0], f['--file'])); }
  else if (command === 'models') {
    assertAlias(p[0]); const proxy = await startAccountProxy(root, p[0]);
    try {
      const r = await fetch(proxy.baseURL + '/v1/models', { headers: { Authorization: `Bearer ${proxy.key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!r.ok) { await r.body?.cancel(); throw new Error(`Model discovery failed (HTTP ${r.status}).`); }
      const data = await r.json(); print({ alias: p[0], models: (data.data || []).map(m => m.id).filter(x => typeof x === 'string') });
    } finally { await proxy.close(); }
  } else print(await updateRegistry(root, s => {
    if (command === 'use') {
      if (!['auto', 'native'].includes(p[0]) && !s.accounts.some(a => a.alias === assertAlias(p[0]) && a.enabled)) throw new Error('Default alias is missing or disabled.');
      if (p[0] === 'auto' && !s.accounts.some(a => a.enabled)) throw new Error('Register and enable at least one account first.');
      s.default = p[0]; return { default: s.default };
    }
    if (command === 'strategy') { if (!['sticky', 'round-robin'].includes(p[0])) throw new Error('Strategy must be sticky or round-robin.'); s.strategy = p[0]; return { strategy: s.strategy }; }
    const a = s.accounts.find(a => a.alias === assertAlias(p[0])); if (!a) throw new Error('Unknown account alias.');
    a.enabled = command === 'enable'; return { alias: a.alias, enabled: a.enabled, cooldowns_preserved: true };
  }));
  return 0;
}
