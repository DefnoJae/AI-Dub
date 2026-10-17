# AI Dub

Local-first AI dubbing companion for Seanime, with optional opt-in cloud acceleration.

> **Status: settings/status companion plus an experimental offline clip processor.** Seanime audio replacement is not implemented. The separate Python CLI implements local recognition, speech translation and synthesis, but a complete Japanese-to-English source test has not yet been demonstrated.

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

## Offline short-clip audio experiment

An optional [Python clip prototype](docs/CLIP-PROTOTYPE.md) now implements Japanese recognition, speech-to-English translation, and generic English speech export using local Whisper and Piper models. This is a separate CLI experiment; the Seanime panel and HTTP service still provide connectivity/status only. It does not automatically process streams or change playback audio. See the linked setup, model downloads, limitations and validation instructions.

## Seanime settings/status panel (0.2.1)

Update/reload the extension using the manifest above and approve **storage** and **local network access to http://127.0.0.1**. Version 0.2.1 fixes the missing network allowlist in 0.2.0. Open the blue waveform tray icon; if it is hidden, open Seanime's all-plugins menu and select **AI Dub**. Paste the companion token, enable **Allow local status checks**, and click **Save settings**, then **Check saved connection**. The token is visible in this panel and persisted in Seanime's plugin storage, not an OS credential vault. **Forget token / disable checks** clears the plugin's saved credential; to revoke all copies, stop the companion, delete its pairing-token file and restart to generate a new one.

Only saved settings are used for checks. No connection is attempted automatically. The default is local checks disabled, and cloud mode is unavailable. A successful check says **Connected** and **Dubbing unavailable**. An unreachable service, bad token, or incompatible API produces a separate error message. This release's UI still needs verification in a real Seanime session; automated UI tests use mocks. See [player/API review](docs/PLAYER-API-REVIEW.md) for the research and test boundary.
