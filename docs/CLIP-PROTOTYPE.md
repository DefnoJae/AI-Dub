# Local short-clip prototype

The separate Python CLI extracts up to 30 seconds from a local media file, recognizes Japanese speech, translates the audio to English with Whisper's translate task, synthesizes English with Piper, and writes a dialogue-only WAV and a JSON timing report. It does not replace player audio. The HTTP companion's health and job API remain unchanged: they cannot submit processing jobs yet.

## Setup

Use Python 3.12 and run these commands from the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r companion/requirements-audio.txt
.\.venv\Scripts\python.exe companion/prepare_models.py
```

The final step explicitly downloads the Whisper base model and the en_US-lessac-medium Piper voice. Models are stored under the ignored `.ai-dub/models` folder. Processing subsequently runs with `HF_HUB_OFFLINE=1` and `local_files_only=True`. Input media and generated text/audio are not uploaded. Dependency versions used during development are recorded in requirements-audio-lock.txt; the lock is a Windows/Python 3.12 environment snapshot, not a cross-platform resolver lock.

## Run

```powershell
.\.venv\Scripts\python.exe companion/dub_clip.py "C:\Media\episode.mkv" --start 60 --seconds 20 --output .ai-dub/jobs/first-clip
```

The output directory must not already exist. Use `--audio-stream 1` to select the second audio stream when needed. URL input is deliberately unsupported by this CLI; an already accessible Seanime source must first be extracted to a local clip. Do not bypass provider authentication or DRM. No full-episode download or watch-history update is required by the CLI.

Outputs: source.wav, english-dialogue.wav, segment WAV files, report.json. Timing is relative to the extracted clip. Translation segments may differ from Japanese transcription segments. English utterances keep their full duration; overlaps shift later utterances forward. Review `startDrift` and `overrun` in the report; this is not lip sync or real-time dubbing. Music/effects are not retained, speakers share one generic voice, and recognition/translation may be wrong. The small base model favors a quick prototype over production accuracy. A failed run may leave partial files, but has no completed report.

## Validation

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_audio.py -v
```

Tests cover window limits, silence rejection, actual WAV decoding, and retaining utterances without overlap or truncation. Mock voice tests check scheduling, not model quality. Real model smoke tests must be reported separately; generated speech alone does not demonstrate Japanese translation or Seanime player integration.

## Dependencies and licensing

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper): MIT code; consult the Whisper model repository for model terms.
- [Piper](https://github.com/OHF-Voice/piper1-gpl): GPL-3.0 code; distributed separately as an optional dependency, not bundled into the Seanime plugin. Review applicable obligations before distributing a combined application.
- [lessac medium voice model card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/lessac/medium/MODEL_CARD): voice/data terms are separate from the engine. The setup script saves the card beside the models. No actor voice cloning is implemented.
