# AI Dub architecture (draft)

## Pipeline

Authorized source media -> extract audio -> transcribe Japanese -> translate -> speaker attribution -> English TTS -> align utterances -> mix with background -> cache timed segments -> player audio output.

## Constraints

- Source separation is imperfect: original dialogue can bleed through music/effects.
- Offline synthesis may take longer than playback on CPU-only hardware.
- Seek and pause must reset synchronization safely; fallback to original audio on processing failures.
- The Seanime plugin sandbox cannot be assumed to control browser media elements or libmpv audio tracks directly.
- Local service should bind to `127.0.0.1`, authenticate requests, limit accepted inputs, and avoid exposing media on a public interface.
- Cloud mode is opt-in, with clear privacy and cost disclosures; no implicit uploads.
- Do not imitate identifiable actors' voices without authorization.

## Proposed companion endpoints (not implemented)

- `GET /health` -> version and readiness
- `POST /jobs` -> enqueue an authorized source for processing
- `GET /jobs/{id}` -> progress and errors
- `GET /jobs/{id}/segments` -> timestamps and locally cached English audio references
- `DELETE /jobs/{id}` -> cancel and optionally clear cache

All endpoint shapes are proposals and may change after player API research.
