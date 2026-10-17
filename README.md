# AI Dub

Local-first AI dubbing companion for Seanime. Optional cloud acceleration is planned but not currently implemented.

> **Status: experimental offline full-episode dubbing and in-Seanime playback bridge.** Automated tests verify embedded Japanese and English tracks and the player API handoff; actual Denshi playback, dubbing quality and translation still require real-world verification. No instant live track injection.

## Installation

Install this manifest from Seanime Extensions:

`https://raw.githubusercontent.com/DefnoJae/AI-Dub/main/Manifest.json`

## Experimental episode dubbing in Seanime (0.5.1)

AI-Dub can now read the currently playing episode from Seanime's `videoCore.getCurrentPlaybackInfo()` and, **only after you request it**, ask the companion to process the accessible Japanese media source. Offline Whisper translates speech; local Kokoro ONNX (recommended) or Piper (fallback) generates English; FFmpeg packages one video with **two embedded audio streams** (Japanese original and English AI Dub). The generated English track is selected by default. Select **Play Dubbed Episode** to reopen it using Seanime's documented `videoCore.playStream()`.

**0.5.1 playback compatibility:** English is now the **first audio track** of the generated MP4, as well as the default. This helps Denshi's web renderer, which may play the first audio track but not expose the MP4 audio selection menu. The Japanese original is still embedded as the second stream for mpv/native players with audio selection. A successful render removes large temporary files; the Windows launcher checks FFmpeg dependencies before starting.

**This is not instantaneous/live dubbing and does not inject a stream into an already-playing video.** It prepares a separate video and changes playback only when requested. Native/mpv renderers normally support multiple embedded audio tracks; the web renderer's manual track menu may vary. CPU processing of a full episode can be slow. Sound quality and translations still need listening review.

### Windows upgrade (preserves your token)

1. From the AI-Dub checkout, run `git pull` and update/reload AI-Dub from its manifest in Seanime.
2. Stop the **existing** companion with Ctrl+C. Do not delete or regenerate `.ai-dub/pairing-token`.
3. Install the natural-voice engine and better Whisper-small model once with `.\Start-Audio.ps1 -SetupHighQuality`. This action explicitly downloads model files and dependencies; inference afterwards remains offline. Use `.\Start-Audio.ps1 -Setup` if you want the Piper fallback instead.
4. Start the updated companion with `.\Start-Audio.ps1`. It enables the episode engine. Kokoro is selected if correctly installed, otherwise Piper.
5. Play an anime episode in Seanime. Open AI-Dub, enable its **session** switch, click **Check Connection**, then **Detect Playback** and **Prepare Current Episode**.
6. Keep the source stream available until capture finishes. Use **Refresh Status** to see the current stage. After rendering completes, choose **Play Dubbed Episode** to load the version with embedded AI audio into Seanime. The English track is the default; original Japanese remains embedded.

Seanime's normal local backend is `http://127.0.0.1:43211`. If you changed its port, set `$env:AI_DUB_SEANIME_URL="http://127.0.0.1:PORT"` before launching Start-Audio.ps1. This resolves playback URLs with `{{SERVER_URL}}` placeholders. Signed provider streams may expire or block FFmpeg; protected/DRM content is not bypassed.

Output lives at `.ai-dub/episode-jobs/<job-id>/english-ai-dub.mp4` with `episode-report.json`. The Japanese speech is **quieted, not cleanly removed**, so it may bleed through the English mix. Kokoro uses a more expressive **generic voice**, not character-specific voices. Translation, performance and lip sync are not production quality. Capturing and preparing full episodes consumes disk space; only use sources you have the rights to process.

The companion serves completed MP4 files from a loopback-only, 256-bit unguessable playback URL with HTTP byte-range support for Seanime's media reader. Job-control endpoints still require the existing pairing token. Never post the playback URLs publicly.

Automated tests verify HTTP auth, source validation, job states, mock Seanime player handoff and a real FFmpeg-generated two-audio-track MP4. An end-to-end episode test on Denshi has **not** been performed remotely. Full compatibility with every provider and renderer is therefore not yet verified.

## Architecture plan

- **Seanime plugin (`code.js`)**: saved settings and manual companion health check; Seanime uses a sandboxed JS runtime, not Node.js.
- **Local companion service (prototype)**: dependency-free Node.js service on authenticated loopback. Health/status only; processing engines and caching are future work.
- **Offline clip experiment**: Whisper recognition/English speech translation and Piper synthesis are implemented in a separate Python CLI. Speaker segmentation, background separation and player mixing remain future work.
- **Cloud acceleration (future)**: disabled by default, explicit consent and provider selection; never upload source audio automatically.
- **Playback (unverified)**: determine whether the installed Seanime player exposes an API for secondary audio synchronization or audio-track replacement. Do not promise real-time dubbing before this is tested.

## Milestones

1. Validate manifest and plugin loading in a real Seanime installation.
2. Verify playback clock, pause, seek, and audio-track integration for web player and Denshi/libmpv separately.
3. Prototype offline dubbing for a short authorized clip and cache segments locally.
4. Add synchronization, underrun handling, music/SFX mixing, and voice consistency.
5. Add optional cloud processing with explicit consent.

## Development notes

No API keys or cloud dependencies are required. Seanime compatibility must be tested in the application.

## Run the companion prototype

Install Node.js 22 or newer, clone this repository, open a terminal in it, and run `npm start`. No package installation is necessary. Keep that terminal open; Ctrl+C stops the service.

The service binds only to `http://127.0.0.1:43123`. It creates a persistent random pairing token in `.ai-dub/pairing-token`, excluded from Git. Copy that file's contents into the AI Dub settings panel. Treat the token as a password. On Windows, protect the folder with your user account's normal file permissions; Unix file modes do not set Windows ACLs.

Seanime and the companion must run on the same machine. In containers, loopback refers to the container; remote/mobile setups are not supported by this prototype. `AI_DUB_PORT` can select another port (1024–65535), and `AI_DUB_DATA_DIR` can select a private data folder.

`GET /health` requires `Authorization: Bearer <pairing-token>` and reports service/API versions and unavailable capabilities. `POST /jobs` returns 501 (`ENGINE_UNAVAILABLE`); no media is accepted, read, or uploaded. Browser-origin requests are rejected; the plugin uses Seanime's server-side fetch. There is no cloud provider or billing code.

Run `npm test` for local HTTP/authentication and token lifecycle tests.

## Automatic local English clip jobs (experimental)

**New in 0.4.0:** The local Whisper-transcribe/translate + Piper pipeline can be launched from the extension's **Automatic English Clip** card. It accepts locally prepared MP4/MKV/WebM/MOV clips from `.ai-dub/inbox` and produces a generic English dialogue WAV plus timing report. No manually written English script is required. This is **not full-episode streaming, music/SFX mixing, lip sync, or audio-track insertion**. Keep original audio in Seanime until the player supports additional audio streams.

On Windows, from this repository folder, install the opt-in audio dependencies and offline models **once** (Python 3.12 needed):

```powershell
.\Start-Audio.ps1 -Setup
```

If PowerShell blocks the downloaded script, inspect it before choosing an appropriate execution policy. The script downloads models only during the explicit `-Setup` action; inference itself stays offline.

To enable the HTTP clip jobs, stop your **existing** companion in its original terminal (Ctrl+C) and start the same working copy using:

```powershell
.\Start-Audio.ps1
```

The launcher checks whether port 43123 is occupied and **does not kill any process**. It leaves `.ai-dub/pairing-token` completely unchanged; do not regenerate your already working token. If your companion normally uses `AI_DUB_DATA_DIR`, keep that directory consistent with the setup and launcher.

Then place a short authorized local media file with a name such as `sample.mp4` in `.ai-dub/inbox`, select **Load Local Clips** in AI-Dub, choose `sample`, click **Generate English Clip** and **Check Clip Progress**. Completion yields an `english-dialogue.wav` and `report.json` inside `.ai-dub/auto-jobs/<job-id>/`. Translation may be wrong, a single synthetic English voice is used, and speech timing may drift. Listening review is essential.

The Node companion is a separate process. **Updating only the Seanime extension is not enough**: update the local repo and restart the local companion after preparing models, while keeping the existing data directory. With no `AI_DUB_AUDIO=1`, the companion continues in its old health/status-only mode, and `/auto/*` endpoints are unavailable. `/health` still reports `ready:false` because automatic full-episode dubbing and in-player switching are not supported.

## Offline short-clip audio experiment

The original [Python clip prototype](docs/CLIP-PROTOTYPE.md) implements Japanese recognition, speech-to-English translation, and generic English speech export using local Whisper and Piper models. This basic path is a separate CLI experiment. It does not automatically process streams or change playback audio.

Version 0.3.0 adds an opt-in [reference-voice quality experiment](docs/QUALITY-CLIPS.md): Chatterbox source-speaker conditioning, vocal/background separation, timed remixing, MP4 preview export, and prepared local clip jobs from the Seanime panel. It requires a reviewed timed script and speaker references. It does not automatically dub episodes or replace live player audio.

## Seanime settings/status panel

Update/reload the extension using the manifest above and approve **storage** and **local network access to http://127.0.0.1**. Version 0.2.1 fixes the missing network allowlist in 0.2.0. Open the blue waveform tray icon; if it is hidden, open Seanime's all-plugins menu and select **AI Dub**. Paste the companion token, enable **Allow local status checks**, and click **Save settings**, then **Check saved connection**. The token is visible in this panel and persisted in Seanime's plugin storage, not an OS credential vault. **Forget token / disable checks** clears the plugin's saved credential; to revoke all copies, stop the companion, delete its pairing-token file and restart to generate a new one.

Only saved settings are used for checks. No connection is attempted automatically. The default is local checks disabled, and cloud mode is unavailable. A successful check says **Connected** and **Dubbing unavailable**. An unreachable service, bad token, or incompatible API produces a separate error message. This release's UI still needs verification in a real Seanime session; automated UI tests use mocks. See [player/API review](docs/PLAYER-API-REVIEW.md) for the research and test boundary.
