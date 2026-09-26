import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installSkill, RUNTIME_FILES } from '../scripts/install-codex-skill.mjs';
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy skill install '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), home = path.join(dir, 'home'); fs.mkdirSync(repo); fs.mkdirSync(home);
  const files = {};
  for (const rel of RUNTIME_FILES) {
    const content = '// test fixture only\n';
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), content);
    files[rel] = createHash('sha256').update(content).digest('hex');
  }
  fs.mkdirSync(path.join(repo, 'templates'));
  for (const name of ['ask', 'review', 'research', 'implement', 'staffer', 'harness-compatibility']) fs.writeFileSync(path.join(repo, 'templates', name + '.md'), 'fixture template');
  for (const name of ['lead', 'reviewer', 'implementer', 'jobs']) {
    fs.mkdirSync(path.join(repo, 'codex-skills', name), { recursive: true });
    fs.writeFileSync(path.join(repo, 'codex-skills', name, 'SKILL.md'), '原檔向上兩層的入口。\nTask guidance.');
  }
  fs.writeFileSync(path.join(repo, 'LICENSE'), 'test license placeholder');
  fs.writeFileSync(path.join(repo, '.agy-codex-adaptation.json'), JSON.stringify({ version: '0.7.3-codex.1', files }));
  return { dir, repo, home, dest: path.join(home, '.agents', 'skills', 'agy-codex') };
}
test('user-skill installation includes runtime and corrects plugin-relative paths', t => {
  const f = setup(t), r = installSkill(f.repo, { home: f.home });
  assert.equal(r.installed, f.dest); assert.equal(r.backup, null); assert.equal(r.global_config_changed, false);
  assert.ok(fs.existsSync(path.join(f.dest, 'runtime', 'companion', 'agy-companion.mjs')));
  const ref = fs.readFileSync(path.join(f.dest, 'references', 'lead.md'), 'utf8');
  assert.match(ref, /runtime\/companion\/codex-staff.mjs/); assert.ok(!ref.includes('向上兩層'));
});
test('does not overwrite unmanaged existing skill', t => {
  const f = setup(t); fs.mkdirSync(f.dest, { recursive: true }); fs.writeFileSync(path.join(f.dest, 'SKILL.md'), 'user skill');
  assert.throws(() => installSkill(f.repo, { home: f.home, update: true }), /not managed/);
  assert.equal(fs.readFileSync(path.join(f.dest, 'SKILL.md'), 'utf8'), 'user skill');
});
test('existing managed install requires an explicit update', t => {
  const f = setup(t); installSkill(f.repo, { home: f.home });
  assert.throws(() => installSkill(f.repo, { home: f.home }), /Already installed/);
});
test('update removes old active install by backing it up, preserving its user files', t => {
  const f = setup(t); installSkill(f.repo, { home: f.home });
  fs.writeFileSync(path.join(f.dest, 'user-settings.json'), '{"keep":true}');
  const r = installSkill(f.repo, { home: f.home, update: true });
  assert.ok(r.backup); assert.equal(fs.readFileSync(path.join(r.backup, 'user-settings.json'), 'utf8'), '{"keep":true}');
  assert.ok(fs.existsSync(path.join(f.dest, 'SKILL.md')));
});
test('source validation failure leaves installed version intact', t => {
  const f = setup(t); installSkill(f.repo, { home: f.home });
  const old = fs.readFileSync(path.join(f.dest, 'SKILL.md'));
  fs.appendFileSync(path.join(f.repo, RUNTIME_FILES[0]), '// tampered');
  assert.throws(() => installSkill(f.repo, { home: f.home, update: true }), /Runtime modified/);
  assert.ok(fs.readFileSync(path.join(f.dest, 'SKILL.md')).equals(old));
});
test('missing template fails before removing previous active skill', t => {
  const f = setup(t); installSkill(f.repo, { home: f.home });
  const old = fs.readFileSync(path.join(f.dest, 'SKILL.md'));
  fs.unlinkSync(path.join(f.repo, 'templates', 'ask.md'));
  assert.throws(() => installSkill(f.repo, { home: f.home, update: true }));
  assert.ok(fs.readFileSync(path.join(f.dest, 'SKILL.md')).equals(old));
});
test('missing runtime checksum refuses an update and preserves the active skill', t => {
  const f = setup(t); installSkill(f.repo, { home: f.home });
  const marker = path.join(f.repo, '.agy-codex-adaptation.json');
  const manifest = JSON.parse(fs.readFileSync(marker, 'utf8'));
  delete manifest.files['companion/observation.mjs'];
  fs.writeFileSync(marker, JSON.stringify(manifest));
  const old = fs.readFileSync(path.join(f.dest, 'SKILL.md'));
  assert.throws(() => installSkill(f.repo, { home: f.home, update: true }), /checksum missing or invalid/);
  assert.ok(fs.readFileSync(path.join(f.dest, 'SKILL.md')).equals(old));
});
test('preserves global Codex settings and other installed skills byte for byte', t => {
  const f = setup(t);
  const config = path.join(f.home, '.codex', 'config.toml'), other = path.join(f.home, '.agents', 'skills', 'other', 'SKILL.md');
  for (const p of [config, other]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'do not change'); }
  installSkill(f.repo, { home: f.home });
  for (const p of [config, other]) assert.equal(fs.readFileSync(p, 'utf8'), 'do not change');
});
