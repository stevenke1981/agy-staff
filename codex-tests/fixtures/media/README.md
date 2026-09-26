# Offline media fixtures

`bridge-tools.json` was obtained by actually starting the user-provided Linux Bridge binaries in stdio MCP mode (Gemini 1.0.0, Grok 1.0.0, ChatGPT 2.0.0). Only initialize and tools/list were used; no browser generation or credentials were used.

`sample.png` is a 32x32 synthetic raster; `sample.wav` is a 0.5-second sine wave, not AI music. `cover.mp4` is a 0.5-second synthetic MPEG4/AAC fixture made with FFmpeg. `not-music.mp3` is intentionally invalid text. These small test assets are not production artwork or music.

Fake Bridge/AGY entrypoints require the isolated MEDIA_FIXTURE_DIR test variable; they never contact Google/xAI/OpenAI. Successful mock calls are not live provider validation.
