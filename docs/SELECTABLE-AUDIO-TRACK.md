# Selectable AI English Dub: implementation contract

## Intended behavior

AI-Dub is **opt-in at the audio-track level**. Installing or enabling the plugin must never start speech recognition, translation, synthesis, or network processing for an episode.

1. Seanime starts playback with its normal audio track.
2. When the user explicitly selects **English — AI-Dub**, the integration checks a local episode cache.
3. If a synchronized dub is already available, switch to it without changing the video position.
4. Otherwise show **Preparing AI Dub**, generate bounded segments on demand, and only offer playback when a safe buffer exists.
5. Switching back to the original track stops AI-Dub playback immediately; cancellation of generation is configurable. Seek must invalidate outdated playback buffers.
6. A failed generation or companion disconnect must preserve/restore original audio and surface an error.

## Required player capability gate

**Do not claim this feature is implemented until the exact supported Seanime player APIs have been verified and exercised.** Investigate whether extensions can:

- register an additional external audio track or provide an audio stream to the player;
- read the episode's stable identity, playback position, pause/play, rate, and seek events;
- select an audio track while preserving the original track and video timeline;
- access a permitted local companion URL without exposing a bearer token to media clients.

If an extension cannot register an audio track, do not silently substitute an unsynchronized external sound player. Document the unsupported capability and the minimum player-side change needed.

## Progressive generation design

- Key cache by episode identity, source audio fingerprint, model/voice version, source audio language, and pipeline settings.
- Use short overlapping analysis windows, but render dialogue against absolute episode timestamps. Avoid speaking the same line twice at segment boundaries.
- Prefer dialogue isolation plus original music/SFX bed. Never mix raw Japanese dialogue at full volume underneath English speech.
- Prebuffer at least the next segment before switching; use a bounded queue and explicit buffering state when synthesis falls behind.
- Seeking must discard queued playback from the old position and prioritize the new timestamp. Pausing playback need not pause local generation.
- Preserve user choice per episode; **do not auto-select AI Dub on later episodes** merely because the plugin is enabled.
- Keep model downloads, cloud requests, and source-media access explicit and consented. No silent downloads.

## Acceptance tests

1. Plugin enabled, original track selected: zero generation jobs.
2. Select AI Dub: one on-demand job, visible preparing state.
3. Select original during processing: original audio remains usable.
4. Select cached AI Dub: no duplicate generation.
5. Seek and pause/resume: voice stays aligned with video; stale buffers never play.
6. Companion unavailable or worker crashes: no silent video and no false completed status.
7. Two jobs and delayed worker callbacks: stale worker events cannot unlock another active job.
8. Confirm real Seanime player behavior on Windows before marking audio switching as supported.

## Current status

This is a design and test contract, **not** a claim of functioning audio-track integration. The current plugin provides local status checks and experimental manually prepared quality clips. Its quality pipeline still requires prepared English dialogue and reference voices. The companion does not yet provide progressive episode dubbing.
