/** AGY native generate_image runner. No native video/music tools are invented. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAgyCommand, parseStreamResult, enforceStrictResult } from './codex-platform.mjs';
import { readJSON, saveJob, atomicJSON, privateDir, plainPath, fileHash, mediaError } from './media-core.mjs';

function hookCommand(phase) {
  const hook = fileURLToPath(new URL('./media-tool-hook.mjs', import.meta.url));
  if (process.platform === 'win32') {
    // These are our executable/module paths, never user prompt text. Refuse shell metacharacters.
    for (const s of [process.execPath, hook]) if (/["%!^&|<>\r\n]/.test(s)) throw mediaError('HOOK_PATH', 'Move the runtime to a path without Windows shell metacharacters.');
    return `"${process.execPath}" "${hook}" ${phase}`;
  }
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  return `${quote(process.execPath)} ${quote(hook)} ${phase}`;
}
export function setupNativeWorkspace(dir, job) {
  const workspace = privateDir(path.join(dir, 'workspace')); const references = [];
  for (let i = 0; i < job.request.references.length; i++) {
    const reference = job.request.references[i], dest = path.join(workspace, `reference-${i}${path.extname(reference.path).toLowerCase()}`);
    if (fileHash(reference.path) !== reference.sha256) throw mediaError('REFERENCE_CHANGED', 'Reference changed since submission was planned.');
    fs.copyFileSync(reference.path, dest, fs.constants.COPYFILE_EXCL);
    if (fileHash(dest) !== reference.sha256) throw mediaError('REFERENCE_CHANGED', 'Reference copy changed.');
    references.push(dest);
  }
  privateDir(path.join(workspace, '.agents'));
  atomicJSON(path.join(workspace, '.agents', 'hooks.json'), { 'agy-staff-single-image': {
    PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: hookCommand('pre'), timeout: 10 }] }],
    PostToolUse: [{ matcher: '^generate_image$', hooks: [{ type: 'command', command: hookCommand('post'), timeout: 10 }] }],
  } });
  atomicJSON(path.join(dir, 'native-request.json'), { asset_id: job.asset_id, references });
  return { workspace, references };
}
export function discoverNativeCandidate(dir, job) {
  const result = readJSON(path.join(dir, 'native-result.json'));
  enforceStrictResult(result.payload, result.exit, { AGY_STAFF_STRICT_RESULT: '1' });
  if (!fs.existsSync(path.join(dir, 'image-tool.claim'))) throw mediaError('NO_TOOL_EVIDENCE', 'No generate_image hook claim was observed. Do not accept a text response or a synthetic placeholder.');
  const claim = readJSON(path.join(dir, 'image-tool.claim'));
  const receipt = readJSON(path.join(dir, 'image-tool.receipt.json'));
  if (!claim.conversation_id || receipt.conversation_id !== claim.conversation_id || (result.payload?.conversation_id && result.payload.conversation_id !== claim.conversation_id)) throw mediaError('TOOL_BINDING', 'Native image tool receipts belong to a different conversation.');
  if (receipt.tool !== 'generate_image' || receipt.image_name !== job.asset_id || receipt.error || !receipt.artifact_directory) throw mediaError('IMAGE_TOOL_FAILED', 'Native image tool did not provide successful artifact evidence.');
  const root = plainPath(receipt.artifact_directory);
  const since = Date.parse(job.created_at) - 2000;
  const files = [];
  let visited = 0;
  const visit = (folder, depth) => {
    for (const ent of fs.readdirSync(folder, { withFileTypes: true })) {
      if (++visited > 1000) throw mediaError('ARTIFACT_LIMIT', 'Too many native artifact entries; inspect the job manually.');
      if (ent.isSymbolicLink()) continue;
      const file = path.join(folder, ent.name);
      if (ent.isDirectory() && depth < 2 && !ent.name.startsWith('.')) visit(file, depth + 1);
      if (ent.isFile() && /\.(png|jpe?g|webp)$/i.test(ent.name) && ent.name.toLowerCase().startsWith(job.asset_id.toLowerCase()) && fs.statSync(file).mtimeMs >= since) {
        files.push({ source: file, kind: 'image', evidence: 'generate_image pre/post hooks + fresh named artifact' });
      }
    }
  };
  visit(root, 0);
  if (files.length === 0) throw mediaError('NO_NATIVE_FILE', 'Native tool completed but no fresh artifact with the requested ImageName was found. Do not rerun generation.');
  return files;
}
export async function nativeWorker(dir) {
  plainPath(dir); const job = readJSON(path.join(dir, 'job.json'));
  if (job.request.provider !== 'agy-native' || job.request.kind !== 'image' || job.state !== 'submitting') throw mediaError('NATIVE_STATE', 'Invalid native media worker state.');
  fs.writeFileSync(path.join(dir, 'native-worker.claim'), String(process.pid), { flag: 'wx', mode: 0o600 });
  let child, cancelTimer, deadline, heartbeat, killTimer, reason = null;
  try {
    const native = readJSON(path.join(dir, 'native-request.json'));
    const prompt = ['Codex owns this task. Generate exactly ONE actual image using the built-in generate_image tool.',
      `ImageName MUST be exactly: ${job.asset_id}`, `ImagePaths MUST be exactly this array: ${JSON.stringify(native.references)}`,
      'No shell commands, external APIs, browser tools, SVG/code placeholders, account switching, variants or automatic retries.',
      'Do not copy/rename the result. Leave it in the native artifact directory; the host collects the actual file.',
      'After the one image tool completes, stop and briefly report the result. Do not ask another agent to generate.',
      'Approved image description:', job.request.prompt].join('\n');
    const env = { ...process.env, AGY_STAFF_CODEX_TRANSPORT: '1', AGY_STAFF_ACCOUNT: 'native', AGY_STAFF_MEDIA_JOB_DIR: dir };
    delete env.AGY_STAFF_ACCOUNT_SESSION; delete env.AGY_STAFF_ACCOUNT_WORKER;
    const args = ['-p', prompt, '--output-format', 'stream-json', '--print-timeout', `${job.request.timeout}s`, '--add-dir', path.join(dir, 'workspace')];
    if (job.request.model) args.push('--model', job.request.model); // Reasoning model, NOT the image-model selector.
    const cmd = createAgyCommand(job.provider_spec.binary, args, { env });
    job.state = 'running'; job.worker_pid = process.pid; job.heartbeat_at = new Date().toISOString(); saveJob(dir, job);
    child = spawn(cmd.cmd, cmd.args, { cwd: path.join(dir, 'workspace'), env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', spawnError;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const stop = why => {
      if (reason) return; reason = why;
      if (child.exitCode === null) child.kill();
      killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
    };
    child.stdout.on('data', data => { if (reason) return; stdout += data; if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) { stdout = ''; stop('stream_limit'); } });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') stop('stdin_error'); });
    const exited = new Promise(resolve => {
      child.once('error', e => { spawnError = e; resolve({ code: null }); });
      child.once('close', code => resolve({ code }));
    });
    deadline = setTimeout(() => stop('deadline'), (job.request.timeout + 30) * 1000);
    cancelTimer = setInterval(() => { if (fs.existsSync(path.join(dir, 'cancel.requested'))) stop('cancel_requested'); }, 100);
    heartbeat = setInterval(() => { job.heartbeat_at = new Date().toISOString(); try { saveJob(dir, job); } catch { stop('storage_error'); } }, 3000);
    child.stdin.end(cmd.input);
    const { code } = await exited;
    if (spawnError) throw mediaError('AGY_START', spawnError.message);
    if (reason) throw mediaError(reason === 'cancel_requested' ? 'CANCELED' : 'NATIVE_ATTENTION', `Native image run stopped (${reason}). Any remote image request may still finish; no regeneration attempted.`);
    const payload = parseStreamResult(stdout);
    if (!payload) throw mediaError('NO_NATIVE_RESULT', 'AGY emitted no terminal result.');
    atomicJSON(path.join(dir, 'native-result.json'), { payload, exit: code });
    job.candidates = discoverNativeCandidate(dir, job); job.state = 'ready'; job.error = null;
  } catch (e) { job.state = e.code === 'CANCELED' ? 'canceled' : 'needs_attention'; job.error = { code: e.code || 'NATIVE_ERROR', message: e.message }; }
  finally {
    clearInterval(heartbeat); clearInterval(cancelTimer); clearTimeout(deadline); clearTimeout(killTimer);
    job.worker_finished_at = new Date().toISOString(); job.remote_generation_stop_confirmed = false;
    saveJob(dir, job);
  }
}
