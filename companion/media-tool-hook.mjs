#!/usr/bin/env node
/** Per-job image-only hook. Installed ONLY inside the generated media workspace. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJSON, plainPath, atomicJSON } from './media-core.mjs';

export function handleMediaHook(phase, input, dir) {
  plainPath(dir);
  const request = readJSON(path.join(dir, 'native-request.json'));
  const tool = input?.toolCall;
  if (phase === 'pre') {
    const deny = reason => ({ decision: 'deny', reason });
    if (tool?.name !== 'generate_image') return deny('This explicit media job permits only generate_image. No shell, browser, subagent, file edit or permission change.');
    if (fs.existsSync(path.join(dir, 'cancel.requested'))) return deny('This media job has been canceled.');
    if (tool.args?.ImageName !== request.asset_id || typeof tool.args?.Prompt !== 'string' || !tool.args.Prompt.trim()) return deny('Use the exact requested ImageName and a nonempty image prompt.');
    const refs = tool.args.ImagePaths || [];
    if (!Array.isArray(refs) || refs.length !== request.references.length || refs.some((p, i) => p !== request.references[i])) return deny('Use only the explicitly staged reference images, in order.');
    try { fs.writeFileSync(path.join(dir, 'image-tool.claim'), JSON.stringify({ at: new Date().toISOString(), conversation_id: input.conversationId || null, tool: 'generate_image' }), { flag: 'wx', mode: 0o600 }); }
    catch { return deny('Image generation was already claimed (or the durable claim failed). Never retry or create variants automatically.'); }
    return { decision: 'allow', reason: 'The user explicitly requested this one image. Single durable claim accepted.' };
  }
  if (phase === 'post') {
    if (tool?.name !== 'generate_image' || !fs.existsSync(path.join(dir, 'image-tool.claim'))) return {};
    if (fs.existsSync(path.join(dir, 'image-tool.receipt.json'))) return {};
    atomicJSON(path.join(dir, 'image-tool.receipt.json'), { tool: 'generate_image', image_name: tool.args?.ImageName,
      error: String(input.error || ''), artifact_directory: input.artifactDirectoryPath || null,
      conversation_id: input.conversationId || null, at: new Date().toISOString() });
    return {};
  }
  throw new Error('Unknown media hook phase.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const response = handleMediaHook(process.argv[2], input, process.env.AGY_STAFF_MEDIA_JOB_DIR || '');
    console.log(JSON.stringify(response));
  } catch {
    // Do not allow a tool when the hook cannot verify its local authorization receipt.
    console.log(JSON.stringify({ decision: 'deny', reason: 'Media job hook could not verify its durable authorization.' })); process.exitCode = 2;
  }
}
