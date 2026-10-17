# Audio increment validation

Implemented in commit 936b3d4: optional local clip processor, model preparation, and audio tests.

## Demonstrated locally

- Installed faster-whisper 1.2.1 and Piper 1.8.0 in an isolated Python 3.12 environment.
- Downloaded Whisper base and Piper en_US-lessac-medium to the project model folder.
- Generated a real non-silent English speech WAV with Piper from explicitly supplied test text.
- Ran Whisper on that WAV with networking disabled. It detected English and the Japanese-only pipeline rejected the input as intended.
- Six Node companion/plugin tests passed, plus three Python audio tests for bounded decoding, silence rejection, invalid windows, overlap scheduling and preserving utterance audio.
- Model preparation ran successfully, including downloading the voice model card.

## Not demonstrated

A complete Japanese recognition → English translation → speech result has not been run on a Seanime clip. The library database contained no local media files; the inspected online source for GANBARE DOUKICHAN stayed at “Loading stream” across Anime Nexus, AniZone and Animeya. No source audio was extracted or uploaded, and no episode dub was generated. The English voice smoke test is not a translated anime clip.

No live player audio attachment, synchronization, background mixing, speaker preservation, or HTTP processing job has been demonstrated. The original companion's health response continues to report its processing capabilities as false, because the separate CLI is not exposed through it.

Next integration test: resolve an accessible Japanese source in Seanime, extract a 15–30-second audio interval, run the CLI, review report.json against audible speech and reference subtitles, and measure timing overruns. Do not promote capabilities based on code presence alone.
