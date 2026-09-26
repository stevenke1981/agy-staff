#!/usr/bin/env node
/** Unified image/video/music CLI. Generation requires an explicit asset ID and prompt. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { PROVIDERS, mediaRoot, loadConfig, assetName, fileHash, plainPath, privateDir, readJSON, atomicJSON,
  withLease, jobDirectory, readJob, summarize, mediaError } from './media-core.mjs';
import { executableSpec, withBridge } from './media-mcp.mjs';
import { toolAvailable, runBinary } from './media-artifacts.mjs';
import { providerSpec, submitMedia, observeMedia, waitMedia, collectMedia, cancelMedia } from './media-service.mjs';
import { nativeWorker } from './media-native.mjs';
import { resolveAgyBinary } from './codex-platform.mjs';

const VALUES = new Set(['asset-id', 'provider', 'prompt', 'prompt-file', 'output-dir', 'reference', 'duration', 'bpm', 'vocals', 'lyrics-file', 'preset', 'audio-format', 'tab-id', 'timeout', 'wait-seconds', 'candidate-index', 'download-mode', 'account', 'model', 'gemini-bin', 'grok-bin', 'chatgpt-bin', 'agy-bin', 'ffmpeg', 'ffprobe']);
const BOOLS = new Set(['dry-run', 'collect', 'auto-detect']);
export function parseMediaOptions(argv) {
  const [command = 'help', ...raw] = argv; const opts = { command, reference: [] };
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i]; if (!token.startsWith('--')) throw mediaError('ARGUMENT', `Unexpected positional argument: ${token}`);
    const key = token.slice(2);
    if (!VALUES.has(key) && !BOOLS.has(key)) throw mediaError('ARGUMENT', `Unknown media option: ${token}`);
    if (key !== 'reference' && key in opts) throw mediaError('ARGUMENT', `Duplicate ${token}.`);
    if (BOOLS.has(key)) opts[key] = true;
    else {
      const value = raw[++i]; if (value === undefined || value === '') throw mediaError('ARGUMENT', `Missing value for ${token}.`);
      if (key === 'reference') opts.reference.push(value); else opts[key] = value;
    }
  }
  return opts;
}
function only(opts, allowed) {
  for (const [key, value] of Object.entries(opts)) if (key !== 'command' && !(key === 'reference' && value.length === 0) && !allowed.includes(key)) throw mediaError('ARGUMENT', `${opts.command} does not accept --${key}.`);
}
export function seconds(value, defaultValue, { min = 1, max = 7200 } = {}) {
  if (value === undefined) return defaultValue;
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(String(value));
  const n = m ? Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] || 's']) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw mediaError('DURATION', `Duration must be ${min}–${max} seconds (s/m/h accepted).`);
  return n;
}
function integer(value, min, max, key) {
  const n = Number(value); if (!/^\d+$/.test(String(value)) || !Number.isInteger(n) || n < min || n > max) throw mediaError('ARGUMENT', `${key} must be an integer from ${min} to ${max}.`); return n;
}
function readText(file) {
  const full = plainPath(file), stat = fs.statSync(full);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw mediaError('PROMPT_FILE', 'Prompt/lyrics must be a regular UTF-8 text file under 1 MiB.');
  return fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '').trim();
}
export function buildMediaRequest(opts, cwd = process.cwd()) {
  only(opts, ['asset-id', 'provider', 'prompt', 'prompt-file', 'output-dir', 'reference', 'duration', 'bpm', 'vocals', 'lyrics-file', 'preset', 'audio-format', 'tab-id', 'timeout', 'wait-seconds', 'collect', 'dry-run', 'account', 'model']);
  const kind = opts.command, id = assetName(opts['asset-id']);
  const provider = opts.provider || (kind === 'image' ? 'agy-native' : 'gemini-bridge');
  if (!PROVIDERS[provider]?.kinds.includes(kind)) throw mediaError('UNSUPPORTED_CAPABILITY', `${provider} has no verified ${kind} adapter. No fallback was attempted.`);
  if (opts.account && (provider !== 'agy-native' || opts.account !== 'native')) throw mediaError('MEDIA_ACCOUNT', 'Media uses the current native AGY login or enabled browser profile; coding account-pool rotation is not a verified media route.');
  if (opts.model && provider !== 'agy-native') throw mediaError('MODEL_SELECTION', 'Bridge model selection is controlled by the website. No unverified model flag is sent.');
  if (opts['tab-id'] && provider === 'agy-native') throw mediaError('ARGUMENT', 'Native AGY does not use a browser tab_id.');
  if ((opts.prompt !== undefined) === (opts['prompt-file'] !== undefined)) throw mediaError('PROMPT', 'Use exactly one --prompt or --prompt-file.');
  const original = (opts.prompt !== undefined ? opts.prompt : readText(path.resolve(cwd, opts['prompt-file']))).trim();
  if (!original) throw mediaError('PROMPT', 'Prompt must not be empty.');
  if (kind !== 'music' && ['bpm', 'vocals', 'lyrics-file', 'preset', 'audio-format'].some(k => opts[k] !== undefined)) throw mediaError('ARGUMENT', 'Music options apply only to music generation.');
  if (kind === 'image' && opts.duration) throw mediaError('ARGUMENT', 'An image has no requested playback duration.');
  const duration = opts.duration ? seconds(opts.duration, null) : null;
  const bpm = opts.bpm ? integer(opts.bpm, 20, 300, 'BPM') : null;
  const vocals = kind === 'music' ? opts.vocals || 'instrumental' : null;
  if (vocals && !['instrumental', 'sung'].includes(vocals)) throw mediaError('VOCALS', 'Use instrumental or sung.');
  if (opts['lyrics-file'] && vocals !== 'sung') throw mediaError('LYRICS', 'Explicit lyrics require --vocals sung.');
  if (opts.preset && opts.preset !== 'night-lamp') throw mediaError('PRESET', 'Available preset: night-lamp.');
  const audioFormat = kind === 'music' ? opts['audio-format'] || 'wav' : null;
  if (audioFormat && !['wav', 'original'].includes(audioFormat)) throw mediaError('AUDIO_FORMAT', 'Use wav or original.');
  const parts = [original];
  if (kind === 'image') parts.push('Produce exactly one actual raster image, not a collage, code, prompt-only response or variants.');
  if (duration) parts.push(`Requested duration: approximately ${duration} seconds; do not claim exact timing without measurement.`);
  if (kind === 'music') {
    parts.push('Generate an actual music track, not a spoken explanation, read-aloud response, cover image alone, or lyrics alone.');
    parts.push(vocals === 'instrumental' ? 'Instrumental only. No vocals, no singing, no speech, no lyrics.' : 'Generate a musical arrangement with sung vocals, not text-to-speech.');
    if (bpm) parts.push(`Target tempo: ${bpm} BPM.`);
    if (opts.preset === 'night-lamp') parts.push('Night Lamp storytelling accompaniment: restrained traditional Chinese guqin and xiao, low dynamics, sparse arrangement, room for narration, no abrupt drums.');
    if (opts['lyrics-file']) parts.push('User-provided lyrics:\n' + readText(path.resolve(cwd, opts['lyrics-file'])));
  }
  const prompt = parts.join('\n\n');
  if ([...prompt].length > 100000 || prompt.includes('\0')) throw mediaError('PROMPT_SIZE', 'Final prompt exceeds 100000 characters or contains NUL.');
  const references = opts.reference.map(file => {
    const p = plainPath(path.resolve(cwd, file)); const stat = fs.statSync(p);
    if (!stat.isFile() || !/\.(png|jpe?g|webp)$/i.test(p) || stat.size === 0 || stat.size > 16 * 1024 * 1024) throw mediaError('REFERENCE', 'References must be PNG/JPEG/WebP regular files up to 16 MiB. Audio/video reference uploads are not supported by the inspected bridges.');
    return { path: p, sha256: fileHash(p) };
  });
  if (references.length > PROVIDERS[provider].references) throw mediaError('REFERENCE_LIMIT', `Too many references for ${provider}.`);
  return { asset_id: id, kind, provider, source_prompt: original, prompt, references,
    output_dir: plainPath(path.resolve(cwd, opts['output-dir'] || 'assets')), duration, bpm, vocals, audio_format: audioFormat,
    model: opts.model || null, tab_id: opts['tab-id'] ? integer(opts['tab-id'], 1, 2147483647, 'tab-id') : null,
    timeout: seconds(opts.timeout, 1800, { min: 30, max: 7200 }) };
}
export function discoverBridgePaths(env = process.env) {
  const configHome = env.APPDATA || env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'); const result = {};
  for (const [key, folder, version, stem, homeEnv] of [
    ['geminiBin', 'GeminiWebBridge', 'v1', 'gwb', 'GWB_HOME'], ['grokBin', 'GrokWebBridge', 'v1', 'grwb', 'GRWB_HOME'], ['chatgptBin', 'ChatGPTWebBridge', 'v2', 'cwb', 'CWB_HOME'],
  ]) {
    const file = path.join(env[homeEnv] || path.join(configHome, folder, version), 'config.json');
    if (!fs.existsSync(file)) continue;
    // Only retain install_root. Never copy the Bridge's private token or port into our config/logs.
    const installRoot = readJSON(file).install_root;
    if (typeof installRoot !== 'string' || !path.isAbsolute(installRoot)) continue;
    const binary = process.platform === 'win32' ? path.join(installRoot, stem + '.exe') : path.join(installRoot, 'bin', stem);
    if (fs.existsSync(binary)) result[key] = plainPath(binary);
  }
  return result;
}
export async function configureMedia(root, opts) {
  only(opts, ['gemini-bin', 'grok-bin', 'chatgpt-bin', 'agy-bin', 'ffmpeg', 'ffprobe', 'auto-detect']);
  return withLease(root, async () => {
    const config = loadConfig(root);
    if (opts['auto-detect']) Object.assign(config, discoverBridgePaths());
    for (const [flag, key] of Object.entries({ 'gemini-bin': 'geminiBin', 'grok-bin': 'grokBin', 'chatgpt-bin': 'chatgptBin', 'agy-bin': 'agyBin', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })) {
      if (opts[flag]) { executableSpec(opts[flag]); config[key] = /[/\\]/.test(opts[flag]) ? path.resolve(opts[flag]) : opts[flag]; }
    }
    atomicJSON(path.join(root, 'config.json'), config);
    return { configured: true, file: path.join(root, 'config.json'), providers: Object.keys(PROVIDERS).filter(p => p === 'agy-native' || config[PROVIDERS[p].config]),
      generation_sent: false, global_agent_config_changed: false, account_logins_changed: false };
  });
}
export async function mediaDoctor(config, provider) {
  const technical = { ffmpeg: toolAvailable(config.ffmpeg), ffprobe: toolAvailable(config.ffprobe) };
  const providers = {};
  for (const name of provider ? [provider] : Object.keys(PROVIDERS)) {
    try {
      const spec = providerSpec(name, config);
      if (name === 'agy-native') {
        const text = runBinary(resolveAgyBinary(spec.binary), ['--help'], { timeout: 10000, includeStderr: true });
        providers[name] = { available: /--input-format/.test(text) && /stream-json/.test(text), native_image_tool_runtime: 'requires live image job + hook receipts', generation_sent: false };
      } else providers[name] = await withBridge(spec, spec.server, async client => {
        const status = await client.call('bridge_status', {});
        return { available: status.connected === true && !status.storage_fault, server: client.info,
          kinds: PROVIDERS[name].kinds.filter(k => client.tools.has(`${spec.prefix}_generate_${k}`)), generation_sent: false };
      });
    } catch (e) { providers[name] = { available: false, code: e.code || 'UNAVAILABLE', message: e.message, generation_sent: false }; }
  }
  return { technical, providers, generation_sent: false, live_generation_verified: false };
}
export const HELP = `AGY Staff media (explicit tasks only)
  media configure --auto-detect [--gemini-bin PATH] [--grok-bin PATH] [--chatgpt-bin PATH] [--agy-bin PATH] [--ffmpeg PATH] [--ffprobe PATH]
  media doctor [--provider agy-native|gemini-bridge|grok-bridge|chatgpt-bridge]
  image|video|music --asset-id ID --prompt-file UTF8_FILE [--provider NAME] [--output-dir PATH]
    [--reference PNG/JPEG/WebP ...] [--duration 30s] [--timeout 30m] [--wait-seconds 120 --collect] [--dry-run]
  music additionally: --vocals instrumental|sung --lyrics-file FILE --bpm 70 --preset night-lamp --audio-format wav|original
  media status|resume|cancel --asset-id ID
  media wait --asset-id ID [--timeout 10m] [--collect] [--candidate-index N]
  media collect --asset-id ID [--candidate-index N] [--download-mode original|source|rendered]
Native AGY supports image only here; video/music use the configured Web Bridge.
Same asset ID never resubmits. No hidden provider/account/model fallback. Resume only observes.
Downloads must complete and decode before collected. WAV conversion preserves the original.
`;
export async function mediaMain(argv = process.argv.slice(2)) {
  if (argv[0] === 'media') argv = argv.slice(1);
  if (['help', '--help'].includes(argv[0]) || !argv.length) { console.log(HELP); return 0; }
  const opts = parseMediaOptions(argv), root = mediaRoot(); let result;
  if (opts.command === 'configure') result = await configureMedia(root, opts);
  else if (opts.command === 'doctor') { only(opts, ['provider']); result = await mediaDoctor(loadConfig(root), opts.provider); }
  else if (opts.command === '_native-worker') { only(opts, ['asset-id']); await nativeWorker(jobDirectory(root, opts['asset-id'])); return 0; }
  else if (['image', 'video', 'music'].includes(opts.command)) {
    const request = buildMediaRequest(opts);
    if (opts['dry-run']) { console.log(JSON.stringify({ generation_sent: false, request, intended_tool: request.provider === 'agy-native' ? 'generate_image' : `${PROVIDERS[request.provider].prefix}_generate_${request.kind}` }, null, 2)); return 0; }
    result = await submitMedia(root, request, loadConfig(root));
    if (opts['wait-seconds']) result = await waitMedia(root, request.asset_id, { timeout: seconds(opts['wait-seconds'], 120), collect: opts.collect === true });
    else if (opts.collect && result.state === 'ready') result = await collectMedia(root, request.asset_id);
  } else if (['status', 'resume', 'wait', 'collect', 'cancel'].includes(opts.command)) {
    only(opts, opts.command === 'wait' ? ['asset-id', 'timeout', 'collect', 'candidate-index', 'download-mode'] : opts.command === 'collect' ? ['asset-id', 'candidate-index', 'download-mode'] : ['asset-id']);
    const id = assetName(opts['asset-id']);
    const candidateIndex = opts['candidate-index'] !== undefined ? integer(opts['candidate-index'], 0, 10000, 'candidate-index') : undefined;
    const downloadMode = opts['download-mode'] || 'original'; if (!['original', 'source', 'rendered'].includes(downloadMode)) throw mediaError('DOWNLOAD_MODE', 'Unknown download mode.');
    if (opts.command === 'status') result = await observeMedia(root, id);
    if (opts.command === 'resume') result = await observeMedia(root, id, { resume: true });
    if (opts.command === 'wait') result = await waitMedia(root, id, { timeout: seconds(opts.timeout, 120), collect: opts.collect === true, candidateIndex, downloadMode });
    if (opts.command === 'collect') result = await collectMedia(root, id, { candidateIndex, downloadMode });
    if (opts.command === 'cancel') result = await cancelMedia(root, id);
  } else throw mediaError('COMMAND', 'Unknown media command. Run media help.');
  console.log(JSON.stringify(result.request ? { ...summarize(result), wait_expired: result.wait_expired === true } : result, null, 2));
  if (result.wait_expired) return 2;
  if (result.state === 'failed' || result.state === 'needs_attention') return 3;
  if (result.state === 'canceled' || result.state === 'cancel_requested') return 4;
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await mediaMain(); }
  catch (e) { console.error(JSON.stringify({ error: { code: e.code || 'MEDIA_ERROR', message: e.message }, generation_retried: false })); process.exitCode = 1; }
}
