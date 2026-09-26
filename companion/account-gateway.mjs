/** Gemini-compatible loopback router. Failover only before a response body is sent.
 * Retries one inference request, never a whole AGY job or a tool execution. */
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { availableAccounts, loadRegistry, recordOutcome } from './account-store.mjs';
import { startAccountProxy } from './account-proxy.mjs';
const MAX_BODY = 16 * 1024 * 1024;
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function validateRoute(raw, method) {
  const u = new URL(raw, 'http://127.0.0.1');
  if (!raw.startsWith('/') || raw.startsWith('//') || /%2f|%5c|%2e|\\/i.test(u.pathname)) throw new Error('Invalid API route.');
  if (!(method === 'GET' && /^\/(?:v1|v1beta)\/models(?:\/[a-zA-Z0-9._-]+)?$/.test(u.pathname)) &&
      !(method === 'POST' && /^\/v1beta\/models\/[a-zA-Z0-9._-]+:(?:generateContent|streamGenerateContent|countTokens)$/.test(u.pathname))) throw new Error('Only Gemini generation/model endpoints are enabled.');
  for (const key of u.searchParams.keys()) if (!['key', 'alt'].includes(key)) throw new Error('Unsupported query parameter.');
  u.searchParams.delete('key');
  return { path: u.pathname + u.search, model: u.pathname.match(/\/models\/([^/:]+)/)?.[1] || '*', key: new URL(raw, 'http://127.0.0.1').searchParams.get('key') };
}
async function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) throw new Error('Request too large.');
  const chunks = []; let total = 0;
  for await (const c of req) { total += c.length; if (total > MAX_BODY) throw new Error('Request too large.'); chunks.push(c); }
  return Buffer.concat(chunks);
}
function errorResponse(res, status, reason, retryAfter) {
  if (res.headersSent) { res.destroy(); return; }
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
  res.writeHead(status); res.end(JSON.stringify({ error: { code: status, message: reason, status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE' } }));
}
function upstreamRequest(session, route, method, body, signal) {
  return new Promise((resolve, reject) => {
    const req = http.request(session.baseURL + route.path, { method, signal, headers: {
      Authorization: `Bearer ${session.key}`, 'x-goog-api-key': session.key,
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': String(body.length) } }, response => { response.on('error', () => {}); resolve(response); });
    req.once('error', reject); req.end(body);
  });
}
export async function createAccountGateway({ root, wanted = 'auto', signal, startProxy = startAccountProxy, onEvent = () => {} }) {
  const s = loadRegistry(root);
  if (!s || (wanted !== 'auto' && !s.accounts.some(a => a.alias === wanted))) throw new Error('Account pool or selected alias does not exist.');
  const key = randomBytes(32).toString('hex'), controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let session = null, preferred = null, busy = false, idle = Promise.resolve(), settle, fatalStatus = null;
  combined.throwIfAborted();
  const sockets = new Set();
  const emit = (event, alias, status) => { try { onEvent({ event, alias, status, time: new Date().toISOString() }); } catch {} };
  const releaseSession = async () => { const old = session; session = null; if (old) await old.close(); };
  const server = http.createServer(async (req, res) => {
    let route;
    try { route = validateRoute(req.url, req.method); } catch { errorResponse(res, 404, 'API route is not enabled.'); return; }
    const authorization = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    if (req.headers.origin || !equal(authorization || req.headers['x-goog-api-key'] || route.key, key)) { errorResponse(res, 401, 'Local gateway authentication required.'); return; }
    if (fatalStatus) { errorResponse(res, fatalStatus, 'This job stopped account routing after an access restriction. Resolve it before starting a new task.'); return; }
    if (busy) { errorResponse(res, 503, 'This job already has an active model request.', 1); return; }
    busy = true; idle = new Promise(resolve => { settle = resolve; });
    const abort = new AbortController(), reqSignal = AbortSignal.any([combined, abort.signal, AbortSignal.timeout(15 * 60 * 1000)]);
    const disconnected = () => { if (!res.writableFinished) abort.abort(); };
    res.once('close', disconnected);
    try {
      const body = await readBody(req); reqSignal.throwIfAborted();
      const tried = [], max = wanted === 'auto' ? s.maxAttempts : 1;
      let lastStatus = 503;
      while (tried.length < max) {
        reqSignal.throwIfAborted();
        const latest = loadRegistry(root);
        const available = availableAccounts(latest, route.model, { wanted, exclude: tried, preferred });
        let chosen = null;
        for (const a of available) {
          if (session?.alias !== a.alias) {
            await releaseSession();
            try { session = await startProxy(root, a.alias, { signal: reqSignal }); reqSignal.throwIfAborted(); }
            catch (e) {
              if (reqSignal.aborted) throw e;
              if (e.code === 'ACCOUNT_BUSY') continue;
              emit('proxy_unavailable', a.alias, 503); tried.push(a.alias); lastStatus = 503;
              if (tried.length >= max) break;
              continue;
            }
          }
          chosen = a; break;
        }
        if (!chosen) break;
        const alias = chosen.alias; tried.push(alias); preferred = alias;
        await recordOutcome(root, alias, route.model, 0);
        emit('selected', alias, 0);
        let upstream;
        try { upstream = await upstreamRequest(session, route, req.method, body, reqSignal); }
        catch (e) {
          // No automatic retry for a lost connection: server acceptance may be ambiguous.
          emit('connection_failed', alias, 502); throw e;
        }
        const status = upstream.statusCode || 502;
        await recordOutcome(root, alias, route.model, status, upstream.headers['retry-after']);
        const retryable = [401, 429, 502, 503, 504].includes(status);
        if (retryable) {
          lastStatus = status; upstream.destroy(); emit('account_unavailable', alias, status);
          await releaseSession();
          if (tried.length < max && wanted === 'auto') continue;
          break;
        }
        // In particular 403 is NOT a reason to rotate around an account restriction.
        if (status >= 400) {
          if (status === 403) fatalStatus = 403;
          upstream.destroy(); emit('request_failed', alias, status);
          errorResponse(res, status, `Provider returned HTTP ${status}; the job was not replayed.`); return;
        }
        const headers = { 'Content-Type': upstream.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' };
        res.writeHead(status, headers);
        try { await pipeline(upstream, res, { signal: reqSignal }); }
        catch (e) { emit('stream_interrupted', alias, status); throw e; }
        emit(/:(?:streamGenerateContent|generateContent)/.test(route.path) ? 'generation_completed' : 'completed', alias, status); return;
      }
      const state = loadRegistry(root), now = Date.now();
      const times = state.accounts.filter(a => a.enabled && !a.blocked && !a.needsLogin && (wanted === 'auto' || a.alias === wanted))
        .map(a => Math.max(a.cooldowns?.[route.model] || 0, a.cooldowns?.['*'] || 0)).filter(t => t > now);
      const delay = times.length ? Math.max(1, Math.ceil((Math.min(...times) - now) / 1000)) : 5;
      const candidates = state.accounts.filter(a => a.enabled && (wanted === 'auto' || a.alias === wanted));
      if (candidates.length && candidates.every(a => a.needsLogin)) lastStatus = 401;
      if (times.length) lastStatus = 429;
      errorResponse(res, lastStatus === 401 ? 401 : lastStatus === 429 ? 429 : 503, 'No eligible account available within the attempt bound; wait or check accounts list.', delay);
    } catch {
      if (!res.destroyed) errorResponse(res, 502, 'Account request interrupted; no whole-job retry was performed.');
    } finally { busy = false; res.off('close', disconnected); settle(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let closing;
  const close = () => closing ||= Promise.resolve().then(async () => {
    controller.abort(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await idle; await releaseSession();
  });
  const abort = () => { void close().catch(() => {}); };
  combined.addEventListener('abort', abort, { once: true });
  return { baseURL: `http://127.0.0.1:${server.address().port}`, key, waitForIdle: () => idle,
    close: async () => { combined.removeEventListener('abort', abort); await close(); } };
}
