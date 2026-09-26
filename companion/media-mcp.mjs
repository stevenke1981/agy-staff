/** Minimal bounded stdio MCP client for the three inspected local Web Bridges. */
import { spawn } from 'node:child_process';
import { mediaError } from './media-core.mjs';

export function executableSpec(binary, args = []) {
  if (typeof binary !== 'string' || !binary || /[\r\n\0]/.test(binary) || /\.(cmd|bat|ps1)$/i.test(binary)) throw mediaError('BINARY', 'Use one native executable or Node entrypoint, not a shell command/shim.');
  return /\.(mjs|cjs|js)$/i.test(binary) ? { command: process.execPath, args: [binary, ...args] } : { command: binary, args };
}
export function validateSchema(value, schema, label = 'arguments') {
  if (!schema || typeof schema !== 'object') throw mediaError('SCHEMA', 'Missing MCP input schema.');
  const fail = message => { throw mediaError('SCHEMA', `${label}: ${message}`); };
  if (schema.enum && !schema.enum.includes(value)) fail('unsupported value');
  switch (schema.type) {
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('object required');
      for (const k of schema.required || []) if (!(k in value)) fail(`missing ${k}`);
      for (const [k, v] of Object.entries(value)) {
        if (!schema.properties?.[k]) { if (schema.additionalProperties === false) fail(`unsupported field ${k}`); }
        else validateSchema(v, schema.properties[k], `${label}.${k}`);
      }
      break;
    case 'array':
      if (!Array.isArray(value)) fail('array required');
      if (value.length > (schema.maxItems ?? Infinity) || value.length < (schema.minItems ?? 0)) fail('invalid item count');
      if (schema.items) value.forEach((v, i) => validateSchema(v, schema.items, `${label}[${i}]`));
      break;
    case 'string':
      if (typeof value !== 'string') fail('string required');
      if ([...value].length < (schema.minLength ?? 0) || [...value].length > (schema.maxLength ?? Infinity)) fail('length out of range');
      break;
    case 'integer': case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail('finite number required');
      if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail('number out of range');
      break;
    case 'boolean': if (typeof value !== 'boolean') fail('boolean required'); break;
    default: throw mediaError('SCHEMA', `Unrecognized MCP schema type: ${schema.type}`);
  }
}
export class BridgeClient {
  constructor(spec, { env = process.env, timeout = 35000, maxFrame = 8 * 1024 * 1024 } = {}) {
    this.pending = new Map(); this.seq = 0; this.timeout = timeout; this.maxFrame = maxFrame; this.buffer = ''; this.closed = false;
    this.child = spawn(spec.command, spec.args, { env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.on('data', () => {}); // Never forward arbitrary server logs/credentials.
    this.child.on('error', e => this.fail(mediaError('MCP_START', e.message)));
    this.child.on('exit', () => this.fail(mediaError('MCP_EXIT', 'Bridge MCP process exited; do not resend generation.')));
    this.child.stdin.on('error', e => this.fail(mediaError('MCP_INPUT', e.message)));
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > this.maxFrame) return this.fail(mediaError('MCP_SIZE', 'MCP frame exceeded the bounded size.'));
      let at;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        let v; try { v = JSON.parse(line); } catch { this.fail(mediaError('MCP_JSON', 'Invalid MCP JSON.')); return; }
        if (v?.jsonrpc !== '2.0') { this.fail(mediaError('MCP_PROTOCOL', 'Expected JSON-RPC 2.0.')); return; }
        if (v.method) {
          if (v.id !== undefined) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: v.id, error: { code: -32601, message: 'Client-side actions are unsupported.' } }) + '\n');
          continue; // Notifications are evidence, never executable instructions.
        }
        const p = this.pending.get(v.id); if (!p) continue;
        this.pending.delete(v.id); clearTimeout(p.timer);
        if (v.error) p.reject(mediaError('MCP_RPC', String(v.error.message).slice(0, 1000)));
        else p.resolve(v.result);
      }
    });
  }
  fail(error) { this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  request(method, params = {}, timeout = this.timeout) {
    if (this.closed) return Promise.reject(mediaError('MCP_CLOSED', 'MCP connection is unavailable.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(mediaError('MCP_TIMEOUT', 'MCP response timed out; submission/download may have happened. Do not repeat it.')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize(expectedServer) {
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agy-staff-media', version: '0.7.3-codex.3' } }, 10000);
    if (!['2025-06-18', '2025-03-26', '2024-11-05'].includes(init.protocolVersion) || init.serverInfo?.name !== expectedServer) throw mediaError('MCP_IDENTITY', 'Wrong/unsupported MCP server. No generation was sent.');
    this.info = init.serverInfo;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const response = await this.request('tools/list');
    if (!Array.isArray(response.tools) || response.nextCursor) throw mediaError('MCP_TOOLS', 'Unexpected/paginated tool listing for this bridge version.');
    this.tools = new Map(response.tools.map(t => [t.name, t])); return this;
  }
  assertTool(name, args) {
    const tool = this.tools?.get(name); if (!tool) throw mediaError('TOOL_UNAVAILABLE', `Bridge does not expose ${name}; no substitute tool was selected.`);
    validateSchema(args, tool.inputSchema);
  }
  async call(name, args) {
    this.assertTool(name, args);
    const result = await this.request('tools/call', { name, arguments: args });
    let value = result?.structuredContent?.data;
    if (value === undefined) {
      const texts = (result?.content || []).filter(c => c.type === 'text');
      if (texts.length !== 1) throw mediaError('MCP_RESULT', 'Expected one structured bridge result.');
      try { value = JSON.parse(texts[0].text); } catch { throw mediaError('MCP_RESULT', 'Bridge did not return structured JSON.'); }
    }
    if (result.isError) throw mediaError(value?.error?.code || 'BRIDGE_ERROR', String(value?.error?.message || 'Bridge reported failure.').slice(0, 1200));
    return value;
  }
  async close() {
    this.fail(mediaError('MCP_CLOSED', 'MCP session closed.'));
    this.child.stdin.end();
    if (this.child.exitCode === null) await Promise.race([new Promise(r => this.child.once('exit', r)), new Promise(r => setTimeout(r, 200))]);
    if (this.child.exitCode === null) this.child.kill(); // Only the MCP proxy, never Chrome/native host.
  }
}
export async function withBridge(spec, server, fn, options) {
  const client = new BridgeClient(spec, options);
  try { await client.initialize(server); return await fn(client); } finally { await client.close(); }
}
