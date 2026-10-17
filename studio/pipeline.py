"""Resumable, disk-backed dubbing. Never mix the original audio into the dub."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'companion'))
RATE = 44100
VERSION = 1


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def save(path, value):
    temp = path.with_suffix(path.suffix + '.partial')
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf8')
    temp.replace(path)


@contextmanager
def project_lock(folder):
    """OS-owned lock releases even when a render process is terminated."""
    with (folder / '.lock').open('a+b') as handle:
        handle.seek(0)
        handle.write(b'0')
        handle.flush()
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def media(ffmpeg, args, target):
    temp = target.with_name(target.stem + '.partial' + target.suffix)
    subprocess.run([ffmpeg, '-y', '-nostdin', '-v', 'error', *map(str, args), str(temp)], check=True)
    temp.replace(target)


def cluster(embeddings, threshold=.28):
    """Deterministic complete-link cosine clustering without a new model dependency."""
    import numpy as np
    values = np.asarray(embeddings, dtype=np.float32)
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    if not np.isfinite(values).all() or (norms < 1e-8).any():
        raise ValueError('Invalid speaker embedding')
    values = values / norms
    groups = []
    labels = []
    for vector in values:
        distances = [max(1 - float(vector @ item) for item in group) for group in groups]
        best = min(range(len(groups)), key=lambda i: distances[i]) if groups else None
        if best is None or distances[best] > threshold:
            best = len(groups)
            groups.append([])
        groups[best].append(vector)
        labels.append(f'speaker-{best + 1:02}')
    return labels


def validate_script(script, duration):
    lines, speakers = script['lines'], script['speakers']
    if not lines or not speakers:
        raise ValueError('No dialogue found')
    for line in lines:
        a, b = line['start'], line['end']
        if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in (a, b)) or not 0 <= a < b <= duration + .001:
            raise ValueError('Dialogue timing is outside video')
        if line['speaker'] not in speakers or not isinstance(line['text'], str) or not 0 < len(line['text'].strip()) <= 500:
            raise ValueError('Each line needs a defined speaker and 1–500 characters')
    for ref in speakers.values():
        if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in (ref['start'], ref['end'])) or not 0 <= ref['start'] < ref['end'] <= duration + .001:
            raise ValueError('Invalid speaker reference')


def run(args):
    import av
    import numpy as np
    import soundfile as sf
    import torch
    from quality_clip import tools_dir, fit_take
    os.chdir(ROOT)
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ.setdefault('PKUSEG_HOME', str(ROOT / '.ai-dub/models/pkuseg'))
    source = Path(args.input).resolve(strict=True)
    folder = Path(args.project).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    with project_lock(folder):
        with av.open(str(source)) as container:
            if container.duration is None or not any(s.type == 'video' for s in container.streams):
                raise ValueError('Import a video with a known duration')
            duration = container.duration / av.time_base
        if not 0 < duration <= 45 * 60:
            raise ValueError('Video must be between 0 and 45 minutes')
        duration = min(duration, args.seconds) if args.seconds else duration
        settings = dict(version=VERSION, source=str(source), size=source.stat().st_size,
                        modified=source.stat().st_mtime_ns, duration=duration,
                        separator='UVR-MDX-NET-Inst_HQ_3.onnx', threshold=args.threshold,
                        whisper=str(Path(args.whisper).resolve()))
        manifest = folder / 'project.json'
        if manifest.exists() and json.loads(manifest.read_text(encoding='utf8')) != settings:
            raise ValueError('Source or settings changed. Choose a new project folder.')
        save(manifest, settings)
        ffmpeg = tools_dir()
        torch.set_num_threads(max(1, min(6, os.cpu_count() or 1)))
        chunks = []
        separator = None
        whisper = None
        for index, offset in enumerate(range(0, math.ceil(duration), 60)):
            work = folder / f'chunk-{index:04}'
            work.mkdir(exist_ok=True)
            length = min(60, duration - offset)
            print(f'Separating / translating minute {index + 1}/{math.ceil(duration / 60)}', flush=True)
            source_wav = work / 'source.wav'
            if not source_wav.exists():
                media(ffmpeg, ['-ss', offset, '-i', source, '-t', length, '-vn', '-ac', 2, '-ar', RATE], source_wav)
            stems_file = work / 'stems.json'
            if not stems_file.exists():
                if separator is None:
                    from audio_separator.separator import Separator
                    separator = Separator(output_dir=str(work), output_format='WAV', model_file_dir=str(ROOT / '.ai-dub/models/separation'))
                    separator.load_model(model_filename=settings['separator'])
                separator.output_dir = str(work)
                separator.model_instance.output_dir = str(work)
                stems = [Path(p) if Path(p).is_absolute() else work / p for p in separator.separate(str(source_wav))]
                vocal = next(p for p in stems if '(Vocals)' in p.name)
                bed = next(p for p in stems if '(Instrumental)' in p.name or '(Other)' in p.name)
                for path in (vocal, bed):
                    info = sf.info(path)
                    if info.samplerate != RATE or abs(info.duration - length) > .1:
                        raise ValueError('Separation changed audio timing')
                save(stems_file, dict(vocals=str(vocal), background=str(bed)))
            stems = json.loads(stems_file.read_text(encoding='utf8'))
            transcript = work / 'translation.json'
            if not transcript.exists():
                from faster_whisper import WhisperModel
                if whisper is None:
                    whisper = WhisperModel(settings['whisper'], device='cpu', compute_type='int8', local_files_only=True)
                segments, info = whisper.transcribe(stems['vocals'], task='translate', language='ja',
                    beam_size=5, vad_filter=True, condition_on_previous_text=False, temperature=0)
                lines = [dict(start=max(0, s.start) + offset, end=min(length, s.end) + offset,
                              text=s.text.strip()) for s in segments if s.text.strip() and s.start < length]
                save(transcript, lines)
            chunks.append(dict(offset=offset, length=length, work=work, **stems))
        del separator, whisper
        script_file = folder / 'script.json'
        if not script_file.exists():
            from chatterbox.models.voice_encoder import VoiceEncoder
            encoder = VoiceEncoder()
            encoder.load_state_dict(torch.load(ROOT / '.ai-dub/models/chatterbox/ve.pt', map_location='cpu', weights_only=True))
            encoder.eval()
            lines, embeddings = [], []
            for chunk in chunks:
                for line in json.loads((chunk['work'] / 'translation.json').read_text(encoding='utf8')):
                    print(f'Identifying speaker at {line["start"]:.1f}s', flush=True)
                    with sf.SoundFile(chunk['vocals']) as audio:
                        audio.seek(round((line['start'] - chunk['offset']) * RATE))
                        clip = audio.read(round(min(8, line['end'] - line['start']) * RATE), dtype='float32', always_2d=True).mean(axis=1)
                    if len(clip) < RATE // 4 or np.max(np.abs(clip)) < .001:
                        continue
                    embeddings.append(encoder.embeds_from_wavs([clip], RATE, trim_top_db=None)[0])
                    lines.append(line)
            if not lines:
                raise ValueError('No usable speech detected')
            labels = cluster(embeddings, args.threshold)
            speakers = {}
            for line, label in zip(lines, labels):
                line['speaker'] = label
                ref = speakers.get(label)
                if ref is None or line['end'] - line['start'] > ref['end'] - ref['start']:
                    speakers[label] = dict(start=line['start'], end=min(line['end'], line['start'] + 8))
            save(script_file, dict(speakers=speakers, lines=lines))
            del encoder
        script = json.loads(script_file.read_text(encoding='utf8'))
        validate_script(script, duration)
        if args.analyze:
            print('Analysis complete. Review script.json before rendering.', flush=True)
            return
        references = {}
        for speaker, ref in script['speakers'].items():
            # Read at most eight seconds, including references spanning chunk boundaries.
            parts = []
            end = min(ref['end'], ref['start'] + 8)
            for chunk in chunks:
                a, b = max(ref['start'], chunk['offset']), min(end, chunk['offset'] + chunk['length'])
                if b > a:
                    with sf.SoundFile(chunk['vocals']) as audio:
                        audio.seek(round((a - chunk['offset']) * RATE))
                        parts.append(audio.read(round((b-a)*RATE), dtype='float32', always_2d=True).mean(axis=1))
            samples = np.concatenate(parts)
            if len(samples) < RATE or np.max(np.abs(samples)) < .001:
                raise ValueError(f'{speaker} needs a clear reference of at least one second; edit script.json')
            ref_path = folder / f'reference-{digest(speaker)[:12]}.wav'
            sf.write(ref_path, samples, RATE, subtype='PCM_16')
            references[speaker] = (ref_path, hashlib.sha256(samples.tobytes()).hexdigest())
        model = None
        takes = []
        for index, line in enumerate(script['lines']):
            print(f'English line {index + 1}/{len(script["lines"])}', flush=True)
            ref, ref_hash = references[line['speaker']]
            key = digest(dict(line=line, reference=ref_hash, seed=42 + index, version=VERSION))
            work = folder / ('take-' + key)
            work.mkdir(exist_ok=True)
            complete = work / 'complete.json'
            if not complete.exists():
                raw = work / 'raw.wav'
                if not raw.exists():
                    if model is None:
                        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
                        model = ChatterboxMultilingualTTS.from_local(str(ROOT / '.ai-dub/models/chatterbox'), device='cpu')
                    torch.manual_seed(42 + index)
                    samples = model.generate(line['text'], language_id='en', audio_prompt_path=str(ref),
                                             cfg_weight=0.0, exaggeration=.4).squeeze().detach().cpu().numpy()
                    temp = work / 'raw.partial.wav'
                    sf.write(temp, samples, model.sr, subtype='PCM_16')
                    temp.replace(raw)
                samples, rate = sf.read(raw, dtype='float32')
                fit_dir = work / 'fit'
                fit_dir.mkdir(exist_ok=True)
                fitted, _, speed = fit_take(samples, rate, line['end'] - line['start'], ffmpeg, fit_dir)
                if len(fitted) > round((line['end'] - line['start']) * RATE) + round(.08 * RATE):
                    raise ValueError('Take overrun; shorten the English line in script.json')
                save(complete, dict(speed=speed))
            takes.append((line, work / 'fit/fitted.wav'))
        del model
        mix = folder / 'english-mix.wav'
        peak = 1.0
        temp_mix = folder / 'english-mix.partial.wav'
        with sf.SoundFile(temp_mix, 'w', samplerate=RATE, channels=2, subtype='FLOAT') as writer:
            for chunk in chunks:
                background, rate = sf.read(chunk['background'], dtype='float32', always_2d=True)
                if rate != RATE or background.shape[1] != 2:
                    raise ValueError('Expected stereo separated background')
                count = round((chunk['offset'] + chunk['length']) * RATE) - round(chunk['offset'] * RATE)
                background = np.pad(background[:count], ((0, max(0, count-len(background))), (0, 0)))
                origin = round(chunk['offset'] * RATE)
                for line, path in takes:
                    start = round(line['start'] * RATE)
                    info = sf.info(path)
                    a, b = max(start, origin), min(start + info.frames, origin + count, round(duration * RATE))
                    if b > a:
                        with sf.SoundFile(path) as audio:
                            audio.seek(a-start)
                            samples = audio.read(b-a, dtype='float32')
                        background[a-origin:b-origin] += samples[:, None]
                peak = max(peak, float(np.max(np.abs(background))))
                writer.write(background)
        temp_mix.replace(mix)
        print('Exporting English-only video', flush=True)
        result = folder / 'AI-Dub-English.mp4'
        media(ffmpeg, ['-i', source, '-i', mix, '-map', '0:v:0', '-map', '1:a:0', '-t', duration,
              '-c:v', 'libx264', '-preset', 'fast', '-crf', 18, '-pix_fmt', 'yuv420p', '-c:a', 'aac',
              '-af', f'volume={.98 / peak}', '-metadata:s:a:0', 'language=eng', '-movflags', '+faststart'], result)
        save(folder / 'report.json', dict(status='generated-unreviewed', duration=duration,
             speakers=len(script['speakers']), lines=len(takes), scriptHash=digest(script), originalAudioMixed=False,
             diarization='Chatterbox voice embeddings; complete-link cosine clustering',
             limitations=['Separation may leave Japanese speech residue or remove SFX.',
                          'Speaker changes within a Whisper segment and overlapping speech are not resolved.',
                          'Translation, speaker clusters, timing and voice resemblance need human review.',
                          'CPU rendering can take many hours; no lip synchronization.']))
        print('COMPLETE: ' + str(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--whisper', default=str(ROOT / '.ai-dub/models/whisper-base'))
    parser.add_argument('--threshold', type=float, default=.28)
    parser.add_argument('--seconds', type=float, help='Preview only; use a separate project folder')
    parser.add_argument('--analyze', action='store_true')
    args = parser.parse_args()
    if not math.isfinite(args.threshold) or not 0 < args.threshold < 2:
        parser.error('Threshold must be between 0 and 2')
    if args.seconds is not None and (not math.isfinite(args.seconds) or args.seconds <= 0):
        parser.error('Preview seconds must be positive')
    run(args)


if __name__ == '__main__':
    main()
