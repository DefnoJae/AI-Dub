"""Prepare a selectable English AI-audio episode from an accessible source.

Opt-in and offline inference only; does not bypass DRM or copy remote credentials.
The original Japanese track is retained. This is deliberately non-realtime.
"""
import argparse
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import wave

os.environ["HF_HUB_OFFLINE"] = "1"

MAX_SECONDS = 45 * 60


def ffmpeg_binary():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def command(argv, step):
    print("STAGE: " + step, flush=True)
    subprocess.run(argv, check=True, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def validate_source(source):
    if source.startswith(("https://", "http://")):
        from urllib.parse import urlsplit
        url = urlsplit(source)
        if not url.hostname or url.username or url.password or url.fragment:
            raise ValueError("Unsupported source URL")
        return source
    if "://" in source:
        raise ValueError("Unsupported media URL scheme")
    file = Path(source).expanduser().resolve(strict=True)
    if not file.is_file() or file.suffix.lower() not in (".mkv", ".mp4", ".mov", ".webm", ".m4v", ".avi"):
        raise ValueError("Expected an accessible local media file")
    return str(file)


def synthesize(segments, voice, output, duration):
    """Write silence-aligned PCM directly to disk instead of retaining entire episode in RAM."""
    rate = voice.config.sample_rate
    samples_total = round(duration * rate)
    pcm = output / "english-dialogue.pcm"
    timeline = []
    cursor = 0
    with pcm.open("w+b") as raw:
        raw.truncate(samples_total * 2)
        for i, segment in enumerate(segments):
            text = segment.text.strip()
            if not text:
                continue
            if len(text) > 1200:
                raise ValueError("Translation segment is unusually long; review the source")
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as writer:
                voice.synthesize_wav(text, writer)
            buffer.seek(0)
            with wave.open(buffer, "rb") as reader:
                if reader.getnchannels() != 1 or reader.getsampwidth() != 2 or reader.getframerate() != rate:
                    raise ValueError("Piper returned an unsupported PCM format")
                samples = reader.readframes(reader.getnframes())
            desired = round(float(segment.start) * rate)
            position = max(cursor, desired)
            count = len(samples) // 2
            if position >= samples_total:
                print("WARNING: Final line starts beyond video duration", flush=True)
                break
            if position + count > samples_total:
                # Keep video timing intact; report the exact truncation instead of changing its length.
                length = (samples_total - position) * 2
                samples = samples[:length]
            raw.seek(position * 2)
            raw.write(samples)
            actual_end = position + len(samples) // 2
            timeline.append({
                "sourceStart": float(segment.start), "sourceEnd": float(segment.end),
                "actualStart": position / rate, "actualEnd": actual_end / rate,
                "startDrift": (position - desired) / rate,
                "truncatedAtEnd": count > len(samples) // 2,
                "text": text
            })
            cursor = actual_end
            if (i + 1) % 10 == 0:
                print("SEGMENTS: " + str(i + 1), flush=True)
    if not timeline:
        raise ValueError("No translatable dialogue found")
    return pcm, rate, timeline


def package_episode(local, pcm, rate, result, ffmpeg):
    # Duck the original dialogue to preserve some music/SFX.
    # This is NOT clean vocal removal; Japanese voices may remain audible.
    filter_complex = "[0:a:0]volume=0.18[originalbed];[1:a:0]volume=1.0[speech];" \
                     "[originalbed][speech]amix=inputs=2:duration=first:normalize=0[dub]"
    command([ffmpeg, "-nostdin", "-loglevel", "error", "-y",
             "-i", str(local), "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", str(pcm),
             "-filter_complex", filter_complex,
             "-map", "0:v:0", "-map", "[dub]", "-map", "0:a:0",
             "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
             # English first: Chromium-backed web players often play the first
             # audio stream and may not expose the multi-audio selection menu.
             "-metadata:s:a:0", "language=eng",
             "-metadata:s:a:0", "title=English - AI Dub",
             "-metadata:s:a:1", "language=jpn",
             "-metadata:s:a:1", "title=Japanese (Original)",
             "-disposition:a:0", "default", "-disposition:a:1", "0",
             "-movflags", "+faststart", str(result)], "Creating playable episode")


def run(args):
    from faster_whisper import WhisperModel
    from voice_engine import load_voice
    import av
    start = time.monotonic()
    source = validate_source(args.input)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    ffmpeg = ffmpeg_binary()

    local = output / "source.mkv"
    # Cache once. Seekable local media avoids decoding the provider stream repeatedly.
    command([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
             "-protocol_whitelist", "file,http,https,tcp,tls,crypto,data",
             "-i", source, "-t", str(MAX_SECONDS + 1),
             "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", str(local)],
            "Capturing the requested episode locally")
    with av.open(str(local)) as container:
        if container.duration is None:
            raise ValueError("Cannot determine episode duration")
        duration = container.duration / av.time_base
    if not 1 < duration < MAX_SECONDS:
        raise ValueError("Episode duration must be between 1 second and 45 minutes, without truncation")
    print("DURATION: {:.2f}".format(duration), flush=True)

    mono = output / "japanese-16k.wav"
    command([ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-i", str(local),
             "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "pcm_s16le", str(mono)], "Preparing Japanese audio")

    print("STAGE: Translating Japanese speech with offline Whisper", flush=True)
    model = WhisperModel(str(Path(args.model).resolve(strict=True)),
                         device="cpu", compute_type="int8", local_files_only=True)
    segments, info = model.transcribe(str(mono), task="translate", beam_size=5,
                                      vad_filter=True, condition_on_previous_text=False,
                                      temperature=0, word_timestamps=False)
    english = list(segments)
    if info.language != "ja":
        raise ValueError("Expected Japanese speech, detected " + str(info.language))
    print("STAGE: Synthesizing English speech locally", flush=True)
    voice = load_voice(args.tts, args.voice, args.kokoro_model, args.kokoro_voices, args.kokoro_voice)
    pcm, rate, timeline = synthesize(english, voice, output, duration)
    print("STAGE: Muxing Japanese and English audio tracks", flush=True)
    result = output / "english-ai-dub.mp4"
    package_episode(local, pcm, rate, result, ffmpeg)
    if not result.exists() or result.stat().st_size == 0:
        raise ValueError("Muxer did not produce an episode")
    report = {
        "status": "generated-unreviewed", "duration": duration,
        "elapsedSeconds": round(time.monotonic() - start, 1),
        "sourceLanguage": info.language, "languageProbability": info.language_probability,
        "engine": "Whisper translation + " + args.tts + " English voice", "cloudUsed": False,
        "englishSegments": timeline, "audioTracks": ["English AI Dub (default)", "Japanese original"],
        "dubTrackDefault": True,
        "warnings": [
            "Translation and voices are unreviewed and may be inaccurate or unnatural",
            "Original Japanese speech can leak through the ducked background mix",
            "Single synthetic speaker; character voice cloning and diarization are not implemented",
            "Rendering is offline, not synchronized or real-time generation",
            "Playback may need a renderer supporting MP4 with multiple audio tracks"
        ]
    }
    (output / "episode-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("COMPLETE: " + str(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--tts", choices=("piper", "kokoro"), default="piper")
    parser.add_argument("--kokoro-model")
    parser.add_argument("--kokoro-voices")
    parser.add_argument("--kokoro-voice", default="af_heart")
    args = parser.parse_args()
    try:
        run(args)
    except Exception as error:
        print("Episode processing failed ({}): {}".format(
            type(error).__name__, str(error)[:350]), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
