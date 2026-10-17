import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
import wave

spec = importlib.util.spec_from_file_location('dub_clip', Path(__file__).parents[1] / 'companion/dub_clip.py')
clip = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clip)


class Voice:
    class config:
        sample_rate = 16000

    def synthesize_wav(self, text, wav):
        wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        wav.writeframes(b'\x01\x00' * 16000)


class AudioTests(unittest.TestCase):
    def test_invalid_windows(self):
        for start, seconds in [(-1, 20), (0, 31), (0, 0), (float('nan'), 20), (0, float('inf'))]:
            with self.assertRaises(ValueError):
                clip.validate_window(start, seconds)

    def test_utterances_are_not_clipped_or_overlapped(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            records = clip.render_speech([
                {'start': 0, 'end': .5, 'text': 'one'},
                {'start': .5, 'end': 1, 'text': 'two'}], Voice(), out, 1)
            self.assertEqual(records[1]['actualStart'], 1)
            self.assertEqual(records[1]['startDrift'], .5)
            with wave.open(str(out / 'english-dialogue.wav')) as wav:
                self.assertEqual(wav.getnframes(), 32000)

    def test_decode_bounds_and_silence(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'test.wav'
            tone = .1 * np.sin(np.arange(48000) * .1)
            clip.write_wav(file, tone, 16000)
            decoded = clip.decode_clip(file, 1, 1)
            self.assertEqual(len(decoded), 16000)
            self.assertGreater(float(np.max(np.abs(decoded))), .09)
            clip.write_wav(file, np.zeros(16000), 16000)
            with self.assertRaisesRegex(ValueError, 'silent'):
                clip.decode_clip(file, 0, 1)


if __name__ == '__main__':
    unittest.main()
