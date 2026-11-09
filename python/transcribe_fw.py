"""Transcribe an audio file with faster-whisper and print JSON to stdout.

usage: transcribe_fw.py AUDIO_FILE [MODEL=small.en]
Output: {"segments": [{"start": s, "end": s, "text": str, "words": [{"w": str, "s": s, "e": s}]}]}
Audio is decoded with ffmpeg (16 kHz mono float) and passed as an array, which avoids
the PyAV decoding problems seen with some faster-whisper / av combinations.
"""
import json
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel


def load(path: str):
    raw = subprocess.check_output(
        ["ffmpeg", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"]
    )
    return np.frombuffer(raw, dtype=np.float32)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: transcribe_fw.py AUDIO_FILE [MODEL]", file=sys.stderr)
        return 2
    model = WhisperModel(sys.argv[2] if len(sys.argv) > 2 else "small.en", device="cpu", compute_type="int8")
    segs, _info = model.transcribe(load(sys.argv[1]), word_timestamps=True, language="en", vad_filter=False)
    out = [
        {
            "start": g.start,
            "end": g.end,
            "text": g.text,
            "words": [{"w": w.word, "s": w.start, "e": w.end} for w in (g.words or [])],
        }
        for g in segs
    ]
    json.dump({"segments": out}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
