/** Verify real downloaded media and publish a separate, non-overwriting asset bundle. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mediaError, plainPath, privateDir, atomicJSON, fileHash } from './media-core.mjs';
import { executableSpec } from './media-mcp.mjs';

export function runBinary(binary, args, { timeout = 120000, maxBuffer = 2 * 1024 * 1024, includeStderr = false } = {}) {
  const cmd = executableSpec(binary, args);
  const result = spawnSync(cmd.command, cmd.args, { encoding: 'utf8', timeout, maxBuffer, windowsHide: true, shell: false });
  if (result.error || result.status !== 0) throw mediaError('MEDIA_PROCESS', `${path.basename(binary)} failed: ${(result.error?.message || result.stderr || `exit ${result.status}`).slice(0, 1000)}`);
  return includeStderr ? `${result.stdout}\n${result.stderr}` : result.stdout;
}
export function toolAvailable(binary) { try { runBinary(binary, ['-version'], { timeout: 10000 }); return true; } catch { return false; } }
export function regularMedia(file) {
  plainPath(file); const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 ** 3) throw mediaError('MEDIA_FILE', 'Expected a nonempty regular media file, maximum 2 GiB.');
  return stat;
}
export function inspectMedia(file, kind, config) {
  regularMedia(file);
  let info;
  try { info = JSON.parse(runBinary(config.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', file])); }
  catch (e) { throw mediaError('INVALID_MEDIA', `Cannot inspect media: ${e.message}`); }
  const streams = info.streams || [], audio = streams.filter(s => s.codec_type === 'audio'), visual = streams.filter(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const duration = Number(info.format?.duration || audio[0]?.duration || visual[0]?.duration || 0);
  const imageCodec = ['png', 'mjpeg', 'webp'].includes(visual[0]?.codec_name);
  if (kind === 'image' && (visual.length !== 1 || !imageCodec || audio.length)) throw mediaError('WRONG_MEDIA_KIND', 'Image request did not produce a PNG/JPEG/WebP raster image.');
  if (kind === 'video' && (!visual.length || imageCodec || !Number.isFinite(duration) || duration <= 0)) throw mediaError('WRONG_MEDIA_KIND', 'A thumbnail/still image is not a video.');
  if (kind === 'music' && (!audio.length || !Number.isFinite(duration) || duration <= 0)) throw mediaError('WRONG_MEDIA_KIND', 'Music requires an actual playable audio stream, not cover art or lyrics.');
  // Local files only. Fully decode, not merely trust the extension or the browser's download state.
  runBinary(config.ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-protocol_whitelist', 'file,pipe', '-i', file, '-map', kind === 'music' ? '0:a:0' : '0:v:0', '-f', 'null', '-']);
  return { duration_seconds: duration > 0 ? duration : null, width: visual[0]?.width || null, height: visual[0]?.height || null,
    audio_streams: audio.length, video_streams: visual.length, sample_rate: audio[0]?.sample_rate ? Number(audio[0].sample_rate) : null,
    channels: audio[0]?.channels || null, codec: (kind === 'music' ? audio[0] : visual[0])?.codec_name || null,
    format: info.format?.format_name || null, technically_decoded: true, semantic_review_required: true };
}
function extension(info, kind, file) {
  if (kind === 'image') return { png: '.png', mjpeg: '.jpg', webp: '.webp' }[info.codec];
  const format = String(info.format);
  if (/mp3/.test(format)) return '.mp3';
  if (/wav/.test(format)) return '.wav';
  if (/flac/.test(format)) return '.flac';
  if (/ogg/.test(format)) return '.ogg';
  if (/mp4|mov/.test(format)) return '.mp4';
  if (/webm|matroska/.test(format)) return '.webm';
  if (/aac/.test(format)) return '.aac';
  throw mediaError('MEDIA_FORMAT', `Unrecognized media container for ${path.basename(file)}; do not relabel bytes as another format.`);
}
export function publishArtifact(job, source, config) {
  const { request } = job; const info = inspectMedia(source, request.kind, config); const originalHash = fileHash(source);
  const parent = privateDir(plainPath(request.output_dir)); const dest = plainPath(path.join(parent, request.asset_id));
  if (fs.existsSync(dest)) {
    // Recover a successful rename followed by a lost ledger update without duplicating/overwriting assets.
    const receiptFile = path.join(dest, 'metadata.json');
    if (!fs.existsSync(receiptFile)) throw mediaError('OUTPUT_EXISTS', 'Destination already exists and is not this completed asset bundle.');
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    if (receipt.fingerprint !== job.fingerprint || receipt.source_sha256 !== originalHash) throw mediaError('OUTPUT_EXISTS', 'Existing output belongs to different data.');
    if (receipt.schema !== 1 || receipt.asset_id !== request.asset_id || receipt.kind !== request.kind || !Array.isArray(receipt.files) || receipt.files.length !== 2 || new Set(receipt.files.map(f => f.name)).size !== 2 || !receipt.measured?.technically_decoded) throw mediaError('OUTPUT_MODIFIED', 'Invalid asset receipt.');
    for (const f of receipt.files) {
      if (path.basename(f.name) !== f.name || !/^[a-f0-9]{64}$/.test(f.sha256)) throw mediaError('OUTPUT_MODIFIED', 'Invalid asset receipt.');
      if (fileHash(plainPath(path.join(dest, f.name))) !== f.sha256) throw mediaError('OUTPUT_MODIFIED', 'Published artifact was modified.');
    }
    return { metadata: receiptFile, files: receipt.files.map(f => ({ ...f, path: path.join(dest, f.name) })), measured: receipt.measured };
  }
  const stage = path.join(parent, `.agy-${request.asset_id}-${randomUUID()}`); privateDir(stage);
  try {
    const ext = extension(info, request.kind, source); const rawName = `${request.asset_id}.source${ext}`;
    fs.copyFileSync(source, path.join(stage, rawName), fs.constants.COPYFILE_EXCL);
    if (fileHash(path.join(stage, rawName)) !== originalHash || fileHash(source) !== originalHash) throw mediaError('SOURCE_CHANGED', 'Source file changed during collection.');
    let outputName = `${request.asset_id}${ext}`; let measured = info;
    if (request.kind === 'music' && request.audio_format === 'wav') {
      outputName = `${request.asset_id}.wav`;
      runBinary(config.ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-n', '-protocol_whitelist', 'file,pipe', '-i', path.join(stage, rawName), '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', path.join(stage, outputName)]);
      measured = inspectMedia(path.join(stage, outputName), 'music', config);
    } else fs.copyFileSync(path.join(stage, rawName), path.join(stage, outputName), fs.constants.COPYFILE_EXCL);
    const files = [rawName, outputName].map(name => ({ name, sha256: fileHash(path.join(stage, name)), bytes: fs.statSync(path.join(stage, name)).size }));
    const receipt = { schema: 1, asset_id: request.asset_id, kind: request.kind, provider: request.provider, fingerprint: job.fingerprint,
      source_sha256: originalHash, account_route: request.provider === 'agy-native' ? 'current AGY login; not account-pool routing' : 'current enabled browser profile; not account-pool routing',
      upstream_job_id: job.upstream_job_id || null, requested: { duration_seconds: request.duration || null, bpm: request.bpm || null, vocals: request.vocals || null },
      measured, original: info, files, created_at: new Date().toISOString(),
      exact_duration_guaranteed: false, vocals_bpm_and_artistic_quality_verified: false,
      note: 'Original preserved. Music WAV is a local audio extraction/conversion, not a second generation, not a voice clone or a stem separation.' };
    atomicJSON(path.join(stage, 'metadata.json'), receipt);
    fs.writeFileSync(path.join(stage, 'prompt.txt'), request.prompt, { flag: 'wx', mode: 0o600 });
    // Job lease serializes this destination for this asset ID. Never remove another output directory.
    if (fs.existsSync(dest)) throw mediaError('OUTPUT_EXISTS', 'Output appeared during collection.');
    fs.renameSync(stage, dest);
    return { files: files.map(f => ({ ...f, path: path.join(dest, f.name) })), metadata: path.join(dest, 'metadata.json'), measured };
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
}
