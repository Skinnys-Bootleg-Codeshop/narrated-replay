# narrated-replay: agent instructions

Project facts only. Shared working rules live outside this repository.

- What it is: a public npm package that records users thinking aloud (microphone audio) alongside an rrweb DOM replay, transcribes it, aligns comments to what the user was doing, and uses an LLM to extract, cluster and triage feedback.
- The README must keep the "AI-generated, not reviewed by a human" notice as its first block. Never remove or soften it.
- Stack: TypeScript (ESM), one package at the repo root with subpath exports; Next.js example app in `examples/`. Details and commands are added with the v1 build.
