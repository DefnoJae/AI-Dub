"""Offline short-clip proof of concept. No server or player control."""
import argparse
import io
import json
import math
import os
from pathlib import Path
import sys
import wave

# Never fetch models implicitly while processing source audio.
os.environ['HF_HUB_OFFLINE'] = '1'


def validate_window(start, seconds):
    if not math.isfinite(start) or start < 0:
        raise ValueError('start must be finite and nonnegative')
    if not math.isfinite(seconds) or not 0 < seconds <= 30:
        raise ValueError('seconds must be between 0 and 30')


def decode_clip(source, start, seconds, audio_stream=0):
    import av
    import numpy as np
    validate_window(start, seconds)
    # This CLI only accepts local files. Stream extraction is an explicit separate step.
    source = Path(source).resolve(strict=True)
    chunks = []
    with av.open(str(source)) as container:
        stream = container.streams.audio[audio_stream]
        if start:
            container.seek(int(start * av.time_base))
        resampler = av.AudioResampler(format='fltp', layout='mono', rate=16000)
        for frame in container.decode(stream):
            for converted in resampler.resample(frame):
                if converted.time is None:
                    raise ValueError('Audio has no timestamps')
                offset = converted.time
                data = converted.to_ndarray().reshape(-1)
                left = max(0, round((start - offset) * 16000))
                right = min(len(data), round((start + seconds - offset) * 16000))
                if right > left:
                    chunks.append(data[left:right])
                if offset + len(data) / 16000 >= start + seconds:
                    break
            else:
                continue
            break
    if not chunks:
        raise ValueError('No audio in the selected interval')
    audio = np.concatenate(chunks)[:round(seconds * 16000)]
    if np.max(np.abs(audio)) < 0.0001:
        raise ValueError('Selected audio is silent')
    return audio


def write_wav(file, samples, rate):
    import numpy as np
    with wave.open(str(file), 'wb') as output:
        output.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        output.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())


def render_speech(segments, voice, output_dir, duration):
    """Keep full utterances. Shift overlaps forward and report drift, never truncate."""
    import numpy as np
    rate = voice.config.sample_rate
    track = np.zeros(round(duration * rate), dtype=np.float32)
    cursor = 0
    records = []
    for index, segment in enumerate(segments):
        text = segment['text'].strip()
        if not text:
            continue
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            voice.synthesize_wav(text, wav)
        buffer.seek(0)
        with wave.open(buffer, 'rb') as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != rate:
                raise ValueError('Unsupported synthesized PCM format')
            speech = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
        desired = round(segment['start'] * rate)
        position = max(cursor, desired)
        end = position + len(speech)
        if end > len(track):
            track = np.pad(track, (0, end - len(track)))
        track[position:end] = speech
        cursor = end
        write_wav(output_dir / f'segment-{index:03}.wav', speech, rate)
        records.append({**segment, 'actualStart': position / rate, 'actualEnd': end / rate,
                        'startDrift': (position - desired) / rate,
                        'overrun': max(0, end / rate - segment['end'])})
    if not records:
        raise ValueError('No speech segments to synthesize')
    write_wav(output_dir / 'english-dialogue.wav', track, rate)
    return records


def run(args):
    from faster_whisper import WhisperModel
    from voice_engine import load_voice
    validate_window(args.start, args.seconds)
    model_path = Path(args.model).resolve(strict=True)
    voice_path = Path(args.voice).resolve(strict=True)
    audio = decode_clip(args.input, args.start, args.seconds, args.audio_stream)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)  # Never overwrite an earlier result.
    write_wav(output / 'source.wav', audio, 16000)
    print('Transcribing locally...', flush=True)
    model = WhisperModel(str(model_path), device='cpu', compute_type='int8', local_files_only=True)
    segments, info = model.transcribe(audio, task='transcribe', beam_size=5, vad_filter=False,
                                      condition_on_previous_text=False)
    transcript = [{'start': s.start, 'end': s.end, 'text': s.text} for s in segments]
    if info.language != 'ja':
        raise ValueError(f'Expected Japanese speech, detected {info.language}; choose a Japanese interval/track')
    print('Translating speech to English locally...', flush=True)
    translated, _ = model.transcribe(audio, language='ja', task='translate', beam_size=5,
                                     vad_filter=False, condition_on_previous_text=False)
    english = [{'start': s.start, 'end': s.end, 'text': s.text} for s in translated]
    if not transcript or not english:
        raise ValueError('No recognized speech; no dub was generated')
    print('Synthesizing English locally...', flush=True)
    voice = load_voice(args.tts, voice_path, args.kokoro_model, args.kokoro_voices, args.kokoro_voice)
    timing = render_speech(english, voice, output, len(audio) / 16000)
    report = {'status': 'generated-unreviewed', 'sourceLanguage': info.language,
              'languageProbability': info.language_probability, 'clipStart': args.start,
              'clipDuration': len(audio) / 16000, 'model': model_path.name,
              'voice': args.tts + (':' + args.kokoro_voice if args.tts == 'kokoro' else ':' + voice_path.name),
              'transcript': transcript, 'english': timing,
              'cloudUsed': False, 'playerIntegrated': False,
              'limitations': ['Single generic voice; no speaker identity preservation',
                              'Dialogue only; no music/SFX separation or mixing',
                              'Utterances may overrun; inspect actualStart/actualEnd',
                              'Recognition and translation need human review']}
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Generated: {output / "english-dialogue.wav"}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', help='Local audio/video file, not a URL')
    parser.add_argument('--output', required=True, help='New output directory')
    parser.add_argument('--start', type=float, default=0)
    parser.add_argument('--seconds', type=float, default=20)
    parser.add_argument('--audio-stream', type=int, default=0)
    parser.add_argument('--model', default='.ai-dub/models/whisper-base')
    parser.add_argument('--voice', default='.ai-dub/models/piper/en_US-lessac-medium.onnx')
    parser.add_argument('--tts', choices=('piper', 'kokoro'), default='piper')
    parser.add_argument('--kokoro-model')
    parser.add_argument('--kokoro-voices')
    parser.add_argument('--kokoro-voice', default='af_heart')
    args = parser.parse_args()
    try:
        run(args)
    except Exception as error:
        print(f'Clip processing failed ({type(error).__name__}). No completed dub is claimed. {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
