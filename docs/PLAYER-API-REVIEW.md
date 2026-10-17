# Seanime API review

Reviewed official upstream declarations and docs during the 0.2.0 increment:

- [Plugin API declarations](https://github.com/5rahim/seanime/blob/main/internal/extension_repo/goja_plugin_types/plugin.d.ts)
- [UI plugin example](https://seanime.gitbook.io/seanime-extensions/plugins/example)
- [Persistent storage and required permission](https://seanime.gitbook.io/seanime-extensions/plugins/apis/storage)

The plugin uses `$ui.register`, `ctx.newTray`, field references, state, event handlers, `$storage`, and `ctx.fetch`. Fetch runs through Seanime, supports timeouts (seconds) and redirect rejection, and returns a response with `ok`, `status`, and `json()`. No browser DOM or Node modules are used by code.js. Settings helpers in newer declarations were deliberately avoided to reduce version coupling.

## Playback candidates, not demonstrated integration

- `ctx.playback` documents play, pause, resume, seek and playback status events. These are not themselves a secondary audio output API.
- `ctx.mpv` documents events, an optional connection, and generic commands. Default observed properties include time-pos, pause, duration, filename and path. This could support future MPV experiments, but availability for Denshi/libmpv must be verified separately.
- `ctx.videoCore` documents playback state, pause/resume, seek, status and audio-track events, and active-track selection. Selecting an existing track does not establish that arbitrary generated audio can be attached and synchronized.

No listeners or player commands are installed in 0.2.0. Needed next: verify actual events and units on the user's Seanime version, determine web-player external-track loading, separately test Denshi and external MPV, then test pause/seek/rate/episode changes and recovery before introducing replacement audio.

## Validation boundary

Automated tests run the plugin in a JS VM with mocked Seanime UI/storage and bridge its fetch to the real loopback service. This validates control flow and HTTP contract, not Goja serialization, tray rendering, permission approval, or player behavior. Those require an actual Seanime session. The user's initial successful installation demonstrates the 0.1.0 entrypoint loaded, not the 0.2.0 UI or audio integration.

## Denshi-specific decision (verified against upstream plugin.d.ts)

The user's normal player is **Denshi**, not external mpv. The published `$ui.Context.videoCore` interface supports `setAudioTrack(trackNumber)`, `sendGetAudioTrack()`, and `video-audio-track` events, but **does not declare `addExternalAudioTrack` or another external audio insertion method**. By contrast, it explicitly declares `addExternalSubtitleTrack`. Thus an extension can select an audio track already present in Denshi, but the public interface does not show how to register a newly generated English audio stream in Denshi's native audio menu.

The `ctx.mpv.getConnection().call(...)` path is mpv-specific and must **not** be assumed to control Denshi. The standalone `companion/mpv-track.cjs` bridge is therefore not the Denshi solution.

**Do not ship a fake AI English Dub menu item or automatically start generation.** The required next step is either (a) an upstream Denshi/Seanime player API addition for adding external audio, or (b) a carefully reviewed and version-tested player-side integration explicitly supported by the Denshi implementation. Until then, keep the normal player untouched.

Upstream source reviewed: https://github.com/5rahim/seanime/blob/main/internal/extension_repo/goja_plugin_types/plugin.d.ts
