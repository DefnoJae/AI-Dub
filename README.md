# AI Dub

Local-first AI dubbing companion for Seanime, with optional opt-in cloud acceleration.

> **Status: architecture scaffold, not a working dubber.** This repository does not currently translate audio, synthesize speech, or replace Seanime playback audio.

## Installation

Install this manifest from Seanime Extensions:

`https://raw.githubusercontent.com/DefnoJae/AI-Dub/main/Manifest.json`

## Architecture plan

- **Seanime plugin (`code.js`)**: entrypoint and future UI integration; Seanime uses a sandboxed JS runtime, not Node.js.
- **Local companion service (prototype)**: dependency-free Node.js service on authenticated loopback. Health/status only; processing engines and caching are future work.
- **Offline processing (future)**: speech recognition, Japanese-to-English translation, speaker segmentation, English TTS, dialogue/background separation and timed mixing.
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
