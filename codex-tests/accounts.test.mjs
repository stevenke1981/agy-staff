import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initRegistry, loadRegistry, writeJSON, registerAccount, safePath, assertAlias, acquireLease,
  availableAccounts, recordOutcome, retryDelay, publicAccounts, updateRegistry, protectRoot } from '../companion/account-store.mjs';
import { accountsMain, importCredential, loginAccount } from '../companion/codex-accounts.mjs';
import { createAccountGateway, validateRoute } from '../companion/account-gateway.mjs';
import { proxyConfig } from '../companion/account-proxy.mjs';
import { prepareRuntime } from '../companion/codex-account-worker.mjs';
import { createAgyCommand, parseStreamResult } from '../companion/codex-platform.mjs';
import { planInvocation, parseOptions } from '../companion/codex-staff.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), FAKE = path.join(HERE, 'fixtures', 'fake-proxy.mjs');
function sandbox(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-accounts-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'accounts');
  initRegistry(state, FAKE, { protect: dir => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) });
  return { root, state, env: { ...process.env, AGY_STAFF_ACCOUNTS_DIR: state } };
}
async function add(state, alias, email = alias + '@example.invalid') {
  const auth = path.join(state, 'profiles', alias, 'auth'); fs.mkdirSync(auth, { recursive: true });
  writeJSON(path.join(auth, 'antigravity.json'), { type: 'antigravity', email, refresh_token: 'fixture-refresh-secret' });
  await registerAccount(state, alias);
}
async function gateway(state, behavior, options = {}) {
  const hits = [], events = [], children = new Set();
  const g = await createAccountGateway({ root: state, ...options, onEvent: e => events.push(e), startProxy: async (root, alias) => {
    const key = 'proxy-key-' + randomUUID();
    const s = http.createServer(async (req, res) => {
      const chunks = []; for await (const b of req) chunks.push(b);
      const hit = { alias, body: Buffer.concat(chunks).toString(), url: req.url, key: req.headers['x-goog-api-key'] }; hits.push(hit);
      assert.equal(req.headers.authorization, 'Bearer ' + key);
      behavior(alias, req, res, hit);
    });
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); children.add(s);
    return { alias, baseURL: `http://127.0.0.1:${s.address().port}`, key, close: async () => {
      s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); children.delete(s);
    } };
  } });
  return { ...g, hits, events, children };
}
async function request(g, body = '相同內容', route = '/v1beta/models/model-a:generateContent') {
  const r = await fetch(g.baseURL + route, { method: 'POST', headers: { 'x-goog-api-key': g.key }, body, signal: AbortSignal.timeout(5000) });
  return { status: r.status, text: await r.text(), headers: r.headers };
}
for (const alias of ['../a', 'A', 'native', 'auto', 'com2', 'lpt9', 'a'.repeat(41), 'a/b']) {
  test(`reject unsafe/reserved alias: ${alias}`, () => assert.throws(() => assertAlias(alias)));
}
test('registry starts native, lists aliases but never OAuth credentials', async t => {
  const { state } = sandbox(t); await add(state, 'google-1');
  assert.equal(loadRegistry(state).default, 'native');
  const out = JSON.stringify(publicAccounts(state)); assert.match(out, /google-1/); assert.doesNotMatch(out, /refresh|example.invalid|identity/);
  assert.throws(() => initRegistry(state, FAKE), /exists/);
});
test('duplicate Google identity cannot be registered under another alias', async t => {
  const { state } = sandbox(t); await add(state, 'first');
  await assert.rejects(add(state, 'second', 'FIRST@example.invalid'), /already registered/);
  assert.equal(loadRegistry(state).accounts.length, 1);
});
test('lease excludes another caller and releases only its own token', async t => {
  const { state } = sandbox(t); const release = await acquireLease(state, 'case');
  await assert.rejects(acquireLease(state, 'case'), { code: 'ACCOUNT_BUSY' });
  release(); const again = await acquireLease(state, 'case'); again();
});
test('profile paths reject escaping and directory junctions', t => {
  const { state, root } = sandbox(t); assert.throws(() => safePath(state, '..', 'outside'), /escaped/);
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(state, 'linked'), 'junction');
  assert.throws(() => safePath(state, 'linked', 'secret'), /Symlinks/);
});
test('corrupt registry is not reset', t => {
  const { state } = sandbox(t); fs.writeFileSync(path.join(state, 'registry.json'), '{bad');
  assert.throws(() => loadRegistry(state)); assert.equal(fs.readFileSync(path.join(state, 'registry.json'), 'utf8'), '{bad');
});
test('Windows ACL calls reset then restrict to current SID and SYSTEM; errors fail closed', t => {
  const { root } = sandbox(t), calls = [];
  protectRoot(path.join(root, 'private'), { platform: 'win32', runner: (exe, args) => {
    calls.push({ exe, args }); return { status: 0, stdout: '"USER","S-1-5-21-123-456-1001"' };
  } });
  assert.deepEqual(calls[1].args.slice(1), ['/reset']);
  assert.ok(calls[2].args.includes('*S-1-5-21-123-456-1001:(OI)(CI)F'));
  assert.throws(() => protectRoot(path.join(root, 'fail'), { platform: 'win32', runner: () => ({ status: 1 }) }), /SID/);
});
test('imports allowlisted pi-agy fields and preserves source plus previous login on conflict', async t => {
  const { state, root } = sandbox(t), file = path.join(root, 'pi-credentials.json');
  const body = { type: 'antigravity', email: 'one@example.invalid', refresh_token: 'fixture-refresh', project_id: 'project', proxy_url: 'https://untrusted.invalid', disabled: true };
  fs.writeFileSync(file, JSON.stringify(body)); await importCredential(state, 'one', file);
  const installed = fs.readFileSync(path.join(state, 'profiles', 'one', 'auth', 'antigravity.json'), 'utf8');
  assert.doesNotMatch(installed, /proxy_url|disabled/); assert.equal(JSON.parse(fs.readFileSync(file)).proxy_url, body.proxy_url);
  fs.writeFileSync(file, JSON.stringify({ ...body, email: 'other@example.invalid' }));
  await assert.rejects(importCredential(state, 'one', file), /different account/);
  assert.equal(fs.readFileSync(path.join(state, 'profiles', 'one', 'auth', 'antigravity.json'), 'utf8'), installed);
});
test('profile lease prevents refresh races with login or import', async t => {
  const { state, root } = sandbox(t), file = path.join(root, 'credential.json');
  fs.writeFileSync(file, JSON.stringify({ type: 'antigravity', email: 'a@example.invalid', refresh_token: 'fixture' }));
  const release = await acquireLease(state, 'profile-one');
  try { await assert.rejects(importCredential(state, 'one', file), { code: 'ACCOUNT_BUSY' }); }
  finally { release(); }
});
test('browser login runner registers its single profile (fake OAuth, offline)', async t => {
  const { state } = sandbox(t); await loginAccount(state, 'browser', { noBrowser: true });
  assert.equal(publicAccounts(state).accounts[0].alias, 'browser');
});
test('account admin switches defaults and strategy without clearing cooldown or touching Codex', async t => {
  const { state, env } = sandbox(t); await add(state, 'one'); await recordOutcome(state, 'one', 'm', 429, '60');
  const out = []; const cli = args => accountsMain(args, { env, print: x => out.push(x) });
  await cli(['use', 'auto']); await cli(['strategy', 'round-robin']); await cli(['disable', 'one']); await cli(['enable', 'one']);
  assert.equal(loadRegistry(state).default, 'auto'); assert.equal(loadRegistry(state).strategy, 'round-robin');
  assert.ok(loadRegistry(state).accounts[0].cooldowns.m > Date.now());
  await assert.rejects(cli(['list', '--file', 'anything']), /Invalid/);
});
test('model-specific quota and Retry-After seconds/date persist without early reuse', async t => {
  const { state } = sandbox(t); await add(state, 'one'); const now = Date.now();
  await recordOutcome(state, 'one', 'm', 429, '120', now);
  assert.deepEqual(availableAccounts(loadRegistry(state), 'm', { now: now + 1000 }), []);
  assert.equal(availableAccounts(loadRegistry(state), 'other', { now }).length, 1);
  assert.equal(retryDelay('120', now), 120000);
  assert.ok(retryDelay(new Date(now + 180000).toUTCString(), now) >= 179000);
});
test('sticky selects current eligible account; round-robin selects least recently used', async t => {
  const { state } = sandbox(t); await add(state, 'one'); await add(state, 'two');
  let s = loadRegistry(state); assert.equal(availableAccounts(s, 'm', { preferred: 'two' })[0].alias, 'two');
  await recordOutcome(state, 'one', 'm', 200); await updateRegistry(state, s => { s.strategy = 'round-robin'; });
  s = loadRegistry(state); assert.equal(availableAccounts(s, 'm')[0].alias, 'two');
});
test('proxy hardening: loopback only, no paid-credit/model fallback or extra retry rounds', () => {
  const c = proxyConfig('private-dir', 1234, 'key');
  assert.equal(c.host, '127.0.0.1'); assert.equal(c['remote-management']['secret-key'], '');
  assert.equal(c['quota-exceeded']['antigravity-credits'], false); assert.equal(c['quota-exceeded']['switch-preview-model'], false);
  assert.equal(c['request-retry'], 0); assert.equal(c.streaming['bootstrap-retries'], 0);
  assert.equal(c['passthrough-headers'], true);
});
test('429 switches before body: same prompt/model, secret stripped, cooldown persists', async t => {
  const { state } = sandbox(t); await add(state, 'one'); await add(state, 'two');
  const g = await gateway(state, (alias, req, res) => {
    if (alias === 'one') { res.writeHead(429, { 'Retry-After': '120' }); res.end('limited'); }
    else { res.end('success'); }
  });
  try {
    const r = await request(g, '中文 & --account ignored', '/v1beta/models/model-a:generateContent?key=' + g.key);
    assert.equal(r.status, 200); assert.equal(r.text, 'success');
    assert.deepEqual(g.hits.map(x => x.alias), ['one', 'two']); assert.equal(g.hits[0].body, g.hits[1].body);
    assert.doesNotMatch(JSON.stringify(g.hits), new RegExp(g.key)); assert.doesNotMatch(g.hits[0].url, /key=/);
    await request(g); assert.equal(g.hits.length, 3); assert.equal(g.hits[2].alias, 'two');
    assert.ok(loadRegistry(state).accounts[0].cooldowns['model-a'] > Date.now() + 110000);
  } finally { await g.close(); }
  assert.equal(g.children.size, 0);
});
for (const status of [400, 403, 404]) {
  test(`HTTP ${status} is not hidden by account switching`, async t => {
    const { state } = sandbox(t); await add(state, 'one'); await add(state, 'two');
    const g = await gateway(state, (a, q, r) => { r.writeHead(status); r.end('not exposed'); });
    try {
      const r = await request(g); assert.equal(r.status, status); assert.equal(g.hits.length, 1); assert.doesNotMatch(r.text, /not exposed/);
      assert.equal(!!loadRegistry(state).accounts[0].blocked, status === 403);
    } finally { await g.close(); }
  });
}
for (const status of [401, 502, 503, 504]) {
  test(`HTTP ${status} advances to an eligible authorized account before streaming`, async t => {
    const { state } = sandbox(t); await add(state, 'one'); await add(state, 'two');
    const g = await gateway(state, (a, q, r) => { r.writeHead(a === 'one' ? status : 200); r.end('done'); });
    try { const r = await request(g); assert.equal(r.status, 200); assert.deepEqual(g.hits.map(x => x.alias), ['one', 'two']);
      assert.equal(!!loadRegistry(state).accounts[0].needsLogin, status === 401);
    } finally { await g.close(); }
  });
}
test('pinned alias never falls back to another account', async t => {
  const { state } = sandbox(t); await add(state, 'one'); await add(state, 'two');
  const g = await gateway(state, (a, q, r) => { r.writeHead(429); r.end(); }, { wanted: 'one' });
  try { const r = await request(g); assert.equal(r.status, 429); assert.deepEqual(g.hits.map(x => x.alias), ['one']); }
  finally { await g.close(); }
});
test('all unavailable: bound attempts, honor cooldown without a busy loop', async t => {
  const { state } = sandbox(t); for (const name of ['one', 'two', 'three', 'four']) await add(state, name);
  const g = await gateway(state, (a, q, r) => { r.writeHead(429, { 'Retry-After': '120' }); r.end(); });
  try { const r = await request(g); assert.equal(r.status, 429); assert.equal(g.hits.length, 3); assert.ok(Number(r.headers.get('retry-after')) >= 119); }
  finally { await g.close(); }
});
test('stream interruption after headers does not replay on account two', async t => {
  const { state } = sandbox(t); await add(state, 'one'); await add(state, 'two');
  const g = await gateway(state, (a, q, r) => { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); r.write('data: {"partial":true}\n\n'); setTimeout(() => r.destroy(), 25); });
  try { await assert.rejects(request(g)); assert.deepEqual(g.hits.map(x => x.alias), ['one']); }
  finally { await g.close(); }
});
test('ambiguous connection loss is not replayed', async t => {
  const { state } = sandbox(t); await add(state, 'one'); await add(state, 'two');
  const g = await gateway(state, (a, q, r) => r.destroy());
  try { assert.equal((await request(g)).status, 502); assert.equal(g.hits.length, 1); }
  finally { await g.close(); }
});
test('loopback gateway rejects bad auth, browser Origin, and unrelated API routes', async t => {
  const { state } = sandbox(t); await add(state, 'one'); const g = await gateway(state, () => { throw new Error('unexpected'); });
  try {
    for (const headers of [{}, { 'x-goog-api-key': g.key, Origin: 'https://malicious.invalid' }]) {
      const r = await fetch(g.baseURL + '/v1/models', { headers }); assert.equal(r.status, 401); await r.text();
    }
    const r = await fetch(g.baseURL + '/v0/management/auth-files', { headers: { 'x-goog-api-key': g.key } }); assert.equal(r.status, 404); await r.text();
    assert.equal(g.hits.length, 0);
  } finally { await g.close(); }
  assert.throws(() => validateRoute('/v1beta/models/a%2fb:generateContent', 'POST'));
  assert.throws(() => validateRoute('//external.invalid/', 'GET'));
});
test('parallel inference in the same job is bounded; account is not shared', async t => {
  const { state } = sandbox(t); await add(state, 'one'); let entered;
  const ready = new Promise(r => { entered = r; });
  const g = await gateway(state, (a, q, r) => { entered(); setTimeout(() => r.end('ok'), 80); });
  try { const first = request(g); await ready; assert.equal((await request(g)).status, 503); assert.equal((await first).status, 200); assert.equal(g.hits.length, 1); }
  finally { await g.close(); }
});
test('routed worker uses API-mode home; original process HOME and settings are unchanged', t => {
  const { state, env } = sandbox(t), original = { ...env }, session = randomUUID();
  const a = prepareRuntime(state, session, { key: 'dummy-key', baseURL: 'http://127.0.0.1:1234' }, env);
  const b = prepareRuntime(state, session, { key: 'new-key', baseURL: 'http://127.0.0.1:1235' }, env);
  assert.equal(a.home, b.home); assert.equal(b.env.GEMINI_API_KEY, 'new-key'); assert.deepEqual(env, original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.home, '.gemini', 'antigravity-cli', 'settings.json'))).modelProvider, 'gemini');
});
test('command adapter wraps only routed inference, never version/model discovery', () => {
  const env = { AGY_STAFF_CODEX_TRANSPORT: '1', AGY_STAFF_ACCOUNT: 'auto' };
  const run = createAgyCommand(FAKE, ['-p', 'text'], { env }); assert.match(run.args[0], /codex-account-worker/);
  assert.equal(createAgyCommand(FAKE, ['--version'], { env }).args[0], FAKE);
  assert.equal(createAgyCommand(FAKE, ['-p', 'text'], { env: { ...env, AGY_STAFF_ACCOUNT: 'native' } }).args[0], FAKE);
});
test('runtime selection uses local default but explicit native bypasses; prompt account text stays opaque', async t => {
  const { state, root, env } = sandbox(t); await add(state, 'one'); await updateRegistry(state, s => { s.default = 'auto'; });
  const p = planInvocation(['ask', '--workspace', root, '--prompt', '--account is just text'], { env });
  assert.equal(p.env.AGY_STAFF_ACCOUNT, 'auto'); assert.ok(p.env.AGY_STAFF_ACCOUNT_SESSION);
  assert.ok(!p.args.includes('--account')); assert.ok(p.args.includes('--account is just text'));
  const n = planInvocation(['ask', '--workspace', root, '--prompt', 'x', '--account', 'native'], { env }); assert.equal(n.env.AGY_STAFF_ACCOUNT, 'native');
  assert.equal(n.env.AGY_STAFF_ACCOUNT_SESSION, undefined);
  assert.throws(() => parseOptions(['ask', '--account', 'one', '--account', 'two']), /one --account/);
  assert.throws(() => planInvocation(['wait', 'id', '--workspace', root, '--account', 'auto'], { env }), /job management/);
});
test('continuation restores original routing/session even when default changed', async t => {
  const { state, root, env } = sandbox(t); await add(state, 'one');
  const git = args => { const r = spawnSync('git', args, { cwd: root }); assert.equal(r.status, 0); };
  git(['init', '-q']); const session = randomUUID(); fs.mkdirSync(path.join(root, '.agy-staff'));
  fs.writeFileSync(path.join(root, '.agy-staff', 'state.json'), JSON.stringify({ jobs: [{ id: 'job-a', cwd: root, mode: 'review', codex_account: 'auto', codex_account_session: session }] }));
  const p = planInvocation(['continue', '--workspace', root, '--job', 'job-a', '--prompt', 'next'], { env });
  assert.equal(p.env.AGY_STAFF_ACCOUNT, 'auto'); assert.equal(p.env.AGY_STAFF_ACCOUNT_SESSION, session);
  assert.throws(() => planInvocation(['continue', '--workspace', root, '--job', 'job-a', '--prompt', 'next', '--account', 'native'], { env }), /Cannot change/);
});
test('real child-process chain switches fake accounts and preserves long Chinese stdin', async t => {
  const { state, env } = sandbox(t); await add(state, 'one', 'limited@example.invalid'); await add(state, 'two', 'working@example.invalid');
  const prompt = '中文測試&| --fake " $ '.repeat(5000);
  const command = createAgyCommand(path.join(HERE, 'fixtures', 'fake-native.mjs'), ['-p', prompt], { env: { ...env, AGY_STAFF_CODEX_TRANSPORT: '1', AGY_STAFF_ACCOUNT: 'auto' } });
  const r = spawnSync(command.cmd, command.args, { env: { ...env, AGY_STAFF_ACCOUNT: 'auto', AGY_STAFF_ACCOUNT_SESSION: randomUUID() }, input: command.input,
    encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  assert.equal(r.status, 0, r.stderr); assert.equal(parseStreamResult(r.stdout).response, prompt);
  assert.match(r.stderr, /"alias":"one","status":429/); assert.match(r.stderr, /"event":"generation_completed","alias":"two"/);
  assert.doesNotMatch(r.stderr + r.stdout, /fixture-refresh-secret|@example.invalid/);
  assert.deepEqual(fs.readdirSync(path.join(state, 'locks')), []);
});
test('worker refuses SUCCESS when native process bypassed the routed account gateway', async t => {
  const { state, env } = sandbox(t); await add(state, 'one');
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'companion', 'codex-account-worker.mjs'), '--binary', path.join(HERE, 'fixtures', 'fake-native.mjs'), '--', '--skip-gateway'],
    { env: { ...env, AGY_STAFF_ACCOUNT: 'auto', AGY_STAFF_ACCOUNT_SESSION: randomUUID() }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(r.status, 1); assert.equal(parseStreamResult(r.stdout).status, 'ERROR');
  assert.match(parseStreamResult(r.stdout).error, /gateway did not complete/);
});
test('403 latches the whole job gateway so a native retry cannot silently switch accounts', async t => {
  const { state } = sandbox(t); await add(state, 'one'); await add(state, 'two');
  const g = await gateway(state, (a, q, r) => { r.writeHead(403); r.end(); });
  try { assert.equal((await request(g)).status, 403); assert.equal((await request(g)).status, 403); assert.equal(g.hits.length, 1); }
  finally { await g.close(); }
});
test('cancel while account proxy is starting waits for cleanup instead of leaking it', async t => {
  const { state } = sandbox(t); await add(state, 'one'); let enter, releaseStart, closed = false;
  const ready = new Promise(r => { enter = r; }), pause = new Promise(r => { releaseStart = r; });
  const g = await createAccountGateway({ root: state, startProxy: async () => {
    enter(); await pause; return { alias: 'one', close: async () => { closed = true; } };
  } });
  const pending = request(g).catch(() => null); await ready;
  const closing = g.close(); releaseStart(); await closing; await pending; assert.equal(closed, true);
});
test('dead-owner lease is recovered without touching a live newly acquired lease', async t => {
  const { state } = sandbox(t);
  const code = `import { acquireLease } from ${JSON.stringify(new URL('../companion/account-store.mjs', import.meta.url).href)}; await acquireLease(process.argv[1], 'dead-owner');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, state], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const release = await acquireLease(state, 'dead-owner');
  try { await assert.rejects(acquireLease(state, 'dead-owner'), { code: 'ACCOUNT_BUSY' }); }
  finally { release(); }
});
