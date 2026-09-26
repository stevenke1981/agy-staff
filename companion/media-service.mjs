/** Media lifecycle: prepare -> one submission -> observe -> verified artifact collection. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, createJob, digest, fileHash, hasJob, jobDirectory, readJob, readJSON, saveJob,
  mediaError, plainPath, privateDir, withLease, sleep } from './media-core.mjs';
import { executableSpec, withBridge } from './media-mcp.mjs';
import { toolAvailable, publishArtifact } from './media-artifacts.mjs';
import { setupNativeWorkspace, discoverNativeCandidate } from './media-native.mjs';

export function providerSpec(provider, config) {
  const p = PROVIDERS[provider]; if (!p) throw mediaError('PROVIDER', 'Unknown media provider.');
  if (provider === 'agy-native') return { binary: config.agyBin, ffmpeg: config.ffmpeg, ffprobe: config.ffprobe };
  const binary = config[p.config]; if (!binary) throw mediaError('BRIDGE_NOT_CONFIGURED', `Configure ${provider} executable first with media configure.`);
  return { ...executableSpec(binary, ['mcp']), server: p.server, prefix: p.prefix, ffmpeg: config.ffmpeg, ffprobe: config.ffprobe };
}
const onBridge = (spec, fn) => withBridge(spec, spec.server, fn);
export function boundCandidates(remote, kind) {
  if (remote.status !== 'succeeded' || !remote.result?.completion_evidence || !Array.isArray(remote.result.messages)) throw mediaError('NO_BOUND_RESULT', 'A successful bound-turn media result is required.');
  const candidates = [];
  for (const message of remote.result.messages) {
    if (message.role !== 'assistant' || typeof message.message_id !== 'string') continue;
    if (kind === 'image') {
      for (const item of message.images || []) if (Number.isInteger(item.image_index) && item.width > 0 && item.height > 0) {
        candidates.push({ message_id: message.message_id, image_index: item.image_index, kind: 'image', asset_id: item.asset_id || null, width: item.width, height: item.height });
      }
    } else for (const item of message.media || []) {
      if (!item.ready || item.error || !Number.isInteger(item.media_index)) continue;
      if (kind === 'video' ? item.kind !== 'video' : !['audio', 'video'].includes(item.kind) || item.is_music !== true) continue;
      candidates.push({ message_id: message.message_id, media_index: item.media_index, kind: item.kind, asset_id: item.asset_id || null,
        is_music: item.is_music === true, duration_seconds: item.duration_seconds || null });
    }
  }
  if (!candidates.length) throw mediaError('MEDIA_MISSING', kind === 'music' ? 'No music-labelled playable audio/video in the bound result. Lyrics, covers and read-aloud audio are not music success.' : 'No matching actual media in the bound result.');
  return candidates;
}
function bindRemote(job, remote) {
  if (!/^[a-f0-9]{32}$/.test(remote?.id || '') || remote.request_id !== job.request_id || (job.upstream_job_id && remote.id !== job.upstream_job_id)) throw mediaError('JOB_BINDING', 'Remote result does not match this submitted request.');
  if (remote.payload?.prompt !== undefined && remote.payload.prompt !== job.request.prompt) throw mediaError('JOB_BINDING', 'Remote prompt differs from this submitted request.');
  if (remote.payload?.mode && remote.payload.mode !== job.request.kind) throw mediaError('JOB_BINDING', 'Remote media kind differs from the requested kind.');
  job.upstream_job_id = remote.id;
  if (Number.isInteger(remote.tab_id) && remote.tab_id > 0) job.tab_id = remote.tab_id;
  job.remote_status = remote.status;
  job.progress = { phase: remote.phase || null, observation_stale: remote.progress?.observation_stale ?? null,
    images_ready: remote.progress?.images_ready ?? null, videos_ready: remote.progress?.videos_ready ?? null,
    music_ready: remote.progress?.music_ready ?? null, last_observed_at: remote.progress?.received_at || null };
  if (job.state === 'collected') return job;
  if (remote.status === 'succeeded') {
    if (!job.download?.attempted) job.candidates = boundCandidates(remote, job.request.kind);
    if (!job.download?.attempted) job.state = 'ready';
    job.error = null;
  } else if (remote.status === 'cancelled') {
    job.state = 'canceled'; job.website_stop_confirmed = remote.result?.website_stop_confirmed === true;
  } else if (['failed', 'text_only', 'media_missing'].includes(remote.status)) {
    job.state = 'failed'; job.error = remote.error || { code: remote.status.toUpperCase(), message: 'The provider did not produce the requested media.' };
  } else if (remote.status === 'needs_attention' || remote.progress?.observation_stale === true) {
    job.state = 'needs_attention'; job.error = remote.error || { code: 'TRACKING_ATTENTION', message: 'Observation needs attention. Resume observation, never resubmit.' };
  } else job.state = 'submitted';
  return job;
}
function stagingReferences(inputDir, job) {
  if (!job.request.references.length) return [];
  if (!inputDir || !path.isAbsolute(inputDir)) throw mediaError('BRIDGE_INPUT', 'Bridge did not report an absolute input_dir.');
  const dir = privateDir(path.join(plainPath(inputDir), 'agy-staff', digest(job.request_id)));
  return job.request.references.map((ref, i) => {
    if (fileHash(ref.path) !== ref.sha256) throw mediaError('REFERENCE_CHANGED', 'Reference changed; no generation was sent.');
    const dest = path.join(dir, `ref-${i}${path.extname(ref.path).toLowerCase()}`);
    if (!fs.existsSync(dest)) fs.copyFileSync(ref.path, dest, fs.constants.COPYFILE_EXCL);
    if (fileHash(dest) !== ref.sha256) throw mediaError('REFERENCE_CHANGED', 'Staged reference is not the requested file.');
    return dest;
  });
}
function generationArgs(job, status) {
  const args = { request_id: job.request_id, prompt: job.request.prompt, timeout_seconds: job.request.timeout };
  if (job.request.tab_id) args.tab_id = job.request.tab_id;
  if (job.request.provider !== 'chatgpt-bridge') args.activation = 'auto';
  const refs = stagingReferences(status.input_dir, job); if (refs.length) args.attachment_paths = refs;
  return args;
}
function technicalPreflight(config) {
  if (!toolAvailable(config.ffprobe) || !toolAvailable(config.ffmpeg)) throw mediaError('FFMPEG_REQUIRED', 'FFmpeg and ffprobe are required to validate the real outputs. Configure their executable paths first. No media submitted.');
}
export async function submitMedia(root, request, config) {
  if (hasJob(root, request.asset_id)) {
    const prior = readJob(root, request.asset_id);
    if (prior.fingerprint !== digest(JSON.stringify(request))) throw mediaError('ASSET_CONFLICT', 'This asset ID already has different parameters; do not overwrite or regenerate it.');
    return prior; // Even after a timeout, the same ID NEVER triggers a second submission.
  }
  const destination = plainPath(path.join(request.output_dir, request.asset_id));
  if (fs.existsSync(destination)) throw mediaError('OUTPUT_EXISTS', 'Destination already exists. No generation was sent; preserve the existing files.');
  technicalPreflight(config);
  const spec = providerSpec(request.provider, config);
  if (request.provider === 'agy-native') {
    const { dir, job, existing } = createJob(root, request, spec); if (existing) return job;
    try {
      setupNativeWorkspace(dir, job);
      job.state = 'submitting'; job.may_have_submitted = true; saveJob(dir, job);
      const log = fs.openSync(path.join(dir, 'worker.log'), 'a', 0o600);
      try {
        const cli = fileURLToPath(new URL('./codex-media.mjs', import.meta.url));
        const child = spawn(process.execPath, [cli, '_native-worker', '--asset-id', job.asset_id], {
          env: { ...process.env, AGY_STAFF_MEDIA_DIR: root }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', log, log], shell: false,
        });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      } finally { fs.closeSync(log); }
      return readJob(root, job.asset_id);
    } catch (e) { job.state = 'needs_attention'; job.error = { code: e.code || 'NATIVE_START', message: e.message }; return saveJob(dir, job); }
  }
  return onBridge(spec, async client => {
    const tool = `${spec.prefix}_generate_${request.kind}`;
    if (!client.tools.has(tool)) throw mediaError('TOOL_UNAVAILABLE', `${tool} is unavailable. No media submitted.`);
    const status = await client.call('bridge_status', {});
    if (status.connected !== true || status.storage_fault) throw mediaError('BRIDGE_OFFLINE', 'Bridge is not ready. No generation was sent.');
    const { dir, job, existing } = createJob(root, request, spec); if (existing) return job;
    try {
      const args = generationArgs(job, status); client.assertTool(tool, args);
      job.submitted_arguments = args; job.state = 'submitting'; job.may_have_submitted = true; saveJob(dir, job);
      const remote = await client.call(tool, args); bindRemote(job, remote);
    } catch (e) { job.state = 'needs_attention'; job.error = { code: e.code || 'SUBMISSION_UNCERTAIN', message: e.message }; }
    return saveJob(dir, job);
  });
}
async function recoverRemote(client, job) {
  const listing = await client.call(`${job.provider_spec.prefix}_jobs`, { limit: 100 });
  const matches = (listing.jobs || []).filter(j => j.request_id === job.request_id);
  if (matches.length !== 1) throw mediaError('UNKNOWN_SUBMISSION', 'Cannot uniquely recover the existing request from recent jobs. Inspect the original bridge/tab; this command will not resubmit.');
  job.upstream_job_id = matches[0].id;
}
export async function observeMedia(root, id, { resume = false, waitSeconds = 0 } = {}) {
  const dir = jobDirectory(root, id); const original = readJob(root, id);
  if (original.state === 'collected') return original;
  if (original.request.provider === 'agy-native') {
    // The worker is the only ledger writer while alive. Cancellation uses a separate sentinel.
    if (original.worker_pid && !original.worker_finished_at) {
      let alive = true; try { process.kill(original.worker_pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
      if (alive) return original;
    }
    if (resume && fs.existsSync(path.join(dir, 'native-result.json'))) return withLease(dir, async () => {
      const job = readJob(root, id);
      try { job.candidates = discoverNativeCandidate(dir, job); job.state = 'ready'; job.error = null; }
      catch (e) { job.state = 'needs_attention'; job.error = { code: e.code || 'NATIVE_RESULT', message: e.message }; }
      return saveJob(dir, job);
    });
    if (!original.worker_finished_at && original.worker_pid && ['running', 'submitting'].includes(original.state)) return withLease(dir, async () => {
      const job = readJob(root, id); job.state = 'needs_attention';
      job.error = { code: 'NATIVE_INTERRUPTED', message: 'Native worker is no longer alive. Inspect/resume existing receipts; never regenerate automatically.' };
      return saveJob(dir, job);
    });
    return original;
  }
  return withLease(dir, () => onBridge(original.provider_spec, async client => {
    const job = readJob(root, id);
    try {
      if (!job.upstream_job_id) {
        if (!resume) return job;
        await recoverRemote(client, job);
      }
      const name = `${job.provider_spec.prefix}_${resume ? 'resync' : 'job'}`;
      const args = { job_id: job.upstream_job_id }; if (!resume) args.wait_seconds = Math.max(0, Math.min(25, waitSeconds));
      bindRemote(job, await client.call(name, args));
    } catch (e) { job.state = 'needs_attention'; job.error = { code: e.code || 'OBSERVATION', message: e.message }; }
    return saveJob(dir, job);
  }));
}
export async function collectMedia(root, id, { candidateIndex, downloadMode = 'original' } = {}) {
  const dir = jobDirectory(root, id);
  return withLease(dir, async () => {
    const job = readJob(root, id); if (job.state === 'collected') return job;
    if (!job.candidates.length || !['ready', 'downloading', 'needs_attention'].includes(job.state)) throw mediaError('NOT_READY', 'Wait for the bound media result before collection.');
    const index = candidateIndex ?? job.download?.candidate_index ?? (job.candidates.length === 1 ? 0 : undefined);
    if (!Number.isInteger(index) || !job.candidates[index]) throw mediaError('CHOOSE_CANDIDATE', 'Several outputs exist. Inspect candidates and explicitly select --candidate-index N; no arbitrary newest/first output is selected.');
    const candidate = job.candidates[index]; let source;
    if (job.request.provider === 'agy-native') source = candidate.source;
    else {
      await onBridge(job.provider_spec, async client => {
        if (job.download?.attempted && job.download.candidate_index !== index) throw mediaError('DOWNLOAD_CONFLICT', 'A different candidate download was already claimed.');
        const prefix = job.provider_spec.prefix;
        if (!job.download?.attempted) {
          const image = job.request.kind === 'image';
          const tool = `${prefix}_download_${image ? 'image' : 'media'}`;
          const args = { tab_id: job.tab_id, message_id: candidate.message_id, mode: downloadMode };
          if (image) args.image_index = candidate.image_index;
          else { args.media_index = candidate.media_index; args.format = candidate.kind === 'audio' ? 'audio' : 'video'; }
          if (candidate.asset_id && client.tools.get(tool)?.inputSchema?.properties?.asset_id) args.asset_id = candidate.asset_id;
          client.assertTool(tool, args);
          job.download = { attempted: true, candidate_index: index, args, at: new Date().toISOString() };
          job.state = 'downloading'; saveJob(dir, job); // Durable claim BEFORE any download click.
          try {
            const result = await client.call(tool, args);
            if (!Number.isInteger(result.download_id) || result.download_id < 0) throw mediaError('UNKNOWN_DOWNLOAD', 'Download response has no valid Chrome download id.');
            job.download.id = result.download_id; saveJob(dir, job);
          } catch (e) {
            job.state = 'needs_attention'; job.error = { code: e.code || 'DOWNLOAD_UNCERTAIN', message: e.message }; saveJob(dir, job); throw e;
          }
        }
        if (job.download.id === undefined) throw mediaError('UNKNOWN_DOWNLOAD', 'A download click may have happened, but its id is unknown. Inspect the existing browser download; no second click was attempted.');
        const status = await client.call(`${prefix}_download_status`, { download_id: job.download.id });
        job.download.status = status.state;
        if (status.state === 'in_progress') { job.state = 'downloading'; saveJob(dir, job); return; }
        if (status.state !== 'complete' || status.exists === false || status.error || status.mime_matches_expected === false) throw mediaError('DOWNLOAD_FAILED', 'Download is not a complete matching local file.');
        if (status.danger && !['safe', 'allowlistedByPolicy', 'deepScannedSafe'].includes(status.danger)) throw mediaError('DOWNLOAD_DANGER', 'Chrome has not accepted the download as safe. Do not override browser protection.');
        if (typeof status.filename !== 'string' || !path.isAbsolute(status.filename)) throw mediaError('DOWNLOAD_PATH', 'Bridge did not return an absolute local download filename.');
        source = plainPath(status.filename); job.download.source = source; saveJob(dir, job);
      });
    }
    if (!source) return job;
    try {
      const published = publishArtifact(job, source, job.provider_spec);
      Object.assign(job, published, { state: 'collected', error: null }); return saveJob(dir, job);
    } catch (e) { job.state = 'needs_attention'; job.error = { code: e.code || 'COLLECTION', message: e.message }; saveJob(dir, job); throw e; }
  });
}
export async function waitMedia(root, id, { timeout = 120, collect = false, candidateIndex, downloadMode } = {}) {
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    let job = await observeMedia(root, id, { waitSeconds: Math.min(20, Math.max(0, Math.floor((deadline - Date.now()) / 1000))) });
    if (['collected', 'failed', 'canceled', 'needs_attention'].includes(job.state)) return job;
    if (['ready', 'downloading'].includes(job.state)) {
      if (!collect) return job;
      job = await collectMedia(root, id, { candidateIndex, downloadMode }); if (job.state !== 'downloading') return job;
    }
    if (Date.now() >= deadline) return { ...job, wait_expired: true }; // Worker/site keeps running; never restart it.
    await sleep(250);
  }
}
export async function cancelMedia(root, id) {
  const dir = jobDirectory(root, id); let job = readJob(root, id);
  if (job.state === 'collected' || job.state === 'canceled') return job;
  if (job.request.provider === 'agy-native') {
    fs.writeFileSync(path.join(dir, 'cancel.requested'), new Date().toISOString(), { mode: 0o600 });
    return { ...job, state: 'cancel_requested', website_stop_confirmed: false }; // Don't race the live worker's ledger.
  }
  return withLease(dir, () => onBridge(job.provider_spec, async client => {
    job = readJob(root, id);
    if (job.cancel_attempted) return job;
    if (!job.upstream_job_id) throw mediaError('UNKNOWN_SUBMISSION', 'Recover the existing job id before canceling.');
    job.cancel_attempted = true; saveJob(dir, job);
    try { bindRemote(job, await client.call(`${job.provider_spec.prefix}_cancel_job`, { job_id: job.upstream_job_id })); }
    catch (e) { job.state = 'needs_attention'; job.error = { code: e.code || 'CANCEL_UNCERTAIN', message: e.message }; job.website_stop_confirmed = false; }
    return saveJob(dir, job);
  }));
}
