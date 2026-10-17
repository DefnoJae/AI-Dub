"""Isolated Kokoro runtime; keep numpy 2 away from Chatterbox/UVR."""
import argparse
import json
from pathlib import Path


def main():
    import os
    import tempfile
    root = Path(__file__).resolve().parents[1]
    scratch = root / '.ai-dub/natural-temp'
    scratch.mkdir(parents=True,exist_ok=True)
    os.environ['TEMP'] = os.environ['TMP'] = str(scratch)
    tempfile.tempdir = str(scratch)
    import numpy as np
    import soundfile as sf
    from kokoro_onnx import Kokoro
    class CompatibleKokoro(Kokoro):
        def _create_audio(self, phonemes, voice, speed):
            # The 0.4.9 package casts speed to int for input_ids exports, but
            # the pinned v1.0 model expects float. Use the model's own schema.
            tokens = self.tokenizer.tokenize(phonemes)[:508]
            name = 'input_ids' if any(x.name == 'input_ids' for x in self.sess.get_inputs()) else 'tokens'
            inputs = {name: np.asarray([[0,*tokens,0]],dtype=np.int64),
                      'style': np.asarray(voice[len(tokens)],dtype=np.float32),
                      'speed': np.asarray([speed],dtype=np.float32)}
            return self.sess.run(None,inputs)[0],24000
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding='utf8'))
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = min(4,os.cpu_count() or 1)
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(root / '.ai-dub/models/kokoro/kokoro-v1.0.onnx'),
                                   sess_options=options,providers=['CPUExecutionProvider'])
    voice = CompatibleKokoro.from_session(session,str(root / '.ai-dub/models/kokoro/voices-v1.0.bin'))
    speed = 1.0
    # Resynthesize with a native rate adjustment before any small final FFmpeg fit.
    for attempt in range(3):
        samples, rate = voice.create(request['text'], voice=request['voice'], speed=speed, lang='en-us')
        from studio.alignment import trim_silence
        trimmed, _ = trim_silence(samples, rate)
        ratio = len(trimmed) / rate / request['seconds']
        if ratio <= 1.35:
            break
        speed = min(1.4, max(.85, speed * ratio))
    output = Path(request['output'])
    sf.write(output.with_suffix('.partial.wav'), samples, rate, subtype='PCM_16')
    output.with_suffix('.partial.wav').replace(output)


if __name__ == '__main__':
    main()
