# Optional mpv audio-track bridge (developer preview)

The `companion/mpv-track.cjs` module provides a narrow **explicit** integration with mpv's documented JSON IPC. It is **not wired to the Seanime extension UI**, does not create a companion HTTP route, and does not generate a dub. It is intended to be called only after a user chooses AI-Dub and a synchronized, complete WAV file exists.

## What it does

`addDubTrack(socketPath, wavFile)` validates a local WAV file and sends mpv:

```json
{"command":["audio-add","/absolute/path/to/dub.wav","select","English — AI-Dub","eng"],"request_id":1}
```

This adds/selects an English audio track; the original track remains selectable through mpv's track menu. A dialogue-only WAV **replaces** the Japanese audio while selected, so it will not preserve background music/SFX. Use a properly remixed full-length soundtrack instead. Do not add partial segments as though they were complete episode tracks.

## Windows test procedure (advanced)

1. Start an mpv instance with an explicit local IPC pipe, e.g. `mpv --input-ipc-server=\\\\.\\pipe\\ai-dub-mpv episode.mkv`. Only connect to a trusted, locally controlled mpv instance.
2. Prepare a local full-length synchronized WAV for that episode (not the experimental 20-second clip).
3. From the repository root, call `addDubTrack('\\\\.\\pipe\\ai-dub-mpv', 'C:\\\\path\\\\to\\\\dub.wav')` in a local Node script after user selection.
4. Verify that mpv's audio menu includes **English — AI-Dub**, switching back restores original audio, and seeking preserves sync.

## Not implemented

- No automatic Seanime plugin detection or player menu registration.
- No Seanime playback event connection.
- No full-episode or progressive generation pipeline.
- No player-facing authentication/permissions bridge.
- No verified Denshi built-in-player compatibility.

The supported mpv command is documented at https://mpv.io/manual/master/#list-of-input-commands . Do not expose the IPC socket to untrusted users or bind it to a public network endpoint.
