# Local reference-voice clips (0.3.0 experiment)

This optional path replaces generic Piper speech with Chatterbox Multilingual conditioned on source-speaker references. UVR/MDX separates vocals and background. English speech is fitted with pitch-preserving FFmpeg time stretching and remixed over the separated stereo background. A preview MP4 retains the original video stream. No cloud inference or per-minute service is used.

This is a short-clip experiment, not automatic episode dubbing. You must prepare a timed English script and explicit speaker reference intervals. There is no automatic speaker diarization, translation review, lip sync, or Seanime audio attachment. Voice resemblance, pronunciation, and the retained music/effects require listening review. Separation can retain original speech or remove effects. The model's watermark remains enabled.

## Setup on Windows

Use Python 3.12, Node 22+, and several GB of free disk space. The tested Windows laptop has an AMD RX 6550M (4 GB) and about 15 GB usable RAM. The tested path uses CPU, not AMD GPU acceleration. Processing is not real time.

```powershell
python -m venv .venv-quality
.\.venv-quality\Scripts\python.exe -m pip install -r companion/requirements-quality.txt
.\.venv-quality\Scripts\python.exe companion/prepare_quality.py
```

Preparation downloads models and auxiliary tokenizer assets. Audio Separator may retrieve model metadata during startup. Inference and media processing stay local; the app does not send source files or scripts to these repositories. Prepared assets live in `.ai-dub/models`; the bundled FFmpeg executable is copied to `.ai-dub/tools`. Keep all models, references and generated media out of Git.

## Timed script

Create `.ai-dub/inbox/example.mp4` and `.ai-dub/inbox/example.json`. Use clean references containing only the intended speaker, at least one second long (longer references usually provide more useful conditioning). Timestamps are seconds relative to the start of the selected clip. The experiment processes the first 20 seconds by default, at most 30.

```json
{
  "translationSource": "manually reviewed English translation",
  "speakers": { "speaker-a": { "start": 0, "end": 3 } },
  "lines": [
    { "start": 0, "end": 3, "speaker": "speaker-a", "text": "This is an invented example." }
  ]
}
```

The runner keeps speech at its natural speed when it fits. Longer takes can be sped up by at most 1.6x; beyond that it fails instead of cutting words. If the script doesn't fit, edit its wording/timing. Each job creates a fresh output folder and a completed report only on success. Partial files and private job logs remain available for debugging. Optional CLI `--resume` reuses partial files only for the same source/script; do not change either while resuming.

## Use from Seanime

1. Start `Start-Quality.ps1` from the repository folder. Stop an older companion first if port 43123 is occupied. Keep the terminal open.
2. Update AI Dub to 0.3.0. It uses the same storage and loopback permissions as 0.2.1.
3. Open AI Dub in Seanime's all-plugins menu. Save/pair the existing token if needed.
4. Click **Load prepared clips**, choose the clip, then **Generate quality clip**.
5. Click **Refresh result** to check completion. Open the displayed local output folder and play `english-preview.mp4` or `english-mix.wav`.

The HTTP experiment is opt-in (`AI_DUB_QUALITY=1`). It accepts only prepared, paired MP4/JSON files under the configured data directory's `inbox`; it does not accept URLs, uploads, arbitrary paths or shell commands. Requests use the existing pairing token. Only one job runs at a time. Status history is in memory; audio and reports remain on disk after restart. The old `/jobs` endpoint and automatic playback capabilities remain unavailable; the experimental endpoints are `/quality/clips`, `/quality/jobs`, and `/quality/jobs/{id}`.

## CLI

```powershell
.\.venv-quality\Scripts\python.exe companion/quality_clip.py .ai-dub/inbox/example.mp4 --script .ai-dub/inbox/example.json --output .ai-dub/jobs/example-quality
```

## Licensing and provenance

Chatterbox is an optional external engine; review [its repository and model terms](https://github.com/resemble-ai/chatterbox). Audio separation uses [Audio Separator](https://github.com/nomadkaraoke/python-audio-separator) and its separately downloaded UVR model. FFmpeg comes from imageio-ffmpeg's Windows distribution; review the bundled build's license before redistributing binaries. Nothing here grants redistribution or voice rights over input media. The test clip, voice references and ElevenLabs benchmark are private local inputs, never committed.
