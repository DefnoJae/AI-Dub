# AI Dub Studio — Windows

Independent of Seanime. The existing extension remains separate.

## Starting and upgrading

Close old Studio windows and open Start-Studio.cmd. This laptop's runtime and models
are prepared. Studio remembers the last project and voice mode. Import a Japanese
video, analyze, review the numbered dialogue form, then Render / Resume.
Play result opens the English MP4; Export copies it to a chosen folder.

For older projects click Reanalyze speech timing once. The old script is backed up
as script-backup-<hash>.json; source/separation caches are reused. The supplied recording
project was upgraded and tested locally. Do not paste old JSON over new analysis.

On a fresh Windows computer install Python 3.11 with Tcl/Tk and the Python launcher,
then run Setup-Studio.cmd. Setup downloads Chatterbox Multilingual, UVR-MDX,
Whisper-small, Qwen2.5-1.5B-Instruct and Kokoro. Allow several GB for models and
additional working space per episode. Setup needs internet; inference uploads no
source media. This is a Python desktop app, not a bundled EXE/MSI installer.

Kokoro uses its own .venv-natural environment because its numpy requirement conflicts
with Chatterbox/UVR. Do not install its requirements into .venv-quality.

## Dialogue and timing

Japanese recognition uses full minute context and word timestamps, rather than
translating isolated syllables. Punctuation and long pauses define utterances. Silero
speech activity supplies a second view of pauses. Quiet words, stutters and timestamps
remain imperfect; exact visual lip synchronization is not implemented.

A local dialogue model drafts conversational English using nearby context and a word
budget. Raw English/Japanese and the proposed spoken version remain available.
Invalid drafts are rejected and the raw translation retained. Models can mistranslate,
omit nuance or hallucinate; human review is still necessary.

Review / edit script now opens a form: select a numbered line, listen to the original,
edit the spoken English, or change its speaker/times. No JSON editing is required.
Save all dialogue before rendering. The advanced JSON editor remains a developer
method, edit_json, and is not the main workflow.

Clustering first uses longer reliable utterances. A short interjection between two
turns by the same speaker inherits that identity instead of creating a third actor.
Other short lines use the nearest reliable embedding. This heuristic can misassign
new actors with only a short line, overlapping voices and exaggerated performances.

## Voices and recovery

Automatic mode tries up to three seeded reference-conditioned takes. Failed candidates
are recorded, so Resume does not repeat the identical failed delivery. Generated English
is transcribed to check word agreement and remove unwanted tails.

If reference delivery still fails, Automatic switches EVERY line for that speaker to
one consistent Kokoro voice, including previously generated lines. The substitution
is identified in the log/report and does not clone the original actor. Natural voices
mode uses stable generic voices directly. Reference voices only mode stops after failed
retakes without substituting another engine.

Natural generation adjusts its native pace before a small pitch-preserving FFmpeg
fit. A short take is no longer rejected for leaving silence in a longer window.
When source pauses and generated word boundaries are available, spare time is inserted
between words at a source hesitation instead of putting all silence after speech.
Otherwise spare time stays at the tail: audible speech may then finish before the
window ends, and the report records that. No phoneme, syllable or mouth-shape matching
is claimed. Never widen a line into another character's turn to force a render.

Speech-recognition verification is a quality check, not proof of every spoken word.
Fallback voice style is generic. Acting, emotion, identity and overlaps need review.

## Audio and saved work

UVR-MDX separates vocals/background. Only separated background and English dialogue
are mixed, with one English audio track in the output. Japanese residue can remain
inside the estimated background; sound effects/music can also be damaged. Zero audible
Japanese is not guaranteed by source separation.

Pause stops the process tree. OS-owned locks prevent simultaneous project writes.
Completed separation, scripts, candidates and fitted takes are retained. Temporary
outputs replace final files only after a successful write. Changed text/references
invalidate take caches; changed pause metadata refits cached candidates. Source identity
and settings are checked before resume. Preview and full episode have separate caches.

Videos up to 45 minutes are accepted, including 24-minute episodes. CPU processing
can take hours. report.json records voice choices/fallbacks, generated-word verification,
stretch speed, speech duration, padding and timeline placement.

CLI: .venv-quality/Scripts/python.exe -m studio.pipeline --input VIDEO --project FOLDER
Options: --analyze, --reanalyze, --seconds 30, --voice-mode automatic|reference|natural,
--whisper PATH, --threshold .28 and --no-adapt.

## Verification and limits

Tests cover source timing independent of English translation timestamps, short speaker
identity, silence trimming, pause insertion, failed-candidate retry/cache recovery,
whole-speaker fallback consistency, generated-word checks, source/settings rejection,
two-chunk mixing, interrupted-export resume, edited-line invalidation and single-track
duration-correct exports. Model doubles test deterministic logic, not translation quality.
Real Windows tests also use the supplied 15.8-second recording with actual models.

A full 24-minute model render, professional acting, exact lip synchronization,
overlap-aware diarization, universally accurate translation and a bundled installer
remain unvalidated or unimplemented. Preview before committing to a long render.
