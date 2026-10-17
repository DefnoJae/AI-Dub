"""Local reference-voice clip experiment with background separation and remixing.

This runner requires an explicit timed script with speaker/reference assignments.
It does not infer speaker identities or claim to preserve a performance exactly.
"""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def validate_script(script, duration):
    if not isinstance(script, dict) or not isinstance(script.get('speakers'), dict):
        raise ValueError('Script must define speakers')
    lines = script.get('lines')
    if not isinstance(lines, list) or not 1 <= len(lines) <= 30:
        raise ValueError('Script must contain 1–30 lines')
    for speaker, ref in script['speakers'].items():
        if not isinstance(speaker, str) or not isinstance(ref, dict):
            raise ValueError('Invalid speaker reference')
        start, end = ref.get('start'), ref.get('end')
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in [start, end]):
            raise ValueError('Invalid reference timestamps')
        if not 0 <= start < end <= duration or end - start < 1:
            raise ValueError('Reference must be at least one second inside the clip')
    previous_end = 0
    for line in lines:
        start, end = line.get('start'), line.get('end')
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in [start, end]):
            raise ValueError('Invalid line timestamps')
        if not 0 <= start < end <= duration or start < previous_end:
            raise ValueError('Lines must be ordered, non-overlapping, and inside the clip')
        if line.get('speaker') not in script['speakers']:
            raise ValueError('Line references an undefined speaker')
        if not isinstance(line.get('text'), str) or not 1 <= len(line['text'].strip()) <= 500:
            raise ValueError('Each line requires English text of at most 500 characters')
        previous_end = end
    return script


def tools_dir():
    import imageio_ffmpeg
    folder = Path('.ai-dub/tools').resolve()
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
    if not target.exists():
        shutil.copy2(imageio_ffmpeg.get_ffmpeg_exe(), target)
    os.environ['PATH'] = str(folder) + os.pathsep + os.environ.get('PATH', '')
    return str(target)


def decode_stereo(source, output, seconds, ffmpeg):
    subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-i', str(source), '-t', str(seconds),
                    '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', str(output)], check=True)


def fit_take(samples, rate, seconds, ffmpeg, work):
    """Pitch-preserving atempo fit; reject rather than extreme-speed or clipped speech."""
    import soundfile as sf
    speed = max(1.0, len(samples) / rate / seconds)
    raw = work / 'raw.wav'
    fitted = work / 'fitted.wav'
    sf.write(raw, samples, rate, subtype='PCM_16')
    if speed > 1.6:
        raise ValueError(f'Take cannot fit naturally (speed {speed:.2f}); shorten/lengthen script text')
    subprocess.run([ffmpeg, '-y', '-v', 'error', '-nostdin', '-i', str(raw), '-af', f'atempo={speed:.8f}',
                    '-ar', '44100', '-ac', '1', str(fitted)], check=True)
    take, out_rate = sf.read(fitted, dtype='float32')
    return take, out_rate, speed


def mix_tracks(background, dialogue):
    import numpy as np
    if len(background) != len(dialogue) or background.ndim != 2 or background.shape[1] != 2:
        raise ValueError('Background must be stereo and aligned with dialogue')
    mixed = background + dialogue[:, None]
    peak = float(np.max(np.abs(mixed)))
    gain = min(1.0, .98 / max(peak, 1e-9))
    return mixed * gain, gain


def run(args):
    os.environ.setdefault('PKUSEG_HOME', str(Path('.ai-dub/models/pkuseg').resolve()))
    import numpy as np
    import soundfile as sf
    import torch
    from audio_separator.separator import Separator
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    from huggingface_hub import snapshot_download
    if not math.isfinite(args.seconds) or not 0 < args.seconds <= 30:
        raise ValueError('Select at most 30 seconds')
    source = Path(args.input).resolve(strict=True)
    script = json.loads(Path(args.script).read_text(encoding='utf8'))
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=args.resume)
    started = time.monotonic()
    torch.set_num_threads(max(1, min(6, os.cpu_count() or 1)))
    ffmpeg = tools_dir()
    source_wav = output / 'source.wav'
    if not args.resume or not source_wav.exists():
        decode_stereo(source, source_wav, args.seconds, ffmpeg)
    original, rate = sf.read(source_wav, dtype='float32', always_2d=True)
    duration = len(original) / rate
    validate_script(script, duration)
    print('Separating source vocals and background locally...', flush=True)
    separator = None
    stems = list(output.glob('source_(*)_*.wav')) if args.resume else []
    if not stems:
        separator = Separator(output_dir=str(output), output_format='WAV',
                              model_file_dir=str(Path('.ai-dub/models/separation').resolve()))
        separator.load_model(model_filename=args.separator_model)
        stems = [output / name for name in separator.separate(str(source_wav))]
    vocals_path = next((p for p in stems if '(Vocals)' in p.name), None)
    background_path = next((p for p in stems if '(Instrumental)' in p.name or '(Other)' in p.name), None)
    if vocals_path is None or background_path is None:
        raise ValueError('Separator did not produce named vocals and background stems')
    vocals, vocal_rate = sf.read(vocals_path, dtype='float32', always_2d=True)
    background, bg_rate = sf.read(background_path, dtype='float32', always_2d=True)
    if vocal_rate != rate or bg_rate != rate or background.shape != original.shape:
        raise ValueError('Separated stems do not match source timing/format')
    references = {}
    for speaker, reference in script['speakers'].items():
        file = output / f'reference-{len(references):02}.wav'
        samples = vocals[round(reference['start'] * rate):round(reference['end'] * rate)].mean(axis=1)
        if float(np.max(np.abs(samples))) < .001:
            raise ValueError('Speaker reference is silent after separation')
        sf.write(file, samples, rate, subtype='PCM_16')
        references[speaker] = file
    del separator
    print('Loading local reference-voice model on CPU...', flush=True)
    model_dir = Path(args.model).resolve()
    if args.download_models:
        snapshot_download('ResembleAI/chatterbox', local_dir=str(model_dir),
                          allow_patterns=['ve.pt', 't3_mtl23ls_v2.safetensors', 's3gen.pt',
                                          'grapheme_mtl_merged_expanded_v1.json', 'Cangjie5_TC.json'])
    model = ChatterboxMultilingualTTS.from_local(str(model_dir), device='cpu')
    dialogue = np.zeros(len(original), dtype=np.float32)
    records = []
    for index, line in enumerate(script['lines']):
        print(f'Generating reference-conditioned line {index + 1}/{len(script["lines"])}...', flush=True)
        take_dir = output / f'line-{index:02}'
        take_dir.mkdir(exist_ok=args.resume)
        torch.manual_seed(args.seed + index)
        if args.resume and (take_dir / 'raw.wav').exists():
            samples, cached_rate = sf.read(take_dir / 'raw.wav', dtype='float32')
            if cached_rate != model.sr:
                raise ValueError('Cached take rate does not match model')
        else:
            samples = model.generate(line['text'], language_id='en',
                                     audio_prompt_path=str(references[line['speaker']]),
                                     cfg_weight=0.0, exaggeration=0.4).squeeze().detach().cpu().numpy()
        fitted, fitted_rate, speed = fit_take(samples, model.sr, line['end'] - line['start'], ffmpeg, take_dir)
        start = round(line['start'] * rate)
        # FFmpeg time-stretch may have a small tail. Reject audible overrun instead of silently cutting it.
        end = start + len(fitted)
        if end > len(dialogue) or len(fitted) > round((line['end'] - line['start']) * rate) + int(.08 * rate):
            raise ValueError('Fitted utterance overruns its allocated slot')
        dialogue[start:end] += fitted
        records.append({**line, 'speed': speed, 'renderedDuration': len(fitted) / fitted_rate})
    mixed, gain = mix_tracks(background, dialogue)
    sf.write(output / 'english-dialogue.wav', dialogue, rate, subtype='PCM_16')
    sf.write(output / 'english-mix.wav', mixed, rate, subtype='PCM_16')
    subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-i', str(source), '-i', str(output / 'english-mix.wav'),
                    '-map', '0:v:0', '-map', '1:a:0', '-t', str(duration), '-c:v', 'copy', '-c:a', 'aac',
                    '-movflags', '+faststart', str(output / 'english-preview.mp4')], check=True)
    report = {'status': 'generated-unreviewed', 'duration': duration, 'elapsedSeconds': time.monotonic() - started,
              'model': 'Chatterbox Multilingual', 'device': 'cpu', 'separationModel': args.separator_model,
              'translationSource': script.get('translationSource', 'user-supplied timed script'),
              'speakerAssignment': 'explicit script references; not automatic diarization',
              'mixGain': gain, 'lines': records, 'cloudInference': False, 'playerIntegrated': False,
              'limitations': ['Voice resemblance and acting need listening review',
                              'Separation can leave speech bleed or remove sound effects',
                              'No lip synchronization; CPU processing is not real time']}
    (output / 'quality-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print(f'Completed quality experiment: {output}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    parser.add_argument('--script', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--seconds', type=float, default=20)
    parser.add_argument('--model', default='.ai-dub/models/chatterbox')
    parser.add_argument('--separator-model', default='UVR-MDX-NET-Inst_HQ_3.onnx')
    parser.add_argument('--download-models', action='store_true')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--resume', action='store_true', help='Reuse intermediate audio in an existing output folder; only with the same source/script')
    try:
        run(parser.parse_args())
    except Exception as error:
        print(f'Quality experiment failed: {type(error).__name__}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
