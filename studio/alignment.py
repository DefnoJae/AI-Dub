"""Source-speech windows and bounded, pitch-preserving dialogue timing."""
import re
import subprocess

ALIGNMENT_VERSION = 3


def spoken_text(line):
    return line.get('dubText', line['text']).strip()


def conversational(text):
    """Conservative contractions only; never invent semantic dialogue rewrites."""
    pairs = [('I am', "I'm"), ('I have been', "I've been"), ('I will', "I'll"),
             ('you are', "you're"), ('we are', "we're"), ('they are', "they're"),
             ('do not', "don't"), ('does not', "doesn't"), ('did not', "didn't"),
             ('cannot', "can't"), ('can not', "can't"), ('will not', "won't"),
             ('is not', "isn't"), ('are not', "aren't"), ('it is', "it's")]
    for source, target in pairs:
        def replace(match):
            return target[0].upper() + target[1:] if match[0][0].isupper() else target
        text = re.sub(r'\b' + source + r'\b', replace, text, flags=re.IGNORECASE)
    return ' '.join(text.split())


def speech_windows(path):
    """Silero speech detection independent of Whisper translation timestamps."""
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import get_speech_timestamps, VadOptions
    audio = decode_audio(str(path), sampling_rate=16000)
    spans = get_speech_timestamps(audio, VadOptions(min_speech_duration_ms=160,
        min_silence_duration_ms=300, speech_pad_ms=30, max_speech_duration_s=10))
    return audio, [dict(start=s['start'] / 16000, end=s['end'] / 16000) for s in spans]


def translate_windows(model, path, offset, duration):
    audio, spans = speech_windows(path)
    common = dict(language='ja', beam_size=5, vad_filter=False,
                  condition_on_previous_text=False, temperature=0, repetition_penalty=1.2)
    # Full-context Japanese recognition preserves quiet words/stutters that VAD
    # misses, and avoids translating an isolated fraction of a sentence.
    recognized, _ = model.transcribe(audio, task='transcribe', word_timestamps=True, **common)
    recognized = list(recognized)
    words = [w for segment in recognized for w in (segment.words or [])]
    units, current = [], []
    for word in words:
        if current and word.start - current[-1].end > 1.0:
            units.append(current)
            current = []
        current.append(word)
        if re.search(r'[。！？!?]$', word.word.strip()):
            units.append(current)
            current = []
    if current:
        units.append(current)
    if units:
        spans = [dict(start=max(0, unit[0].start-.03), end=min(duration, unit[-1].end+.03),
                      words=unit) for unit in units if unit[-1].end > unit[0].start]
    lines = []
    for span in spans:
        start, end = span['start'], min(duration, span['end'])
        if end <= start:
            continue
        # Add acoustic context for translation, while keeping placement anchored
        # to the original Japanese words rather than English segment times.
        clip = audio[round(max(0,start-.3) * 16000):round(min(duration,end+.3) * 16000)]
        translated, _ = model.transcribe(clip, task='translate', **common)
        text = ' '.join(s.text.strip() for s in translated).strip()
        unit_words = span.get('words', [])
        japanese_text = ''.join(w.word for w in unit_words)
        if not japanese_text:
            japanese, _ = model.transcribe(clip, task='transcribe', **common)
            japanese_text = ''.join(s.text for s in japanese)
        if not text or not re.search('[A-Za-z]', text):
            text = 'Translation needs review.'
        lines.append(dict(start=offset + start, end=offset + end,
            text=text, dubText=conversational(text),
            sourceJapanese=japanese_text,
            sourceWords=[dict(start=offset + w.start, end=offset + w.end, text=w.word) for w in unit_words],
            timingSource='Japanese word alignment with speech detection fallback; requires review'))
    return lines


def trim_silence(samples, rate):
    import numpy as np
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim != 1 or not len(samples) or not np.isfinite(samples).all():
        raise ValueError('Invalid generated speech')
    hop = max(1, round(rate * .01))
    padded = np.pad(samples, (0, (-len(samples)) % hop))
    rms = np.sqrt(np.mean(padded.reshape(-1, hop) ** 2, axis=1))
    if rms.max() < .001:
        raise ValueError('Generated speech is silent')
    active = np.flatnonzero(rms > max(.001, float(rms.max()) * .025))
    # Keep one 10ms guard frame so consonants are not shaved at the boundary.
    a, b = max(0, int(active[0] - 1) * hop), min(len(samples), int(active[-1] + 2) * hop)
    return samples[a:b], a / rate


def fit_aligned(samples, rate, seconds, ffmpeg, work, pauses=None, word_boundaries=None):
    import numpy as np
    import soundfile as sf
    trimmed, removed = trim_silence(samples, rate)
    pause_total = sum(b-a for a,b in (pauses or []))
    active_target = max(.1,seconds-pause_total)
    required_speed = len(trimmed) / rate / active_target
    if required_speed > 1.35:
        raise ValueError(f'Timing needs {required_speed:.3f}x speech speed; shorten dubText to fit '
                         f'the {seconds:.2f}s source speech window naturally. Original timing is preserved.')
    # A short natural phrase does not need invented words or extreme slow motion.
    # Preserve its pace and keep the remainder of the source window silent.
    speed = max(.75,required_speed)
    sf.write(work / 'trimmed.wav', trimmed, rate, subtype='PCM_16')
    target = work / 'fitted.wav'
    subprocess.run([ffmpeg, '-y', '-nostdin', '-v', 'error', '-i', str(work / 'trimmed.wav'),
        '-af', f'atempo={speed:.9f}', '-ar', '44100', '-ac', '1', str(target)], check=True)
    fitted, output_rate = sf.read(target, dtype='float32')
    expected = round(seconds * output_rate)
    if len(fitted) - expected > round(.08 * output_rate):
        raise ValueError('Time stretching missed its target; revise dubText and render again')
    # Correct small atempo edge rounding, with a 5ms end fade to avoid a cut click.
    speech_duration = min(len(fitted),expected)/output_rate
    padding = max(0,expected-len(fitted))/output_rate
    inserted_pauses = False
    # Reinsert a source hesitation between generated words, rather than padding
    # the entire spare interval after speech has already finished.
    if pauses and word_boundaries and padding > .02:
        boundaries = [max(0,min(len(fitted),round((time-removed)/speed*output_rate)))
                      for time in word_boundaries]
        boundaries = sorted(set(i for i in boundaries if .1*output_rate<i<len(fitted)-.1*output_rate))
        if boundaries:
            chosen = {}
            for a,b in pauses:
                wanted = len(fitted)*max(0,min(1,a/seconds))
                position = min(boundaries,key=lambda value:abs(value-wanted))
                chosen[position] = chosen.get(position,0)+(b-a)
            total = sum(chosen.values())
            pieces,cursor,used = [],0,0
            items=sorted(chosen.items())
            for number,(position,length) in enumerate(items):
                count = round(padding*output_rate*length/total) if number<len(items)-1 else round(padding*output_rate)-used
                pieces.extend([fitted[cursor:position],np.zeros(count,dtype=np.float32)])
                used+=count
                cursor=position
            pieces.append(fitted[cursor:])
            fitted=np.concatenate(pieces)
            inserted_pauses=True
    fitted = np.pad(fitted[:expected], (0, max(0, expected-len(fitted))))
    fade = min(round(.005 * output_rate), len(fitted))
    fitted[-fade:] *= np.linspace(1, 0, fade)
    sf.write(target, fitted, output_rate, subtype='PCM_16')
    return dict(speed=speed, trimmedLeadingSeconds=removed, allocatedDuration=seconds,
                renderedDuration=len(fitted) / output_rate,speechDuration=speech_duration,paddingSeconds=padding,
                paddingPlacement='between words at source hesitation' if inserted_pauses else 'tail')
