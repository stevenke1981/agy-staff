# Codex .3 integration validation — 2026-09-26

Scope: `0.7.3-codex.3` on `codex/windows-native`, integrated with the reliability fixes from `8f342ef`.
The supplied archive's 75 manifest entries passed its integrity check. Archive SHA-256:
`a5ecb2274c447484c1a9e48aa5300e37bb78dac95f7f87bda98aa5eab58e7460`.

The .3 overlay was merged against the pristine .1 baseline, not copied over the repaired runtime.
Account routing, dedicated image/video/music jobs, fixtures, guides, and Windows setup scripts are now included.

## Current checks

Environment: **Windows 10 Pro 10.0.19045**, Node.js 24.21.0, native AGY 1.2.11.
This local run is not evidence of Windows 11 behavior.

| Check | Result |
| --- | --- |
| `node scripts/test-codex.mjs` | PASS: 155 tests, zero failures/skips |
| `node --test codex-tests/media.test.mjs` | PASS: 57 tests, including actual child processes and local FFmpeg decode |
| `node scripts/test-codex.mjs --legacy` | PASS: 193 passed, zero failed, two POSIX-only skips (195 tests) |
| `npm run check:pi` | PASS: 11 generated files verified, zero changed |
| PowerShell parser: Setup-Accounts.ps1 / Setup-Media.ps1 | PASS: syntax only; account download/login script not executed |
| Skill Creator quick validator | PASS: new media skill and installed agy-codex skill |
| `doctor --workspace .` | PASS: Node, Git, AGY and stream-json capability; no model call |
| Installed `media doctor --provider agy-native` | PASS: FFmpeg, ffprobe, native stream-json discovery; no image generated |
| Installed image/video/music `--dry-run` | PASS: intended provider/tool and generation_sent=false |
| Codex Desktop bundled app-server `skills/list` with forceReload | PASS: one enabled user-scope agy-codex, expected installed path, no matching errors |
| `accounts list` | PASS: not initialized, default native; no credentials imported or account switched |
| CLIProxyAPI pinned release metadata | PASS: v7.3.17 Windows x64 SHA-256 matches DEPENDENCIES.json; binary not downloaded/run |
| `git diff --check` | PASS |

The discovery check uses [the documented app-server handshake and skills/list](https://learn.chatgpt.com/docs/app-server).
It proves runtime discovery, not a live model task or a manually observed Desktop skill-menu interaction.

## Reproduced and repaired during integration

- Native media doctor originally inspected stdout only. AGY writes help to stderr on this host. Doctor now requests combined help output; ffprobe JSON consumers still receive stdout only. A stderr-only child fixture covers this.
- Windows copyFile preserved an old fixture timestamp, so the first integration run had 153 passes and one NO_NATIVE_FILE failure. The fake generator now writes fresh bytes. A separate stale-artifact test confirms that production freshness enforcement still rejects old images even with successful hook receipts.
- Windows CI checks installation failure only when installation ran, and explicitly checks both FFmpeg and ffprobe exit codes.
- Setup scripts default to their own repository directory, preserving explicit -Repository overrides.

## Preserved reliability and safety behavior

- Foreground/background malformed, duplicate, primitive and missing results are rejected.
- Continued jobs retain the host contract and their original conversation, working directory and account session.
- Every installed runtime module requires its SHA-256 entry; failed validation preserves the active skill.
- UTF-8 splits, BOM, CRLF, no-final-newline and oversized result records remain covered. Legacy parsing remains tolerant.
- Account tests use isolated fake OAuth/proxies. 403 stops routing; ambiguous acceptance and interrupted streams do not replay onto another account.
- Media tests use offline protocol fixtures and small synthetic media. Same-ID submission, recovery, download uncertainty, cancellation, real decoding and artifact hash checks are exercised. No real website generation occurs.
- Media remains outside the coding account pool. Account setup is opt-in and was not run.

## Installation and recovery

Run `node scripts/install-codex-skill.mjs --update` from this fork checkout.
It backs up the previous managed skill under `%USERPROFILE%\.agents\agy-staff-codex-backups` and installs at `%USERPROFILE%\.agents\skills\agy-codex`.
The installation command returns the exact backup path. Keep it until acceptance.
The old patch-pack directory outside this Git checkout is not the updated source.

The installed skill preserves explicit invocation: start a new Codex conversation and use `$agy-codex`.
If a skill update does not appear, [restart Codex](https://learn.chatgpt.com/docs/build-skills).
No global Codex configuration, model selection, account credentials or other skills were changed.

## Remaining live acceptance

**NOT_RUN:** real Google OAuth, CLIProxyAPI inference, native AGY image generation, connected browser Bridge image/video/music generation, manual Desktop invocation, human listening/visual acceptance.
Bridge website selectors and native generate_image hooks require real-provider verification before production acceptance.
Model inference and media submission require the user's specific task authorization; offline tests and doctor do not authorize or prove them.
