# AI Dub Studio for Windows

An independent native desktop application. No Seanime, browser extension, Node server,
pairing token or account is needed. The existing extension remains available separately.

## Start

On a fresh Windows computer, install Python 3.11 (including Tcl/Tk and the Python
launcher), then double-click **Setup-Studio.cmd**. Setup installs the quality runtime,
downloads Chatterbox Multilingual, UVR-MDX and Whisper-base, and prepares FFmpeg.
Model downloads require internet and several GB of disk space. They are not bundled.
On this development computer the runtime and models are already present.

Double-click **Start-Studio.cmd**. Import a local Japanese video. The project folder
stores all intermediates and must have ample free disk space (several GB per episode).
Start with the selected 30-second preview. Click **Analyze speakers**, then
**Review / edit script** to correct English text and speaker assignments. Click
**Render / Resume**, then **Play result** or **Export**.

Uncheck the preview box to process the full episode. Preview and full renders have
separate project folders; preview work is not reused in the full render. Videos up
to 45 minutes are accepted, including 24-minute episodes. Analysis is automatic
when Render is used without Analyze first.

## Voices and dialogue removal

UVR-MDX-NET-Inst_HQ_3 separates vocals from the music/effects bed. Whisper translates
the separated Japanese vocals into timed English lines. Chatterbox's pretrained
voice encoder produces an embedding for each usable Whisper segment; deterministic
complete-link cosine clustering assigns speaker IDs across the entire episode.
The longest reference (up to eight seconds) for each cluster is reused for all of
that speaker's English lines, including across minute boundaries.

The output mixes **only the separated background and generated English speech**.
It never ducks or mixes in the original soundtrack. The MP4 contains one English
audio track. Separation is imperfect: Japanese residue can remain inside the
instrumental estimate, and sound effects can be removed. Zero audible Japanese
cannot be guaranteed by this separator; listen to the preview.

## Reviewing and resuming

The script editor exposes JSON with `speakers` reference timestamps and timed `lines`.
To merge incorrectly split identities, change the affected lines' `speaker` to the
same existing ID. Each used speaker needs a clear reference of at least one second.
Correct text and timing as needed; references use seconds in the video. Save before
resuming. Edited lines/reference audio receive new cache keys; unchanged takes are
reused. A stale export cannot be played/exported from the UI after script edits.

Pause terminates the render process tree and releases its OS-owned project lock.
Render / Resume reuses completed minute separation/translations and completed voice
takes. A stage interrupted before its completion marker restarts. FFmpeg outputs and
JSON commits use temporary files before replacement. Raw generated speech is retained
separately from timing fits. Do not modify source media in place; source identity and
settings are checked before resume. Use another project folder for a changed source,
Whisper model path or clustering threshold. Do not edit project files during a render.

The CLI is also available:

```powershell
.venv-quality\Scripts\python.exe -m studio.pipeline --input "C:\Videos\episode.mkv" --project ".ai-dub\studio-projects\episode"
```

Add `--analyze` for script preparation only; `--seconds 30` for a preview project;
`--whisper PATH` to use another downloaded faster-whisper model; `--threshold .28`
to tune speaker clustering (lower splits more identities). Keep settings consistent
when resuming.

## Limits and verification

This is a Python/Tk Windows application launched by a command file, not a bundled
EXE/MSI installer. It is independent of Seanime but requires the installed Python
runtime and downloaded models. Inference is local and CPU based; 24-minute renders
can take many hours. No lip synchronization or acting/performance matching is promised.

Diarization is segment-level, not a full overlap-aware diarization model: speaker
changes within one Whisper segment, simultaneous speech, shouting, short utterances
and exaggerated anime voices may be misidentified. References shorter than one second
stop rendering with an actionable error. Whisper-base translations need review;
minute boundaries can split sentences. Segments over 500 characters require editing.
Speech that needs more than 1.6x speed to fit is rejected for script correction rather
than silently clipped. H.264 video is re-encoded for broad Windows playback support.

Automated verification includes the existing extension suite and Python tests.
The Studio integration test uses real FFmpeg/media IO and deterministic model doubles
on a 61-second video: two chunk boundaries, reference-conditioned take reuse, edited
line invalidation, changed-source/settings rejection, single-audio-track muxing, video
duration, and background-only samples outside generated speech. Model doubles do not
establish translation quality, diarization accuracy or voice resemblance. Native Tk
window creation is smoke-tested on Windows. A real 12-second Japanese clip completed
UVR-MDX separation, Whisper translation, automatic clustering into two speakers,
Chatterbox generation and English-only MP4 export. A second run reused all analysis
and voice takes successfully. This was a technical smoke test, not a listening review
or a speaker-accuracy benchmark. A full 24-minute model render has not
been validated; do a short preview first.
