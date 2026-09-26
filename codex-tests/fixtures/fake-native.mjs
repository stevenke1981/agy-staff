import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const event = x => console.log(JSON.stringify(x));
if (args.includes('--skip-gateway')) { event({ event: 'result', result: { status: 'SUCCESS', response: 'bypassed' } }); }
else {
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'settings.json')));
  if (settings.modelProvider !== 'gemini') throw new Error('API mode not set.');
  const chunks = []; for await (const b of process.stdin) chunks.push(b);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const r = await fetch(process.env.GOOGLE_GEMINI_BASE_URL + '/v1beta/models/gemini-test-medium:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: input.message.content }] }] }) });
  const body = await r.json();
  event({ event: 'result', result: r.ok ? { status: 'SUCCESS', response: body.candidates[0].content.parts[0].text, conversation_id: 'fixture-conversation' }
    : { status: 'ERROR', error: `HTTP ${r.status}` } });
}
