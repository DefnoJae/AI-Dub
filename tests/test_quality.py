import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('quality_clip', Path(__file__).parents[1] / 'companion/quality_clip.py')
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


class QualityTests(unittest.TestCase):
    def script(self):
        return {'speakers': {'a': {'start': 0, 'end': 2}},
                'lines': [{'start': 0, 'end': 2, 'speaker': 'a', 'text': 'Example.'}]}

    def test_script_rejects_unknown_speakers_and_overlaps(self):
        script = self.script()
        quality.validate_script(script, 3)
        script['lines'][0]['speaker'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'undefined speaker'):
            quality.validate_script(script, 3)
        script = self.script()
        script['lines'].append({'start': 1, 'end': 3, 'speaker': 'a', 'text': 'Overlap.'})
        with self.assertRaisesRegex(ValueError, 'non-overlapping'):
            quality.validate_script(script, 3)

    def test_references_and_lines_cannot_escape_source(self):
        for value in [float('nan'), -1, 50]:
            script = self.script()
            script['speakers']['a']['end'] = value
            with self.assertRaises(ValueError):
                quality.validate_script(script, 3)

    def test_remix_keeps_background_and_limits_peaks(self):
        import numpy as np
        background = np.full((100, 2), .1, dtype=np.float32)
        dialogue = np.zeros(100, dtype=np.float32)
        mixed, gain = quality.mix_tracks(background, dialogue)
        np.testing.assert_array_equal(mixed, background)
        self.assertEqual(gain, 1)
        dialogue[:] = 1
        mixed, gain = quality.mix_tracks(background, dialogue)
        self.assertLessEqual(float(np.max(np.abs(mixed))), .980001)
        self.assertLess(gain, 1)
        with self.assertRaises(ValueError):
            quality.mix_tracks(background, dialogue[:10])


if __name__ == '__main__':
    unittest.main()
