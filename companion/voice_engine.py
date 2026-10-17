"""Voice adapters for AI Dub. Models are always loaded from local files.

Piper is a lightweight fallback. Kokoro ONNX provides more natural generic
English voices, but does not preserve original character identity.
"""
import io
import re
import wave
from pathlib import Path
from types import SimpleNamespace


class KokoroVoice:
    def __init__(self, model_path, voices_path, voice="af_heart"):
        from kokoro_onnx import Kokoro
        self.model = Kokoro(str(Path(model_path).resolve(strict=True)),
                            str(Path(voices_path).resolve(strict=True)))
        self.voice = voice
        self.config = SimpleNamespace(sample_rate=24000)

    def synthesize_wav(self, text, output):
        import numpy as np
        # Keep each inference under the recommended text window; concatenate
        # generated speech without inventing new words.
        chunks = []
        for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
            while len(sentence) > 300:
                cut = sentence.rfind(" ", 0, 300)
                if cut < 80:
                    cut = 300
                chunks.append(sentence[:cut].strip())
                sentence = sentence[cut:].strip()
            if sentence:
                chunks.append(sentence)
        if not chunks:
            raise ValueError("Empty English speech segment")
        pcm = []
        for chunk in chunks:
            samples, rate = self.model.create(chunk, voice=self.voice, speed=1.0, lang="en-us")
            if rate != 24000:
                raise ValueError("Unexpected Kokoro voice sampling rate")
            if len(samples) == 0:
                raise ValueError("Kokoro returned empty speech")
            pcm.append(np.asarray(samples, dtype=np.float32))
        audio = np.concatenate(pcm)
        pcm16 = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
        output.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
        output.writeframes(pcm16.tobytes())


def load_voice(engine, piper_path, kokoro_model=None, kokoro_voices=None,
               kokoro_voice="af_heart"):
    if engine == "piper":
        from piper import PiperVoice
        return PiperVoice.load(str(Path(piper_path).resolve(strict=True)), use_cuda=False)
    if engine == "kokoro":
        if not kokoro_model or not kokoro_voices:
            raise ValueError("Kokoro local models not configured")
        return KokoroVoice(kokoro_model, kokoro_voices, kokoro_voice)
    raise ValueError("Unsupported voice engine; expected piper or kokoro")
