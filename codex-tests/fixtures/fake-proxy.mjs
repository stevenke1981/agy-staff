/** Offline fixture, never contacts Google. Synthetic credentials have no real tokens. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const args = process.argv.slice(2), cfg = JSON.parse(fs.readFileSync(args[args.indexOf('-config') + 1]));
if (args.includes('-antigravity-login')) {
  fs.writeFileSync(path.join(cfg['auth-dir'], 'antigravity.json'), JSON.stringify({ type: 'antigravity', email: 'browser@example.invalid', refresh_token: 'fixture-refresh' }));
} else {
  const auth = JSON.parse(fs.readFileSync(path.join(cfg['auth-dir'], fs.readdirSync(cfg['auth-dir']).find(f => f.endsWith('.json')))));
  const s = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${cfg['api-keys'][0]}`) { res.writeHead(401); res.end(); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'gemini-test-medium' }] })); return; }
    const chunks = []; for await (const b of req) chunks.push(b);
    if (auth.email.startsWith('limited@')) { res.writeHead(429, { 'Retry-After': '90' }); res.end('quota'); return; }
    const body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: body.contents[0].parts[0].text }] } }], fixture_account: auth.email.split('@')[0] }));
  });
  s.listen(cfg.port, cfg.host);
  const stop = () => { s.closeAllConnections(); s.close(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
