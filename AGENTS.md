# narrated-replay: agent instructions

Project facts only. Shared working rules live outside this repository.

- What it is: a public npm package that records users thinking aloud (microphone audio) alongside an rrweb DOM replay, transcribes it, aligns comments to what the user was doing, and uses an LLM to extract, cluster and triage feedback.
- The README must keep the "AI-generated, not reviewed by a human" notice as its first block. Never remove or soften it.
- Stack: TypeScript (ESM), one package at the repo root with subpath exports; Next.js example app in `examples/`. Details and commands are added with the v1 build.

## Commands
- `npm ci`, then `npm run typecheck && npm test && npm run build && npm pack --dry-run`.
- `npm run e2e`: builds, refreshes the example's copy of the package, runs Playwright (Chromium, fake microphone) against `examples/next-app` on port 4399 (`NR_E2E_PORT`). Needs `ffmpeg` on PATH.
- Live analysis (local only): `node dist/cli.js analyze --store DIR --session ID --transcriber faster-whisper --llm claude-cli [--python PATH]`; needs Python with `faster-whisper` and `numpy`, `ffmpeg`, and the `claude` CLI.

## Layout
- `src/recorder` browser recorder (rrweb + MediaRecorder, masking, route events, uploader); package root export.
- `src/react` `TalkButton`, `useNarratedReplay`, `talk-button.css`; `src/viewer` `SessionViewer`, `viewer.css`.
- `src/server` ingest handler, stores (file, S3), audio remux, transcribers, alignment, LLM adapters, prompts, triage.
- `src/cli` the `narrated-replay` command (`analyze`, `serve`); `python/transcribe_fw.py` local transcription script.
- `examples/next-app` working Next.js example (installed as a copy with `install-links`, so run `npm --prefix examples/next-app run refresh` after changing the package). `e2e/` Playwright tests; `test/` unit tests and small fixtures from recorded sessions.

## Rules for changes
- Ingest path parameters are untrusted: validate before building any path or key. Never join raw strings.
- LLM output is untrusted: validate with zod; the human-review rule is enforced in code, never trusted from the model.
- Examples, fixtures and docs stay generic (a notes or task app).
- Run external programs with argument arrays (`execFile`), never a shell string.
