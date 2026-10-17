"""Offline timing and voice adapter tests; no models are downloaded."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
import wave

import numpy as np

HERE = Path(__file__).resolve().parent.parent / "companion"
sys.path.insert(0, str(HERE))
from episode_dub import synthesize, validate_source
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
