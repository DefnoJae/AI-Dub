# AI Dub

Local-first AI dubbing companion for Seanime, with optional opt-in cloud acceleration.

> **Status: architecture scaffold, not a working dubber.** This repository does not currently translate audio, synthesize speech, or replace Seanime playback audio.

## Installation (after merging)

Install this manifest from Seanime Extensions:

`https://raw.githubusercontent.com/DefnoJae/AI-Dub/main/Manifest.json`

## Architecture plan

- **Seanime plugin (`code.js`)**: entrypoint and future UI integration; Seanime uses a sandboxed JS runtime, not Node.js.
- **Local companion service (future)**: Python/FastAPI on loopback for audio processing and caching.
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

This branch contains only a minimal installable plugin candidate and project plan. No API keys or cloud dependencies are required. Seanime compatibility must be tested in the application.
