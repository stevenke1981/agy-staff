/** Offline AGY protocol fake. Never calls a real model or reads credentials. */
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex-integration'); process.exit(0); }
if (args.includes('--help')) { console.log('--input-format stream-json --output-format stream-json'); process.exit(0); }
if (args.includes('-p') || !args.includes('--input-format')) { console.error('Prompt was not moved to stdin'); process.exit(19); }
const input = fs.readFileSync(0, 'utf8');
const events = input.trim().split('\n').map(l => JSON.parse(l));
if (events.length !== 1 || events[0].event !== 'user') process.exit(20);
const content = events[0].message.content;
const failure = process.env.FAKE_CODEX_FAILURE === '1';
console.log(JSON.stringify({ event: 'init', conversation_id: 'fake-codex-conversation' }));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'fake-codex-conversation', status: failure ? 'ERROR' : 'SUCCESS',
  response: failure ? 'Partial work, test failed.' : `CODEX_STDIN_OK ${Buffer.byteLength(content)}`, ...(failure ? { error: 'Intentional offline failure' } : {}),
  usage: { input_tokens: 1, output_tokens: 1 } } }));
process.exitCode = failure ? 7 : 0;
