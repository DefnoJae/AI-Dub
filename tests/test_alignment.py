from pathlib import Path
import importlib.util
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
from studio.alignment import conversational, spoken_text, translate_windows, trim_silence, fit_aligned


class AlignmentTests(unittest.TestCase):
    def test_generated_silence_does_not_delay_the_voice(self):
        rate = 24000
        voice = np.sin(np.arange(rate) * .1).astype('float32') * .2
        audio = np.concatenate([np.zeros(rate // 2), voice, np.zeros(rate // 4)])
        trimmed, removed = trim_silence(audio, rate)
        self.assertAlmostEqual(removed, .49, places=2)
        self.assertLessEqual(len(trimmed) / rate, 1.03)
        with self.assertRaises(ValueError):
            trim_silence(np.zeros(rate), rate)

    def test_translation_timestamps_cannot_move_source_speech(self):
        model = SimpleNamespace()
        def transcribe(clip, task, **kwargs):
            # Deliberately wrong broad Whisper times must be ignored for placement.
            return iter([SimpleNamespace(start=0, end=30, text='I do not know.', words=[])]), None
        model.transcribe = transcribe
        with patch('studio.alignment.speech_windows', return_value=(np.zeros(160000), [dict(start=3.1, end=4.2)])):
            line = translate_windows(model, 'unused', 60, 10)[0]
        self.assertEqual(line['start'], 63.1)
        self.assertEqual(line['end'], 64.2)
        self.assertEqual(line['text'], 'I do not know.')
        self.assertEqual(spoken_text(line), "I don't know.")

    @unittest.skipUnless(importlib.util.find_spec('soundfile'), 'soundfile needed for stretching test')
    def test_fit_both_ends_and_reject_unnatural_rate(self):
        import imageio_ffmpeg
        import soundfile as sf
        rate = 24000
        tone = np.sin(np.arange(rate) * .1).astype('float32') * .2
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            for duration in (1.2, .85):
                timing = fit_aligned(tone, rate, duration, imageio_ffmpeg.get_ffmpeg_exe(), work)
                self.assertEqual(sf.info(work / 'fitted.wav').frames, round(duration * 44100))
                self.assertEqual(timing['renderedDuration'], duration)
            for duration in (.25,):
                with self.assertRaisesRegex(ValueError, 'dubText'):
                    fit_aligned(tone, rate, duration, imageio_ffmpeg.get_ffmpeg_exe(), work)
            short = fit_aligned(tone, rate, 4, imageio_ffmpeg.get_ffmpeg_exe(), work)
            self.assertGreater(short['paddingSeconds'],2)
            self.assertEqual(short['speed'],.75)
            paused = fit_aligned(tone,rate,2,imageio_ffmpeg.get_ffmpeg_exe(),work,
                                 pauses=[(.5,1.2)],word_boundaries=[.5])
            self.assertEqual(paused['paddingPlacement'],'between words at source hesitation')
            audio,_=sf.read(work/'fitted.wav')
            self.assertEqual(len(audio),88200)
            self.assertGreater(float(np.max(np.abs(audio[-4000:-1000]))),.1)

    def test_natural_text_keeps_translation_available(self):
        self.assertEqual(conversational('I do not know. You are here.'), "I don't know. You're here.")
        self.assertEqual(spoken_text(dict(text='Original', dubText='Spoken version')), 'Spoken version')


if __name__ == '__main__':
    unittest.main()
