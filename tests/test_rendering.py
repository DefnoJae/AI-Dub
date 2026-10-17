import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from studio import rendering
from studio.pipeline import save,digest,cluster


class SpeakerTests(unittest.TestCase):
    def test_short_interjection_does_not_invent_a_third_actor(self):
        labels = cluster([[1,0],[0,1],[.95,.05],[.01,.99]], durations=[2,2,.6,2])
        self.assertEqual(labels,['speaker-01','speaker-02','speaker-02','speaker-02'])


@unittest.skipUnless(importlib.util.find_spec('soundfile') and importlib.util.find_spec('torch'), 'quality runtime needed')
class RecoveryTests(unittest.TestCase):
    def test_verification_removes_long_tail_and_rejects_wrong_words(self):
        import numpy as np
        import soundfile as sf
        import torch
        import imageio_ffmpeg
        class Voice:
            sr=24000
            def generate(self,*args,**kwargs):
                return torch.tensor(np.sin(np.arange(72000)*.1)*.2).float()[None,:]
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            ref=folder/'ref.wav'
            sf.write(ref,np.ones(24000)*.1,24000)
            line=dict(start=0,end=1,text='Test.',speaker='a')
            good=lambda path:('Test.',[SimpleNamespace(start=0,end=.97)])
            result=rendering.render_take(line,0,'reference','af_heart',(ref,'hash'),folder,folder,
                imageio_ffmpeg.get_ffmpeg_exe(),lambda:Voice(),save,digest,good)
            self.assertEqual(sf.info(result).frames,44100)
            marker=json.loads(result.parents[1].joinpath('complete.json').read_text())
            self.assertTrue(marker['wordsVerified'])
            bad=lambda path:('Wrong words',[SimpleNamespace(start=0,end=.97)])
            with self.assertRaisesRegex(ValueError,'did not match'):
                rendering.render_take(dict(line,text='Expected sentence'),1,'reference','af_heart',(ref,'hash'),folder,folder,
                    imageio_ffmpeg.get_ffmpeg_exe(),lambda:Voice(),save,digest,bad)

    def test_bad_cached_delivery_is_skipped_then_new_take_resumes(self):
        import numpy as np
        import soundfile as sf
        import torch
        import imageio_ffmpeg
        class Voice:
            sr=24000
            calls=0
            def generate(self,*args,**kwargs):
                self.calls+=1
                return torch.tensor(np.sin(np.arange(self.sr*(3 if self.calls<3 else 1))*.1)*.2).float()[None,:]
        voice=Voice()
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            ref=folder/'ref.wav'
            sf.write(ref,np.ones(24000)*.1,24000)
            line=dict(start=0,end=1,text='Test.',speaker='a')
            def render():
                return rendering.render_take(line,0,'reference','af_heart',(ref,'hash'),folder,folder,
                    imageio_ffmpeg.get_ffmpeg_exe(),lambda:voice,save,digest)
            result=render()
            self.assertEqual(voice.calls,3)
            self.assertEqual(sf.info(result).frames,44100)
            render()
            self.assertEqual(voice.calls,3)
            result.parents[1].joinpath('complete.json').unlink()
            render()
            self.assertEqual(voice.calls,3)

    def test_fallback_replaces_every_line_for_same_speaker(self):
        import numpy as np
        import soundfile as sf
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            ref=folder/'ref.wav'
            sf.write(ref,np.ones(24000)*.1,24000)
            script=dict(speakers={'a':dict(start=0,end=1)},lines=[dict(start=0,end=1,text='First',speaker='a'),dict(start=2,end=3,text='Second',speaker='a')])
            calls=[]
            def fake(line,index,mode,*args):
                calls.append((index,mode))
                if mode=='reference' and index==1:
                    raise ValueError('No fitting reference take')
                return ref
            with patch.object(rendering,'render_take',fake):
                takes,plan=rendering.render_speakers(script,{'a':(ref,'hash')},folder,folder,'unused',save,digest)
                self.assertEqual(calls,[(0,'reference'),(1,'reference'),(0,'natural'),(1,'natural')])
                self.assertEqual(plan['a']['engine'],'natural')
                calls.clear()
                rendering.render_speakers(script,{'a':(ref,'hash')},folder,folder,'unused',save,digest)
                self.assertEqual(calls,[(0,'natural'),(1,'natural')])


if __name__=='__main__':
    unittest.main()
