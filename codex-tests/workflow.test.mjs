import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planInvocation, prepareWorktree, isLinkedWorktree, parseOptions, doctor } from '../companion/codex-staff.mjs';
// Keep test Git invocations independent of real global hooks, aliases and signing.
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitNullDevice = process.platform === 'win32' ? 'NUL' : os.devNull;
process.env.GIT_CONFIG_GLOBAL = gitNullDevice;
process.env.GIT_CONFIG_SYSTEM = gitNullDevice;
function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  return r.stdout.trim();
}
function repo(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy 工作區 '));
  const dir = path.join(temp, 'source repo'); fs.mkdirSync(dir);
  git(dir, ['init', '-q']); git(dir, ['config', 'user.email', 'offline-tests@example.invalid']); git(dir, ['config', 'user.name', 'Offline tests']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n'); git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'fixture']);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, dir };
}
test('default review is restricted and sets strict result + stdin transport', () => {
  const r = planInvocation(['review', '--prompt', 'review now'], { env: {} });
  assert.ok(r.args.includes('--restricted')); assert.ok(!r.args.includes('--unrestricted'));
  assert.equal(r.env.AGY_STAFF_STRICT_RESULT, '1'); assert.equal(r.env.AGY_STAFF_CODEX_TRANSPORT, '1');
});
test('prompt-shaped flags remain opaque and cannot opt into permissions', () => {
  const text = '--allow-worker-tools --unrestricted';
  const r = planInvocation(['review', '--prompt', text], { env: {} });
  assert.deepEqual(r.args, ['review', '--prompt', text, '--restricted']);
});
test('rejects direct bypass flags and unsupported setup/restart commands', () => {
  for (const args of [['review', '--unrestricted'], ['review', '--dangerously-skip-permissions'], ['setup'], ['restart', 'x']]) {
    assert.throws(() => planInvocation(args), /Unsupported/);
  }
});
test('review, research and ask reject explicit unrestricted tools', () => {
  for (const mode of ['review', 'research', 'ask']) assert.throws(() => planInvocation([mode, '--allow-worker-tools']), /does not accept/);
});
test('implement and staffer cannot use main worktree even in restricted mode', t => {
  const { dir } = repo(t);
  assert.equal(isLinkedWorktree(dir), false);
  for (const mode of ['implement', 'staffer']) assert.throws(() => planInvocation([mode, '--workspace', dir, '--prompt', 'x']), /linked Git worktree/);
});
test('prepare creates detached linked checkout, not a security sandbox', t => {
  const { dir, temp } = repo(t);
  const p = prepareWorktree(dir, path.join(temp, 'worktrees'));
  assert.ok(fs.existsSync(path.join(p.workspace, 'file.txt')));
  assert.equal(isLinkedWorktree(p.workspace), true);
  assert.equal(p.os_sandbox, false); assert.equal(git(p.workspace, ['branch', '--show-current']), '');
  const r = planInvocation(['implement', '--workspace', p.workspace, '--prompt', 'fix']);
  assert.ok(r.args.includes('--restricted'));
});
test('dirty source is preserved and no worktree, stash or commit is created', t => {
  const { dir, temp } = repo(t);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'user change');
  const before = git(dir, ['rev-parse', 'HEAD']);
  assert.throws(() => prepareWorktree(dir, path.join(temp, 'worktrees')), /dirty/);
  assert.equal(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), 'user change');
  assert.equal(git(dir, ['rev-parse', 'HEAD']), before); assert.equal(git(dir, ['stash', 'list']), '');
  assert.equal(fs.existsSync(path.join(temp, 'worktrees')), false);
});
test('a standalone gitfile is not mistaken for an isolated linked worktree', t => {
  const { dir, temp } = repo(t);
  const relocated = path.join(temp, 'external-git');
  fs.renameSync(path.join(dir, '.git'), relocated);
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${relocated}\n`);
  assert.equal(isLinkedWorktree(dir), false);
});
test('unrestricted implement needs explicit opt-in and an isolated worktree', t => {
  const { dir, temp } = repo(t);
  const p = prepareWorktree(dir, path.join(temp, 'worktrees'));
  const r = planInvocation(['implement', '--workspace', p.workspace, '--prompt', 'x', '--allow-worker-tools']);
  assert.ok(r.args.includes('--unrestricted')); assert.ok(!r.args.includes('--restricted'));
  assert.throws(() => planInvocation(['implement', '--workspace', dir, '--prompt', 'x', '--allow-worker-tools']), /worktree/);
});
test('model override is optional and never supersedes explicit task model/effort', () => {
  const env = { AGY_STAFF_MODEL: 'available-model-high' };
  assert.ok(planInvocation(['ask', '--prompt', 'x'], { env }).args.includes('available-model-high'));
  assert.ok(!planInvocation(['ask', '--model', 'selected-low', '--prompt', 'x'], { env }).args.includes('available-model-high'));
  assert.ok(!planInvocation(['ask', '--effort', 'low', '--prompt', 'x'], { env }).args.includes('available-model-high'));
});
test('continue requires explicit job identity', () => assert.throws(() => planInvocation(['continue', '--prompt', 'x']), /requires --job/));
test('resume explicitly overrides a legacy unrestricted profile', t => {
  const { dir } = repo(t);
  fs.mkdirSync(path.join(dir, '.agy-staff'));
  fs.writeFileSync(path.join(dir, '.agy-staff', 'state.json'), JSON.stringify({ jobs: [{ id: 'job-1', mode: 'review', cwd: dir, profile: 'unrestricted' }] }));
  const r = planInvocation(['continue', '--workspace', dir, '--job', 'job-1', '--prompt', 'next']);
  assert.ok(r.args.includes('--restricted'));
  assert.throws(() => planInvocation(['continue', '--workspace', dir, '--job', 'job-1', '--prompt', 'next', '--allow-worker-tools']), /Cannot escalate/);
});
test('resume refuses unknown job or a different original directory', t => {
  const { dir, temp } = repo(t);
  fs.mkdirSync(path.join(dir, '.agy-staff'));
  fs.writeFileSync(path.join(dir, '.agy-staff', 'state.json'), JSON.stringify({ jobs: [{ id: 'one', mode: 'review', cwd: temp }] }));
  assert.throws(() => planInvocation(['continue', '--workspace', dir, '--job', 'missing', '--prompt', 'x']), /not found/);
  assert.throws(() => planInvocation(['continue', '--workspace', dir, '--job', 'one', '--prompt', 'x']), /original/);
});
test('job operations never accept escalation or start a model request', () => {
  const r = planInvocation(['status', 'example'], { env: { AGY_STAFF_MODEL: 'x-high' } });
  assert.deepEqual(r.args, ['status', 'example']);
  assert.throws(() => planInvocation(['cancel', 'example', '--allow-worker-tools']), /management/);
});
test('duplicate workspace and missing values are rejected', () => {
  assert.throws(() => parseOptions(['ask', '--workspace', '.', '--workspace', '.']), /one --workspace/);
  assert.throws(() => parseOptions(['ask', '--prompt']), /Missing/);
});
test('doctor uses only version/help queries and preserves global configuration', t => {
  const { temp, dir } = repo(t);
  const fake = path.join(temp, 'fake.mjs');
  fs.writeFileSync(fake, `if(process.argv[2]==='--version')console.log('fake-test-only');\nelse if(process.argv[2]==='--help')console.error('--input-format stream-json');\nelse process.exit(77);`);
  const d = doctor(dir, { ...process.env, AGY_BIN: fake });
  assert.equal(d.ok, true); assert.equal(d.agy_version, 'fake-test-only');
  assert.equal(fs.existsSync(path.join(temp, '.codex')), false);
});
