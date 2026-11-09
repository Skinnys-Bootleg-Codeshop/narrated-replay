#!/usr/bin/env bash
# Regenerates the e2e microphone fixture (macOS `say` + ffmpeg). The WAV is committed, so
# you only need this to change the script. Output: 16-bit 48 kHz mono, under 1 MB.
set -euo pipefail
cd "$(dirname "$0")/.."
out=e2e/fixtures
mkdir -p "$out"
say -v Samantha -o "$out/tmp.aiff" "I am on the add note page. I type a due date and save. It says invalid date. That is annoying, I expected a date picker."
ffmpeg -y -loglevel error -i "$out/tmp.aiff" -ac 1 -ar 48000 -sample_fmt s16 "$out/think-aloud.wav"
rm -f "$out/tmp.aiff"
ls -l "$out/think-aloud.wav"
