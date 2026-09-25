/** Requires the real patched upstream. Run by test-codex.mjs after apply, NOT patch-pack tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Keep test Git invocations independent of real global hooks, aliases and signing.
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitNullDevice = process.platform === 'win32' ? 'NUL' : os.devNull;
process.env.GIT_CONFIG_GLOBAL = gitNullDevice;
process.env.GIT_CONFIG_SYSTEM = gitNullDevice;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(HERE, '..', 'companion', 'codex-staff.mjs');
function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy actual integration ')));
  const home = path.join(dir, 'home'), repo = path.join(dir, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(repo);
  const r = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\n.agy-staff/\n');
  // Tests await terminal state before removing these test-owned paths.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, AGY_BIN: path.join(HERE, 'fake-agy.mjs'), AGY_STAFF_MODEL: 'gemini-3.8-flash-low' };
  function run(args, extra = {}) {
    const p = spawnSync(process.execPath, [cli, ...args, '--workspace', repo], { env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    if (p.error) throw p.error;
    return p;
  }
  return { run, dir, repo };
}
test('actual patched foreground ask accepts long Unicode file through official stdin', t => {
  const s = sandbox(t), file = path.join(s.dir, '任務 with spaces.txt');
  fs.writeFileSync(file, '長中文 " & --flag\n'.repeat(4000));
  const r = s.run(['ask', '--prompt-file', file]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /CODEX_STDIN_OK/);
});
test('actual patched background review produces a durable successful job', t => {
  const s = sandbox(t);
  const launch = s.run(['review', '--prompt', 'Inspect offline fixture']);
  assert.equal(launch.status, 0, launch.stderr);
  const id = /job id:\s*(\S+)/.exec(launch.stdout)?.[1]; assert.ok(id, launch.stdout);
  const result = s.run(['wait', id, '--timeout', '60s']);
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.match(result.stdout, /CODEX_STDIN_OK/);
});
test('actual ERROR with partial output becomes error job, never done', t => {
  const s = sandbox(t);
  const launch = s.run(['review', '--prompt', 'Deliberate failure'], { FAKE_CODEX_FAILURE: '1' });
  assert.equal(launch.status, 0, launch.stderr);
  const id = /job id:\s*(\S+)/.exec(launch.stdout)?.[1]; assert.ok(id, launch.stdout);
  const result = s.run(['wait', id, '--timeout', '60s']);
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /Partial work|Intentional offline failure/);
  const state = JSON.parse(fs.readFileSync(path.join(s.repo, '.agy-staff', 'state.json')));
  assert.equal(state.jobs.find(j => j.id === id).status, 'error');
});
