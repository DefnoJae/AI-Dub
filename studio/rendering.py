"""Automatic take recovery with consistent per-speaker fallback."""
import json
import os
from pathlib import Path
import subprocess
import sys
import re
from difflib import SequenceMatcher

from studio.alignment import fit_aligned, spoken_text

RENDER_VERSION = 5
NATURAL_VOICES = ('af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_bella', 'am_adam')


def natural_runtime(root):
    return root / '.venv-natural' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def render_take(line, index, mode, voice, reference, folder, root, ffmpeg, model_factory, save, digest, verifier=None):
    import soundfile as sf
    import torch
    key = digest(dict(text=spoken_text(line), start=line['start'], end=line['end'], reference=reference[1],
                      mode=mode, voice=voice, seed=42+index, renderVersion=RENDER_VERSION))
    work = folder / ('take-' + key)
    work.mkdir(exist_ok=True)
    complete = work / 'complete.json'
    fit_signature=digest(dict(words=line.get('sourceWords',[]),speech=line.get('sourceSpeech',[]),fitVersion=6))
    if complete.exists() and json.loads(complete.read_text(encoding='utf8')).get('fitSignature')==fit_signature:
        return work / 'fit/fitted.wav'
    failures = []
    for attempt in range(3 if mode == 'reference' else 1):
        trial = work / f'attempt-{attempt}'
        trial.mkdir(exist_ok=True)
        failed = trial / 'failed.json'
        if failed.exists() and json.loads(failed.read_text(encoding='utf8')).get('fitSignature')==fit_signature:
            failures.append(json.loads(failed.read_text(encoding='utf8'))['error'])
            continue
        raw = trial / 'raw.wav'
        if not raw.exists():
            if mode == 'reference':
                model = model_factory()
                torch.manual_seed(42+index+1009*attempt)
                samples = model.generate(spoken_text(line), language_id='en', audio_prompt_path=str(reference[0]),
                    cfg_weight=.4, exaggeration=.25, temperature=.6).squeeze().detach().cpu().numpy()
                sf.write(trial / 'raw.partial.wav', samples, model.sr, subtype='PCM_16')
                (trial / 'raw.partial.wav').replace(raw)
            else:
                runtime = natural_runtime(root)
                if not runtime.exists():
                    raise RuntimeError('Natural voice runtime is missing. Run Setup-Studio.cmd once to install it.')
                request = trial / 'request.json'
                save(request, dict(text=spoken_text(line), voice=voice, output=str(raw),
                                   seconds=line['end']-line['start']))
                result = subprocess.run([str(runtime), '-m', 'studio.natural_worker', '--request', str(request)],
                               cwd=root, text=True, encoding='utf8', errors='replace', stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                if result.returncode:
                    raise RuntimeError('Natural voice worker failed: ' + result.stdout[-1600:])
        try:
            samples, rate = sf.read(raw, dtype='float32')
            boundaries = []
            verified = False
            if verifier is not None:
                recognized, words = verifier(raw)
                tokenize = lambda text: re.findall(r"[a-z]+(?:'[a-z]+)?",text.lower())
                expected, actual = tokenize(spoken_text(line)), tokenize(recognized)
                if not words or SequenceMatcher(None,expected,actual).ratio()<.65:
                    raise ValueError('Generated words did not match the dialogue; automatic retake required')
                if any(token in expected and token not in actual for token in ["not","never","don't","can't","won't"]):
                    raise ValueError('Generated take may have lost a negation')
                a=max(0,words[0].start-.03)
                b=min(len(samples)/rate,words[-1].end+.03)
                samples=samples[round(a*rate):round(b*rate)]
                boundaries=[max(0,(left.end+right.start)/2-a) for left,right in zip(words,words[1:])]
                verified=True
            fit = work / 'fit'
            fit.mkdir(exist_ok=True)
            source_words=line.get('sourceWords',[])
            pauses=[(left['end']-line['start'],right['start']-line['start'])
                    for left,right in zip(source_words,source_words[1:]) if right['start']-left['end']>.25]
            activity=line.get('sourceSpeech',[])
            acoustic_pauses=[(left['end']-line['start'],right['start']-line['start'])
                             for left,right in zip(activity,activity[1:]) if right['start']-left['end']>.25]
            if acoustic_pauses:
                pauses=acoustic_pauses
            timing = fit_aligned(samples, rate, line['end']-line['start'], ffmpeg, fit,
                                 pauses=pauses,word_boundaries=boundaries)
            save(complete, dict(start=line['start'], end=line['end'], engine=mode, voice=voice,
                               attempt=attempt+1, renderVersion=RENDER_VERSION,wordsVerified=verified,
                               fitSignature=fit_signature, **timing))
            return fit / 'fitted.wav'
        except ValueError as error:
            failures.append(str(error))
            save(failed, dict(error=str(error),fitSignature=fit_signature))
            print(f'Line {index+1}: take {attempt+1} did not fit; trying another delivery.', flush=True)
    raise ValueError(f'Line {index+1}: no usable {mode} take. ' + failures[-1])


def speech_verifier(root):
    recognizer = None
    def verify(path):
        nonlocal recognizer
        if recognizer is None:
            from faster_whisper import WhisperModel
            recognizer=WhisperModel(str(root / '.ai-dub/models/whisper-small'),device='cpu',compute_type='int8',local_files_only=True)
        segments,_=recognizer.transcribe(str(path),language='en',beam_size=5,temperature=0,
                                         condition_on_previous_text=False,word_timestamps=True)
        segments=list(segments)
        return ' '.join(segment.text for segment in segments),[word for segment in segments for word in (segment.words or [])]
    return verify if (root / '.ai-dub/models/whisper-small/model.bin').exists() else None


def render_speakers(script, references, folder, root, ffmpeg, save, digest, voice_mode='automatic'):
    model = None
    verifier=speech_verifier(root)
    def load_model():
        nonlocal model
        if model is None:
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS
            model = ChatterboxMultilingualTTS.from_local(str(root / '.ai-dub/models/chatterbox'), device='cpu')
        return model
    plan_file = folder / 'voice-plan.json'
    identity = digest(dict(script=script, voiceMode=voice_mode, renderVersion=RENDER_VERSION))
    plan = json.loads(plan_file.read_text(encoding='utf8')) if plan_file.exists() else {}
    if plan.get('identity') != identity:
        plan = dict(identity=identity, speakers={})
    completed = {}
    for number, speaker in enumerate(script['speakers']):
        assigned = [(i, line) for i, line in enumerate(script['lines']) if line['speaker'] == speaker]
        if not assigned:
            continue
        state = plan['speakers'].setdefault(speaker, dict(engine='natural' if voice_mode == 'natural' else 'reference',
                                                         voice=NATURAL_VOICES[number % len(NATURAL_VOICES)]))
        import soundfile as sf
        if sf.info(references[speaker][0]).duration < 1 and voice_mode == 'automatic':
            state.update(engine='natural', fallbackReason='Reference shorter than one second')
        def render_all():
            for index, line in assigned:
                print(f'English line {index+1}/{len(script["lines"])} ({state["engine"]})', flush=True)
                path = render_take(line, index, state['engine'], state['voice'], references[speaker],
                                   folder, root, ffmpeg, load_model, save, digest,verifier)
                completed[index] = (line, path)
        try:
            render_all()
        except ValueError as error:
            if state['engine'] != 'reference' or voice_mode == 'reference':
                raise
            state.update(engine='natural', fallbackReason=str(error))
            save(plan_file, plan)
            print(f'{speaker}: switching ALL lines to consistent natural voice {state["voice"]}. '
                  'This voice does not clone the original actor.', flush=True)
            render_all()
        save(plan_file, plan)
    return [completed[i] for i in range(len(script['lines']))], plan['speakers']
