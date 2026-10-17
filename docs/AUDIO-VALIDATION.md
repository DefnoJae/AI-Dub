# Audio increment validation

Implemented in commit 936b3d4: optional local clip processor, model preparation, and audio tests.

## Demonstrated locally

- Installed faster-whisper 1.2.1 and Piper 1.8.0 in an isolated Python 3.12 environment.
- Downloaded Whisper base and Piper en_US-lessac-medium to the project model folder.
- Generated a real non-silent English speech WAV with Piper from explicitly supplied test text.
- Ran Whisper on that WAV with networking disabled. It detected English and the Japanese-only pipeline rejected the input as intended.
- Six Node companion/plugin tests passed, plus three Python audio tests for bounded decoding, silence rejection, invalid windows, overlap scheduling and preserving utterance audio.
- Model preparation ran successfully, including downloading the voice model card.

## Miruro source test

After switching to Miruro, Seanime resolved and played a source for GANBARE DOUKICHAN. A cached source request for episode 3 supplied the media URL and required Referer header. Extraction used Seanime's existing loopback playback proxy; no upstream access restrictions were bypassed and no source audio was uploaded. The source URL, token and raw media are excluded from Git.

A short interval around source time 60–80 seconds yielded 19.295 seconds of mono audio. The offline CLI completed Japanese recognition, English speech translation and Piper synthesis. Whisper reported Japanese with probability 0.9799; this is a language-detection score, not translation accuracy. Seven English segments were synthesized; maximum recorded utterance overrun was approximately 0.091 seconds, with no accumulated start drift in this sample. The output and JSON report are marked generated-unreviewed. Human review of recognition, translation and audible quality remains necessary.

PyAV's HLS reader needed extension_picky=0 for Seanime's extensionless proxy segment URLs. The direct upstream URL without its playback headers returned 403; extraction succeeded through the existing player proxy. This extraction was a one-off local test, not a generic stream capture feature or a new plugin capability.

The initial tests with Anime Nexus, AniZone and Animeya had stayed at “Loading stream”; that did not establish that all Seanime providers were unusable. Miruro supplied the source needed to complete the processing test. The earlier English voice smoke test remains separate from this real source test.

## Reference-voice quality experiment (0.3.x)

Installed Chatterbox Multilingual and Audio Separator in a separate Python 3.12 CPU environment. The AMD RX 6550M is not used for acceleration. A private 16-second comparison clip completed in about 160 seconds on the first run, with two explicit speaker references and four English utterances. UVR-MDX-NET-Inst_HQ_3 separated a stereo background track; the runner mixed generated dialogue back over it and copied the original video stream to a preview MP4.

English text was transcribed from the user's ElevenLabs comparison to isolate synthesis/mixing differences. This is not an independent translation benchmark. Local Whisper readback recovered all intended English words. Numerical verification confirmed the exported WAV contains the background plus dialogue within 16-bit quantization tolerance (maximum difference approximately 0.000031). These checks do not establish actor resemblance, performance quality, or perfect sound-effect retention.

Eight Node tests and six Python tests cover authentication, settings, job confinement/concurrency, completion reporting, script validation, audio scheduling and mixing. The opt-in quality job endpoints use prepared local inbox files. Automatic processing capabilities remain false; an experimental health field separately identifies the prepared-clip workflow.

## Not demonstrated

No live player audio attachment, pause/seek synchronization, automatic episode dubbing, automatic speaker assignment, or human-approved voice resemblance has been demonstrated. Listening review is still required. Separation may retain source speech or remove effects.