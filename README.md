# AI Dub

Local-first AI dubbing companion for Seanime, with optional opt-in cloud acceleration.

> **Status: settings/status companion plus an experimental offline clip processor.** A short Japanese-to-English processing test completed using a Miruro source resolved by Seanime. Its translation and voice quality remain unreviewed. Seanime audio replacement is not implemented.

## Installation

Install this manifest from Seanime Extensions:

`https://raw.githubusercontent.com/DefnoJae/AI-Dub/main/Manifest.json`

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
