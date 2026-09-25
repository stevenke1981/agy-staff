#!/usr/bin/env node
/** Optional user-skill install. No changes to config.toml, auth, MCP or other skills. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const SELF = fileURLToPath(import.meta.url);
const VERSION = '0.7.3-codex.1';
export const RUNTIME_FILES = ['companion/agy-companion.mjs', 'companion/stream-worker.mjs', 'companion/observation.mjs', 'companion/state-lock.mjs', 'companion/codex-platform.mjs', 'companion/codex-staff.mjs'];
export function installSkill(repo, { home = os.homedir(), update = false } = {}) {
  const root = fs.realpathSync(repo);
  const adaptation = JSON.parse(fs.readFileSync(path.join(root, '.agy-codex-adaptation.json'), 'utf8'));
  if (adaptation.version !== VERSION) throw new Error('Apply the matching adaptation before installation.');
  for (const file of RUNTIME_FILES) {
    const src = path.join(root, file);
    if (!fs.lstatSync(src).isFile() || fs.lstatSync(src).isSymbolicLink()) throw new Error(`Invalid runtime file: ${file}`);
    const expected = adaptation.files[file];
    if (expected && createHash('sha256').update(fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n')).digest('hex') !== expected) throw new Error(`Runtime modified since apply: ${file}`);
  }
  const agents = path.join(home, '.agents');
  const dest = path.join(agents, 'skills', 'agy-codex');
  // Never follow an existing destination symlink or replace an unmanaged user skill.
  if (fs.existsSync(dest)) {
    if (fs.lstatSync(dest).isSymbolicLink()) throw new Error('Refusing a symlinked skill destination.');
    const marker = path.join(dest, '.agy-codex-managed.json');
    if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker)).product !== 'agy-staff-codex') throw new Error('Existing skill is not managed by this installer.');
    if (!update) throw new Error('Already installed; use --update to back up and replace only this skill.');
  }
  fs.mkdirSync(agents, { recursive: true });
  const stage = path.join(agents, `.agy-codex-stage-${randomUUID()}`);
  const backup = path.join(agents, 'agy-staff-codex-backups', randomUUID());
  let moved = false, installed = false;
  try {
    fs.mkdirSync(stage);
    for (const rel of RUNTIME_FILES) {
      const output = path.join(stage, 'runtime', rel); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(path.join(root, rel), output);
    }
    const templates = path.join(root, 'templates');
    for (const name of ['ask', 'review', 'research', 'implement', 'staffer', 'harness-compatibility']) {
      const src = path.join(templates, name + '.md');
      if (!fs.lstatSync(src).isFile()) throw new Error(`Template missing: ${name}`);
      const target = path.join(stage, 'runtime', 'templates', name + '.md'); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(src, target);
    }
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
    fs.mkdirSync(path.join(stage, 'references'));
    for (const name of ['lead', 'reviewer', 'implementer', 'jobs']) {
      const ref = fs.readFileSync(path.join(root, 'codex-skills', name, 'SKILL.md'), 'utf8').split('\n').filter(line => !line.includes('向上兩層')).join('\n');
      fs.writeFileSync(path.join(stage, 'references', name + '.md'), '入口一律使用本 skill 根目錄下 runtime/companion/codex-staff.mjs。\n\n' + ref);
    }
    fs.writeFileSync(path.join(stage, 'SKILL.md'), `---\nname: agy-codex\ndescription: Explicitly delegate bounded AGY research, review or isolated implementation from Codex on Windows; Codex retains control and verification.\n---\n# AGY Staff for Codex\n以本 SKILL.md 所在資料夾為根目錄，所有入口一律使用此根目錄下的 runtime/companion/codex-staff.mjs。不要使用 references 內原 plugin 相對位置。\n使用 node 與完整引號路徑，先 doctor --workspace，然後依任務只讀 references/lead.md、reviewer.md、implementer.md 或 jobs.md。\nCodex 為主 Agent；小任務直接做，不遞迴委派。實作使用 prepare 回傳的 worktree；受限預設不是 OS 唯讀保證。\n不改全域設定、批准規則或媒體路由。未經該次授權不加 --allow-worker-tools。等待實際結果與測試，不把啟動當成完成。\n`);
    fs.mkdirSync(path.join(stage, 'agents')); fs.writeFileSync(path.join(stage, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
    fs.writeFileSync(path.join(stage, '.agy-codex-managed.json'), JSON.stringify({ product: 'agy-staff-codex', version: VERSION, source: root }, null, 2) + '\n');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.renameSync(dest, backup); moved = true; }
    fs.renameSync(stage, dest); installed = true;
    return { installed: dest, backup: moved ? backup : null, restart_codex_session: true, global_config_changed: false };
  } catch (error) {
    if (moved && !installed && !fs.existsSync(dest)) fs.renameSync(backup, dest);
    throw error;
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args[0] && args[0] !== '--update')) throw new Error('Usage: node scripts/install-codex-skill.mjs [--update]');
    console.log(JSON.stringify(installSkill(path.resolve(path.dirname(SELF), '..'), { update: args.includes('--update') }), null, 2));
  } catch (error) { console.error(`Skill install refused: ${error.message}`); process.exitCode = 1; }
}
