#!/usr/bin/env node
/** Portable test discovery: no shell wildcard expansion. --legacy also runs upstream tests. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = process.argv.includes('--legacy') ? ['tests'] : ['codex-tests', 'codex-integration'];
const files = dirs.flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(root, dir, f)));
const env = { ...process.env };
delete env.AGY_STAFF_CODEX_TRANSPORT; delete env.AGY_STAFF_STRICT_RESULT;
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=120000', ...files], { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (r.error) console.error(r.error.message);
process.exitCode = r.status ?? 1;
