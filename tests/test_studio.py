import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace, ModuleType
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from studio import pipeline


class StudioTests(unittest.TestCase):
    def test_speaker_consistency_and_invalid_embedding(self):
        self.assertEqual(pipeline.cluster([[1, 0], [0, 1], [.99, .01], [.01, .99]]),
                         ['speaker-01', 'speaker-02', 'speaker-01', 'speaker-02'])
        with self.assertRaises(ValueError):
            pipeline.cluster([[0, 0]])

    def test_validation_and_cache_keys(self):
        script = dict(speakers={'a': dict(start=0, end=2)},
                      lines=[dict(start=0, end=2, speaker='a', text='Hello.')])
        pipeline.validate_script(script, 61)
        before = pipeline.digest(script)
        script['lines'][0]['text'] = 'Changed.'
        self.assertNotEqual(before, pipeline.digest(script))
        script['lines'][0]['start'] = float('nan')
        with self.assertRaises(ValueError):
            pipeline.validate_script(script, 61)

    @unittest.skipUnless(importlib.util.find_spec('soundfile') and importlib.util.find_spec('torch'), 'quality runtime needed')
    def test_real_ffmpeg_multichunk_resume_edit_and_english_only_export(self):
        """Real IO/muxing with deterministic model doubles; no downloaded models required."""
        import av
        import imageio_ffmpeg
        import numpy as np
        import soundfile as sf
        import torch
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        calls = dict(separation=0, translation=0, generation=0)
        class Separator:
            def __init__(self, output_dir, **kwargs):
                self.output_dir = output_dir
                self.model_instance = self
            def load_model(self, **kwargs):
                pass
            def separate(self, source):
                calls['separation'] += 1
                info = sf.info(source)
                names = ['audio_(Vocals).wav', 'audio_(Instrumental).wav']
                for name, level in zip(names, [.3, .1]):
                    sf.write(Path(self.output_dir) / name, np.full((info.frames, 2), level), 44100, subtype='FLOAT')
                return names
        class Whisper:
            def __init__(self, *args, **kwargs):
                pass
            def transcribe(self, *args, **kwargs):
                calls['translation'] += 1
                return [], SimpleNamespace(language='ja')
        class Voice:
            sr = 24000
            @classmethod
            def from_local(cls, *args, **kwargs):
                return cls()
            def generate(self, *args, **kwargs):
                calls['generation'] += 1
                return torch.full((1, 2400), .2)
        modules = {}
        for name, attr, value in [('audio_separator.separator', 'Separator', Separator),
                                  ('faster_whisper', 'WhisperModel', Whisper),
                                  ('chatterbox.mtl_tts', 'ChatterboxMultilingualTTS', Voice)]:
            modules[name] = ModuleType(name)
            setattr(modules[name], attr, value)
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            source = folder / 'source.mp4'
            subprocess.run([ffmpeg, '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1',
                '-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=44100', '-t', '61',
                '-c:v', 'libx264', '-c:a', 'aac', str(source)], check=True)
            project = folder / 'project'
            project.mkdir()
            script = dict(speakers={'a': dict(start=0, end=2)}, lines=[
                dict(start=.2, end=2, speaker='a', text='Hello.'),
                dict(start=59.95, end=60.8, speaker='a', text='Boundary.')])
            pipeline.save(project / 'script.json', script)
            args = SimpleNamespace(input=str(source), project=str(project), seconds=None,
                                   threshold=.28, whisper='unused-local-model', analyze=False)
            with patch.dict(sys.modules, modules):
                pipeline.run(args)
                self.assertEqual(calls, dict(separation=2, translation=2, generation=2))
                original_media = pipeline.media
                def interrupted_mux(ffmpeg, argv, target):
                    if target.name == 'AI-Dub-English.mp4':
                        raise RuntimeError('simulated interrupted export')
                    return original_media(ffmpeg, argv, target)
                with patch.object(pipeline, 'media', interrupted_mux):
                    with self.assertRaisesRegex(RuntimeError, 'interrupted export'):
                        pipeline.run(args)
                pipeline.run(args)
                self.assertEqual(calls, dict(separation=2, translation=2, generation=2))
                script['lines'][1]['text'] = 'Edited boundary.'
                pipeline.save(project / 'script.json', script)
                pipeline.run(args)
                self.assertEqual(calls['generation'], 3)
                args.threshold = .3
                with self.assertRaisesRegex(ValueError, 'settings changed'):
                    pipeline.run(args)
                args.threshold = .28
                source.touch()
                with self.assertRaisesRegex(ValueError, 'Source or settings changed'):
                    pipeline.run(args)
            with pipeline.project_lock(project):
                with self.assertRaises(OSError):
                    with pipeline.project_lock(project):
                        pass
            with av.open(str(project / 'AI-Dub-English.mp4')) as video:
                self.assertEqual(len(video.streams.audio), 1)
                self.assertEqual(len(video.streams.video), 1)
                self.assertAlmostEqual(video.duration / av.time_base, 61, delta=.1)
            with sf.SoundFile(project / 'english-mix.wav') as audio:
                audio.seek(10 * 44100)
                np.testing.assert_allclose(audio.read(100), .1, atol=1e-6)
            report = json.loads((project / 'report.json').read_text())
            self.assertFalse(report['originalAudioMixed'])


if __name__ == '__main__':
    unittest.main()
