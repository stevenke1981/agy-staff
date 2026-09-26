import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveAgyBinary, createAgyCommand, parseStreamResult, enforceStrictResult, withCodexContract } from '../companion/codex-platform.mjs';
import { createParser } from '../companion/observation.mjs';
const on = { AGY_STAFF_CODEX_TRANSPORT: '1', AGY_STAFF_STRICT_RESULT: '1' };

test('Windows: discovers official native executable in a spaced Unicode path', () => {
  const expected = 'C:\\Users\\主人 Name\\AppData\\Local\\agy\\bin\\agy.exe';
  assert.equal(resolveAgyBinary('agy', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\主人 Name\\AppData\\Local' }, exists: p => p === expected }), expected);
});
test('Windows: falls back to native agy.exe on PATH, not a cmd shim', () => {
  assert.equal(resolveAgyBinary('agy', { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\U' }, exists: () => false }), 'agy.exe');
});
test('rejects command wrappers without ever enabling a shell', () => {
  for (const p of ['agy.cmd', 'agy.BAT', 'agy.ps1']) assert.throws(() => resolveAgyBinary(p), /shell shim/);
});
test('rejects executable control characters', () => {
  for (const p of ['', 'agy\n.exe', 'agy\0.exe']) assert.throws(() => resolveAgyBinary(p), /one executable/);
});
test('legacy invocation preserves argv and does not enable stdin transport', () => {
  const args = ['-p', 'old prompt', '--output-format', 'json'];
  const r = createAgyCommand('agy', args, { env: {} });
  assert.deepEqual(r, { cmd: 'agy', args, input: undefined });
});
test('Codex moves the complete prompt out of argv without interpreting its text', () => {
  const text = '主人\n"quote" $env:TOKEN & echo bad --unrestricted --model other 中文';
  const r = createAgyCommand('agy', ['-p', text, '--model', 'x-high', '--output-format', 'json'], { env: on, platform: 'linux' });
  assert.equal(r.args.includes(text), false);
  assert.equal(r.args.includes('-p'), false);
  assert.equal(r.args[r.args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(r.args[r.args.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(JSON.parse(r.input).message.content, text);
  assert.equal(r.input.endsWith('\n'), true);
});
test('help and model discovery are not converted to prompt requests', () => {
  for (const args of [['--help'], ['--version'], ['models']]) {
    assert.deepEqual(createAgyCommand('agy', args, { env: on, platform: 'linux' }), { cmd: 'agy', args, input: undefined });
  }
});
test('Node entrypoints use node without requiring executable shebang support', () => {
  const r = createAgyCommand('C:/my tools/fake.mjs', ['--help'], { env: on, platform: 'win32' });
  assert.equal(r.cmd, process.execPath);
  assert.deepEqual(r.args, ['C:/my tools/fake.mjs', '--help']);
});
test('rejects missing prompt and preexisting input mode', () => {
  assert.throws(() => createAgyCommand('agy', ['-p'], { env: on }), /Missing/);
  assert.throws(() => createAgyCommand('agy', ['-p', 'x', '--input-format', 'json'], { env: on }), /Duplicate/);
});
test('accepts official result event surrounded by other protocol events', () => {
  const result = { status: 'SUCCESS', response: '完成', conversation_id: 'example' };
  assert.deepEqual(parseStreamResult('\uFEFF{"event":"init"}\r\n' + JSON.stringify({ event: 'result', result }) + '\n'), result);
});
test('does not fabricate a missing result', () => assert.equal(parseStreamResult('{"event":"step_update"}\n'), null));
test('rejects malformed output rather than guessing success from text', () => {
  assert.throws(() => parseStreamResult('not json'), /malformed/);
  assert.throws(() => parseStreamResult('null'), /envelope/);
  assert.throws(() => parseStreamResult('{"event":"result","result":[]}'), /envelope/);
});
test('rejects duplicate terminal result events', () => {
  const r = JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } });
  assert.throws(() => parseStreamResult(r + '\n' + r), /Multiple/);
});
test('ERROR with useful partial text stays a failure', () => {
  assert.throws(() => enforceStrictResult({ status: 'ERROR', response: 'changed file A', error: 'test failed' }, 1, on), error => {
    assert.equal(error.code, 'AGY_RESULT_FAILED');
    assert.match(error.message, /Partial output; NOT accepted/);
    assert.match(error.message, /changed file A/);
    return true;
  });
});
test('nonzero exit and missing success status cannot pass strict validation', () => {
  assert.throws(() => enforceStrictResult({ status: 'SUCCESS', response: 'x' }, 7, on), /did not succeed/);
  assert.throws(() => enforceStrictResult({ response: 'x' }, 0, on), /did not succeed/);
  assert.doesNotThrow(() => enforceStrictResult({ status: 'SUCCESS', response: 'x' }, 0, on));
});
test('legacy non-Codex result policy remains unchanged', () => {
  assert.doesNotThrow(() => enforceStrictResult({ status: 'ERROR', response: 'x' }, 1, {}));
});
test('strict result validation rejects absent payloads with an actionable error', () => {
  for (const payload of [null, undefined, []]) {
    assert.throws(() => enforceStrictResult(payload, 0, on), { code: 'AGY_RESULT_FAILED' });
  }
  for (const result of [{ status: 42 }, { status: 'SUCCESS', response: {} }]) {
    assert.throws(() => parseStreamResult(JSON.stringify({ event: 'result', result })), /Invalid AGY result/);
  }
});
test('strict streaming parser preserves split UTF-8, BOM, CRLF and an unterminated final record', () => {
  const events = [];
  const parser = createParser(e => events.push(e), () => assert.fail('Unexpected warning'), 1024, { strict: true });
  const input = Buffer.from('\uFEFF{"event":"init"}\r\n{"event":"result","result":{"status":"SUCCESS","response":"繁體中文"}}');
  for (const byte of input) parser.write(Buffer.from([byte]));
  parser.end();
  assert.equal(events.length, 2);
  assert.equal(events[1].result.response, '繁體中文');
});
test('strict streaming parser rejects invalid and oversized records while legacy stays tolerant', () => {
  for (const input of ['garbage\n', 'null\n', '[]\n', '42\n', '{"incomplete":']) {
    const parser = createParser(() => {}, () => {}, 1024, { strict: true });
    assert.throws(() => { parser.write(Buffer.from(input)); parser.end(); }, /malformed|envelope/);
  }
  const parser = createParser(() => {}, () => {}, 8, { strict: true });
  assert.throws(() => parser.write(Buffer.from('{"event":"init"}\n')), /Oversized/);
  const warnings = [];
  const legacy = createParser(() => {}, message => warnings.push(message));
  legacy.write(Buffer.from('garbage\n')); legacy.end();
  assert.equal(warnings.length, 1);
});
test('contract preserves task bytes, omits empty task, and leaves legacy untouched', () => {
  const task = '修正\n繁中 path & --flag';
  assert.equal(withCodexContract(task, {}), task);
  assert.equal(withCodexContract('', on), '');
  assert.ok(withCodexContract(task, on).endsWith(task));
  assert.match(withCodexContract(task, on), /Codex\/GPT remains the lead/);
});
test('real child process receives 162000-byte Unicode prompt over stdin and exits after EOF', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy stdin 主人 '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'fake agent.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs';\nconst e=JSON.parse(fs.readFileSync(0,'utf8'));\nif(process.argv.includes('-p'))process.exit(20);\nconsole.log(JSON.stringify({event:'init'}));\nconsole.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:e.message.content}}));\n`);
  const text = '中文及符號 & " --flag\n'.repeat(6000);
  assert.ok(Buffer.byteLength(text) > 128 * 1024);
  const r = createAgyCommand(fake, ['-p', text, '--output-format', 'json'], { env: on });
  const child = spawnSync(r.cmd, r.args, { input: r.input, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.equal(parseStreamResult(child.stdout).response, text);
});
