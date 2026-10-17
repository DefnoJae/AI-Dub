"""Offline timing and voice adapter tests; no models are downloaded."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import subprocess
import types
import unittest
from unittest import mock
import wave

import numpy as np

HERE = Path(__file__).resolve().parent.parent / "companion"
sys.path.insert(0, str(HERE))
from episode_dub import synthesize, validate_source, ffmpeg_binary, package_episode, run, command
from voice_engine import KokoroVoice


class FakeSegment:
    def __init__(self, start, end, text):
        self.start, self.end, self.text = start, end, text


class FakePiper:
    def __init__(self):
        self.config = types.SimpleNamespace(sample_rate=1000)

    def synthesize_wav(self, text, writer):
        writer.setparams((1, 2, 1000, 0, "NONE", "not compressed"))
        writer.writeframes((np.ones(200) * 1000).astype("<i2").tobytes())


class FakeKokoro:
    def __init__(self, model, voices):
        self.names = (model, voices)

    def create(self, text, voice, speed, lang):
        assert voice == "af_heart"
        assert lang == "en-us"
        assert text
        return np.ones(1200, dtype=np.float32) * 0.2, 24000


class TestEpisodeVoice(unittest.TestCase):
    def test_episode_timing_is_padded_and_no_overlaps(self):
        with tempfile.TemporaryDirectory() as tmp:
            pcm, rate, lines = synthesize(
                [FakeSegment(0, 1, "Hello."), FakeSegment(0.1, 0.8, "Hi.")],
                FakePiper(), Path(tmp), 3)
            self.assertEqual(rate, 1000)
            self.assertEqual(pcm.stat().st_size, 6000)
            self.assertAlmostEqual(lines[0]["actualStart"], 0.0)
            self.assertAlmostEqual(lines[1]["actualStart"], 0.2)
            self.assertAlmostEqual(lines[1]["actualEnd"], 0.4)
            self.assertGreater(lines[1]["startDrift"], 0)

    def test_kokoro_wav_contract_without_loading_real_models(self):
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp, "model.onnx")
            voices = Path(tmp, "voices.bin")
            model.write_bytes(b"fake")
            voices.write_bytes(b"fake")
            original = sys.modules.get("kokoro_onnx")
            sys.modules["kokoro_onnx"] = types.SimpleNamespace(Kokoro=FakeKokoro)
            try:
                engine = KokoroVoice(model, voices)
                wav = Path(tmp, "voice.wav")
                with wave.open(str(wav), "wb") as out:
                    engine.synthesize_wav("Hello, world!", out)
                with wave.open(str(wav), "rb") as saved:
                    self.assertEqual(saved.getframerate(), 24000)
                    self.assertEqual(saved.getnchannels(), 1)
                    self.assertEqual(saved.getnframes(), 1200)
            finally:
                if original is None:
                    sys.modules.pop("kokoro_onnx", None)
                else:
                    sys.modules["kokoro_onnx"] = original

    def test_embedded_japanese_and_english_tracks_are_real(self):
        import av
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            ffmpeg = ffmpeg_binary()
            source = folder / "original.mp4"
            pcm = folder / "dialogue.pcm"
            output = folder / "dub.mp4"
            subprocess.run([ffmpeg, "-nostdin", "-loglevel", "error",
                            "-f", "lavfi", "-i", "color=c=black:s=96x96:r=10:d=2",
                            "-f", "lavfi", "-i", "sine=frequency=400:sample_rate=44100:duration=2",
                            "-c:v", "mpeg4", "-c:a", "aac", "-shortest", str(source)],
                           check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            pcm.write_bytes((np.sin(np.linspace(0, 1000, 48000)) * 10000).astype("<i2").tobytes())
            package_episode(source, pcm, 24000, output, ffmpeg)
            self.assertGreater(output.stat().st_size, 1000)
            with av.open(str(output)) as container:
                self.assertEqual(len(container.streams.video), 1)
                self.assertEqual(len(container.streams.audio), 2)
                self.assertEqual(container.streams.audio[0].metadata.get("language"), "eng")
                self.assertEqual(container.streams.audio[1].metadata.get("language"), "jpn")

    def test_entire_episode_pipeline_with_fake_models_real_ffmpeg(self):
        import av
        import json
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            ffmpeg = ffmpeg_binary()
            source = folder / "original.mp4"
            output = folder / "ready"
            subprocess.run([ffmpeg, "-nostdin", "-loglevel", "error",
                            "-f", "lavfi", "-i", "color=c=black:s=96x96:r=10:d=2",
                            "-f", "lavfi", "-i", "sine=frequency=400:sample_rate=44100:duration=2",
                            "-c:v", "mpeg4", "-c:a", "aac", "-shortest", str(source)],
                           check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            class FakeWhisper:
                def __init__(self, *args, **kwargs):
                    pass

                def transcribe(self, *args, **kwargs):
                    return iter([FakeSegment(0.0, 1.0, "Hello there.")]), types.SimpleNamespace(
                        language="ja", language_probability=0.99)
            fake_whisper = types.SimpleNamespace(WhisperModel=FakeWhisper)
            args = types.SimpleNamespace(input=str(source), output=str(output),
                                         model=str(folder), voice=str(folder),
                                         tts="piper", kokoro_model=None, kokoro_voices=None,
                                         kokoro_voice="af_heart")
            with mock.patch.dict(sys.modules, {"faster_whisper": fake_whisper}):
                with mock.patch("voice_engine.load_voice", return_value=FakePiper()):
                    run(args)
            report = json.loads((output / "episode-report.json").read_text("utf-8"))
            self.assertEqual(report["status"], "generated-unreviewed")
            self.assertTrue(report["englishSegments"])
            self.assertTrue((output / "english-ai-dub.mp4").is_file())
            for name in ("source.mkv", "japanese-16k.wav", "english-dialogue.pcm"):
                self.assertFalse((output / name).exists(),
                                 "large temporary files should not remain after a successful render")
            with av.open(str(output / "english-ai-dub.mp4")) as ready:
                self.assertEqual(len(ready.streams.audio), 2)
                self.assertEqual(ready.streams.audio[0].metadata.get("language"), "eng")

    def test_failed_media_command_does_not_expose_signed_source(self):
        url = "https://example.org/movie.mp4?auth=do-not-print-me"
        with self.assertRaises(RuntimeError) as raised:
            command([sys.executable, "-c", "import sys; sys.exit(3)", url],
                    "Capture media")
        self.assertIn("exit 3", str(raised.exception))
        self.assertNotIn("do-not-print-me", str(raised.exception))

    def test_local_media_paths_require_real_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp, "source.mkv")
            source.write_bytes(b"video")
            self.assertEqual(validate_source(str(source)), str(source.resolve()))
            Path(tmp, "not-video.txt").write_text("not video", encoding="utf-8")
            with self.assertRaises(ValueError):
                validate_source(str(Path(tmp, "not-video.txt")))
            with self.assertRaises(ValueError):
                validate_source("ftp://example.com/video.mp4")


if __name__ == "__main__":
    unittest.main()
