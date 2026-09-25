#!/usr/bin/env node
/** Windows/Codex entrypoint. Wraps (does not replace) upstream durable jobs. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgyCommand } from './codex-platform.mjs';

const SELF = fileURLToPath(import.meta.url);
const RUN = new Set(['ask', 'research', 'review', 'staffer', 'implement', 'continue']);
const OPS = new Set(['status', 'wait', 'result', 'observe', 'cancel']);
const VALUE = new Set(['--prompt', '--prompt-file', '--job', '--conversation', '--model', '--effort', '--timeout']);
const BOOL = new Set(['--stdin', '--json']);
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.error?.message || r.stderr || r.status}`);
  return r.stdout.trim();
}
export function isLinkedWorktree(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  const gitDir = fs.realpathSync(git(root, ['rev-parse', '--absolute-git-dir']));
  const commonDir = fs.realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])));
  // Submodules also use a .git file, but their common dir equals their Git dir.
  return fs.lstatSync(path.join(root, '.git')).isFile() && gitDir !== commonDir;
}
export function parseOptions(argv) {
  const [command = 'help', ...raw] = argv;
  const output = { command, cwd: process.cwd(), allowTools: false, args: [] };
  let workspaceSet = false;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t === '--workspace') {
      if (workspaceSet || !raw[i + 1] || raw[i + 1].startsWith('--')) throw new Error('Use one --workspace <path>.');
      workspaceSet = true; output.cwd = path.resolve(raw[++i]);
    } else if (t === '--allow-worker-tools') {
      if (output.allowTools) throw new Error('Duplicate --allow-worker-tools.');
      output.allowTools = true;
    } else if (VALUE.has(t)) {
      if (raw[i + 1] === undefined) throw new Error(`Missing value for ${t}.`);
      output.args.push(t, raw[++i]); // Opaque value; never scan prompt contents for flags.
    } else if (BOOL.has(t)) {
      output.args.push(t);
    } else if (t === '--restricted') {
      // Explicitly redundant: this is already the default for tool-using runs.
    } else if (t.startsWith('--')) {
      throw new Error(`Unsupported flag ${t}. --allow-worker-tools is the only explicit permission opt-in.`);
    } else {
      output.args.push(t);
    }
  }
  return output;
}
export function planInvocation(argv, options = {}) {
  const parsed = parseOptions(argv);
  const { command, cwd, args, allowTools } = parsed;
  if (!RUN.has(command) && !OPS.has(command)) throw new Error(`Unsupported command: ${command}. Use help.`);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Workspace is not a directory.');
  if (OPS.has(command) && allowTools) throw new Error('--allow-worker-tools is not a job-management flag.');
  if (['ask', 'review', 'research'].includes(command) && allowTools) {
    throw new Error(`${command} does not accept unrestricted execution in the Codex entrypoint.`);
  }
  if (command === 'implement' || command === 'staffer') {
    if (!(options.linked ?? isLinkedWorktree)(cwd)) throw new Error('Worker writes require a linked Git worktree. Run prepare first.');
  }
  if (command === 'continue') {
    const at = args.indexOf('--job');
    if (at < 0) throw new Error('Continue requires --job <id>; implicit last-session resume is disabled.');
    const root = git(cwd, ['rev-parse', '--show-toplevel']);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.agy-staff', 'state.json'), 'utf8'));
    const prior = state.jobs?.find(j => j.id === args[at + 1]);
    if (!prior) throw new Error('Job not found in this workspace.');
    if (!prior.cwd || fs.realpathSync(prior.cwd) !== fs.realpathSync(cwd)) throw new Error('Resume from the original job working directory.');
    if (['implement', 'staffer'].includes(prior.mode) && !(options.linked ?? isLinkedWorktree)(cwd)) throw new Error('Implementation resume requires its original worktree.');
    if (allowTools && !['implement', 'staffer'].includes(prior.mode)) throw new Error('Cannot escalate a research/review/ask continuation.');
    if (allowTools && !(options.linked ?? isLinkedWorktree)(cwd)) throw new Error('Unrestricted resume requires a linked worktree.');
    // Explicit flag wins over any profile inherited from a legacy job.
  }
  const env = { ...(options.env ?? process.env), AGY_STAFF_CODEX_TRANSPORT: '1', AGY_STAFF_STRICT_RESULT: '1' };
  if (env.AGY_STAFF_MODEL && RUN.has(command) && !args.includes('--model') && !args.includes('--effort')) args.push('--model', env.AGY_STAFF_MODEL);
  if (RUN.has(command) && command !== 'ask') args.push(allowTools ? '--unrestricted' : '--restricted');
  return { command, cwd, env, args: [command, ...args] };
}
export function prepareWorktree(cwd, baseDir) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (git(root, ['status', '--porcelain']).length) throw new Error('Main worktree is dirty. Preserve/commit the intended base yourself, or let Codex work directly. Nothing was stashed or deleted.');
  const key = createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 12);
  const id = randomUUID();
  const base = baseDir || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'agy-staff', 'worktrees');
  const target = path.join(base, key, id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(root, ['worktree', 'add', '--detach', target, 'HEAD']);
  return { workspace: target, source: root, base_commit: git(root, ['rev-parse', 'HEAD']), isolated_checkout: true, os_sandbox: false };
}
export function doctor(cwd, env = process.env) {
  const localEnv = { ...env, AGY_STAFF_CODEX_TRANSPORT: '1' };
  const check = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd, env: localEnv, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    return { ok: !r.error && r.status === 0, text: String(r.stdout || '') + String(r.stderr || '') };
  };
  const agy = createAgyCommand(env.AGY_BIN || 'agy', ['--version'], { env: localEnv });
  const version = check(agy.cmd, agy.args);
  const help = createAgyCommand(env.AGY_BIN || 'agy', ['--help'], { env: localEnv });
  const support = check(help.cmd, help.args);
  const gitVersion = check('git', ['--version']);
  const checks = { node_22_or_newer: Number(process.versions.node.split('.')[0]) >= 22,
    git: gitVersion.ok, agy: version.ok,
    stream_input: support.ok && /--input-format/.test(support.text) && /stream-json/.test(support.text) };
  return { ok: Object.values(checks).every(Boolean), checks, node: process.version,
    agy_version: version.text.trim().slice(0, 160),
    note: 'No login/model request was sent. Authentication, model availability and Codex Desktop integration still need a live smoke test. No global settings changed.' };
}
export function main(argv = process.argv.slice(2)) {
  const p = parseOptions(argv);
  if (p.command === 'help' || p.command === '--help') {
    console.log('Codex AGY Staff: doctor | prepare | ask | review | research | staffer | implement | continue --job ID | status | wait | result | observe | cancel\nUse --workspace PATH and --prompt-file FILE for tasks. Implement/staffer require prepare + an isolated worktree.\nRestricted is default, NOT a read-only OS sandbox. --allow-worker-tools is explicit per-run opt-in for implementation in a worktree.\nUse the SAME --workspace for status/wait/cancel/continue. No automatic restart, commit, push, permission change or model fallback.');
    return 0;
  }
  if (['doctor', 'prepare'].includes(p.command)) {
    if (p.args.length || p.allowTools) throw new Error(`${p.command} accepts only --workspace.`);
    const out = p.command === 'doctor' ? doctor(p.cwd) : prepareWorktree(p.cwd);
    console.log(JSON.stringify(out, null, 2));
    return out.ok === false ? 1 : 0;
  }
  const plan = planInvocation(argv);
  const upstream = path.join(path.dirname(SELF), 'agy-companion.mjs');
  if (!fs.existsSync(upstream)) throw new Error('Apply this patch pack to the upstream repository before running jobs.');
  const r = spawnSync(process.execPath, [upstream, ...plan.args], { cwd: plan.cwd, env: plan.env, windowsHide: true, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.signal) throw new Error(`Companion interrupted: ${r.signal}`);
  return r.status ?? 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`agy-codex: ${error.message}`); process.exitCode = 1; }
}
