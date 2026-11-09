# narrated-replay

> **⚠️ AI-generated, not reviewed by a human.** Every line in this repository was written by AI agents
> (Claude). No person has reviewed the code. Read it before you rely on it. It records users' voices:
> you are responsible for consent and data protection where you deploy it.

Let users think aloud while they use your web app. narrated-replay records their voice alongside a DOM
session replay (rrweb), transcribes it, lines up each spoken comment with what they were doing, and uses
an LLM to extract feedback, group it with earlier feedback, and triage it: easy fix, obvious bug, needs
design thinking, or product decision.

Status: v0.1, not published to npm. Install from GitHub.

## Privacy: read this before you deploy

- **Voice is personal data.** A recording of someone's voice, and the transcript of it, will normally count
  as personal data (in the UK and EU, under the GDPR). You need a lawful basis, a clear notice at the moment
  the microphone is requested, and a retention period. narrated-replay does none of that for you.
- **Consent.** `<TalkButton>` shows a consent dialog before the first recording and remembers the answer in
  `localStorage` (`narrated-replay:consent`). Replace the default text (`consentText`) with wording that fits
  your product and your legal advice. Recording starts only after a user gesture and an accepted prompt.
- **Retention.** Nothing is deleted automatically. Raw audio is the most sensitive artefact: decide how long you
  keep it, and delete the session directory (or S3 prefix) when you are done.
- **Masking does not cover speech.** Typed text is recorded in shape only (digits become `9`, letters `a`,
  other characters are kept) and password and `cc-*` fields are fully masked, but anything a person *says* is
  recorded as spoken, including names, email addresses and card numbers read aloud. The replay also shows
  whatever is rendered on the page: block sensitive elements with rrweb's `blockClass` (`rr-block`) option.
- **Third parties.** The transcript and the page context are sent to the LLM you choose (Anthropic API,
  Bedrock, or the local `claude` CLI), and the audio goes to the transcriber you choose (local
  faster-whisper by default; OpenAI or AWS Transcribe if you configure them). Check those terms.
- **Authentication.** The ingest endpoint writes files. `createIngestHandler` refuses to be created without
  an `authorize(req)` function (or `allowUnauthenticated: true`, for local development only).

## How it works

```
 browser                                   your server                         offline
 ┌────────────────────────┐   chunks    ┌─────────────────────┐   analyze   ┌───────────────────────┐
 │ rrweb DOM events       │──────────▶  │ createIngestHandler │──────────▶  │ ffmpeg remux (seekable)│
 │ MediaRecorder audio    │  /sessions  │  (auth, size limits)│   (CLI or   │ transcribe (words+ms)  │
 │ shared Date.now() clock│  /:id/:kind │  Store (files / S3) │    code)    │ align words to events  │
 │ nr:route custom events │  /:seq      └─────────────────────┘             │ LLM: extract items     │
 └────────────────────────┘                                                 │ LLM: cluster to themes │
        <TalkButton/>                         <SessionViewer/>  ◀───────────│ items.json themes.json │
                                          replay + audio in sync            │ report.md              │
                                                                            └───────────────────────┘
```

Packages (one npm package, subpath exports):

| Import | What |
| --- | --- |
| `narrated-replay` | Browser recorder (`createRecorder`, `httpUploader`, `shapeMask`) |
| `narrated-replay/react` | `<TalkButton>` and `useNarratedReplay` (+ `narrated-replay/talk-button.css`) |
| `narrated-replay/server` | Ingest handler, stores, transcribers, LLM adapters, `analyzeSession` |
| `narrated-replay/viewer` | `<SessionViewer>` (+ `narrated-replay/viewer.css`) |

## Install

```sh
npm install github:Skinnys-Bootleg-Codeshop/narrated-replay
```

The package builds itself on install (`prepare`). It needs Node 20 or newer, and React 18 or newer for the
React parts. Optional peer dependencies, installed only if you use them: `@anthropic-ai/sdk`,
`@anthropic-ai/bedrock-sdk`, `@aws-sdk/client-s3`, `@aws-sdk/client-transcribe`, `openai`.

For local transcription you also need `ffmpeg` on your PATH and Python with `faster-whisper` and `numpy`
(`python3 -m pip install faster-whisper numpy`). Set `NARRATED_REPLAY_PYTHON` or pass `--python` to use a
virtualenv.

## Quick start (Next.js App Router)

`examples/next-app` is a complete working app. The four pieces:

**1. A button** (client component), in your layout:

```tsx
'use client';
import { TalkButton } from 'narrated-replay/react';
import 'narrated-replay/talk-button.css';

export function Talk() {
  return <TalkButton options={{ endpoint: '/api/narrated-replay' }} />;
}
```

**2. The ingest route**, `app/api/narrated-replay/[...path]/route.ts`:

```ts
import { createFileStore, createIngestHandler, toNextRouteHandlers } from 'narrated-replay/server';

const store = createFileStore(process.env.NR_STORE ?? '.nr-store');
const handler = createIngestHandler({
  store,
  authorize: (req) => isSignedIn(req), // your check; required
});
export const { POST } = toNextRouteHandlers(handler);
```

**3. Analyze** recordings (run it yourself, on a schedule, or from a script):

```sh
npx narrated-replay analyze --store .nr-store --all \
  --transcriber faster-whisper --llm claude-cli
```

This writes, per session, `items.json`, `report.md`, a seekable `audio.webm`, `transcript.json` and
`moments.json`, and keeps one `themes.json` for the whole store. Each item has: `id, sessionId, quote, startMs,
endMs, momentIds, page, element, summary, category, confidence, rationale, needsHumanReview, themeId`.
Categories are exactly `easy_fix | obvious_bug | needs_design | product_decision`. `needsHumanReview` is set in
code (not by the model) for every `product_decision` and for any item with confidence below 0.7.
A new session's items are assigned to an existing theme when they describe the same issue, otherwise to a new one.

**4. A viewer page** that shows the replay with the audio in sync and the items beside it
(`examples/next-app/app/review/[id]`). Your audio route must answer HTTP Range requests, or browsers cannot seek:

```tsx
import { SessionViewer } from 'narrated-replay/viewer';
import 'narrated-replay/viewer.css';
// <SessionViewer meta={meta} events={events} audioUrl={`/api/review/${id}/audio`} items={items} />
```

CLI options: `--extraction session|moment` (one LLM call per session, or per spoken moment: dearer, but it
keeps themes better apart), `--product-context FILE` (a few lines about your product, added to the prompt),
`--model`, `--python`. Exit codes: 0 ok, 1 analysis failure, 2 bad arguments.
`narrated-replay serve --store DIR --port 4319` runs a local unauthenticated ingest on 127.0.0.1 only.

## AWS

S3 store (`createS3Store({ bucket, prefix })`), AWS Transcribe (`awsTranscribe({ bucket, region })`) and Bedrock
(`bedrock({ region })`, via `@anthropic-ai/bedrock-sdk`) are provided. **These adapters are unit-tested with
mocks only; they have not been run against AWS.**

## What was and was not tested

- Tested: Chromium (Playwright, headless, fake microphone), Next.js 16 App Router, macOS. faster-whisper
  (`small.en`) with the `claude` CLI, locally. See `npm test` (unit) and `npm run e2e`.
- Not tested: Safari, Firefox, mobile browsers, real microphones, long sessions, background tabs, the OpenAI,
  AWS and Bedrock adapters against live services, the direct Anthropic API adapter against the live API.
- Known quirks handled: MediaRecorder output has no duration, so audio is remuxed with `ffmpeg -c copy` (without
  ffmpeg, analysis still runs and the report says seeking may not work); rrweb does not emit single-page-app
  route changes, so the recorder patches `history.pushState`/`replaceState` and listens for `popstate` and
  `hashchange`, emitting `nr:route` events.
- Whisper word timings can be off by up to about half a second (faster-whisper) or over a second early
  (whisper.cpp, not supported here), so a comment can attach to the neighbouring action.

## Evidence from the prototype

A prototype recorded five scripted think-aloud sessions (text-to-speech voices, a small invoicing page, headless
Chromium, fake microphone) with overlapping complaints. Six issues were planted so that they appear in more than one
session (no date picker, a date the app rejects, an export button that does nothing, "save" versus "save as
draft", a slow filter with no sort, an unclear chart). With local faster-whisper (`small.en`) and the `claude` CLI
(`claude-sonnet-5-5`), `narrated-replay analyze` run over the five sessions in order produced 22 items and 8 themes,
and every planted issue ended up in a theme with all the sessions that raised it (6 of 6; the two date issues
landed in one theme). The first version of the clustering prompt scored 3 of 6 on the same sessions; the prompt was then
changed once to say what counts as the same problem (a symptom and its underlying need, or the same element with a
different complaint) and re-run.

Read these numbers with care: one run each, the prompt was adjusted after seeing the first result on these same
sessions (so 6 of 6 is not a held-out score), the speech is clean synthetic audio, the sessions are 30-40 seconds
long, and categories are the model's first guess, which is why low-confidence items and every product decision are
flagged for a person.

## Development

```sh
npm ci
npm run typecheck && npm test && npm run build && npm pack --dry-run
npm run e2e          # builds, refreshes the example's copy of the package, runs Playwright (Chromium)
```

`npm run e2e` starts the example app on port 4399 (`NR_E2E_PORT` to change it). The WAV the fake microphone
plays is committed (`e2e/fixtures/think-aloud.wav`); `scripts/gen-fixtures.sh` regenerates it on macOS.

## Licence

MIT. See `LICENSE`.
