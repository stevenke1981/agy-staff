# Windows reliability validation — 2026-09-26

Scope: reliability fixes on the `codex/windows-native` branch based on `0.7.3-codex.1`.
The separately shared `.2` account and `.3` media archives are not included in this checkout.

## Reproduced regressions

- An offline worker emitting ERROR then SUCCESS in two result records was incorrectly recorded as a successful background job. The same foreground stream was already rejected.
- A continued review did not receive the Codex host contract. A fake worker checking the actual stdin request reproduced this missing instruction.
- The installer skipped checksum validation when a runtime file had no entry. The manifest omitted the shared observation and state-lock modules.

## Changes and checks

| Check | Result |
| --- | --- |
| `node scripts/test-codex.mjs` | PASS: 54 tests, zero failures/skips |
| `npm run check:pi` | PASS: 11 generated files verified, zero changed |
| Foreground/background malformed, duplicate, primitive and missing results | PASS: rejected; background jobs persist error state |
| Continued review | PASS: host contract, original conversation and parent job retained |
| Installed skill foreground/background entrypoints | PASS: actual child processes with offline AGY protocol fixture |
| UTF-8 byte splits, BOM, CRLF, final record without newline, oversized records | PASS |
| Missing runtime checksum during update | PASS: refuses update and preserves active skill |
| `node scripts/test-codex.mjs --legacy` | Initial run: 192 passed, one Windows symlink fixture failure, two platform skips |
| `node --test tests/pi-packaging.test.mjs` after fixture fix | PASS: all seven tests, including actual npm archive execution; Windows junction exercises link rejection without symlink privilege |
| `node --test tests/observation.test.mjs` | PASS: all seven legacy parser/projection tests |
| `node companion/codex-staff.mjs doctor --workspace .` | PASS: Node, Git, native AGY 1.2.11 and stream-json capability |

The streaming parser's strict mode is enabled only by the Codex transport. Legacy observation keeps its tolerant behavior. Raw job output remains available; protocol errors do not trigger automatic retries.

Environment: native Windows, Node.js 24.21.0. Model responses in tests are fixtures, not real Google inference. Login, account switching, image/video/music generation and Codex Desktop skill discovery are NOT_RUN for this revision.

## Pending source integration

The supplied ChatGPT share describes `.3` account/media functionality, but its ZIP download reports an unavailable upload status. Only the `.1` source archive was found locally. Integrating or validating `.3` requires the actual archive/source; its reported test counts cannot be attributed to this repository.

## Installation and recovery

Run `node scripts/install-codex-skill.mjs --update` from the reviewed checkout. Updates move the previous managed installation into `.agents/agy-staff-codex-backups` and return its exact path. Keep that backup until the new installation is accepted. The original patch-pack directory outside this Git checkout is not updated by these commits; use the fork checkout for subsequent updates.
