"""Source-speech windows and bounded, pitch-preserving dialogue timing."""
import re
import subprocess

ALIGNMENT_VERSION = 2


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
    lines = []
    for span in spans:
        start, end = span['start'], min(duration, span['end'])
        if end <= start:
            continue
        clip = audio[round(start * 16000):round(end * 16000)]
        common = dict(language='ja', beam_size=5, vad_filter=False,
                      condition_on_previous_text=False, temperature=0, repetition_penalty=1.2)
        japanese, _ = model.transcribe(clip, task='transcribe', word_timestamps=True, **common)
        japanese = list(japanese)
        translated, _ = model.transcribe(clip, task='translate', **common)
        text = ' '.join(s.text.strip() for s in translated).strip()
        if not text:
            raise ValueError(f'Speech at {offset + start:.2f}s has no translation; review the source')
        lines.append(dict(start=offset + start, end=offset + end,
            text=text, dubText=conversational(text),
            sourceJapanese=' '.join(s.text.strip() for s in japanese),
            sourceWords=[dict(start=offset + start + w.start, end=offset + start + w.end, text=w.word)
                         for s in japanese for w in (s.words or [])],
            timingSource='Silero source audio speech detection; requires listening review'))
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


def fit_aligned(samples, rate, seconds, ffmpeg, work):
    import numpy as np
    import soundfile as sf
    trimmed, removed = trim_silence(samples, rate)
    speed = len(trimmed) / rate / seconds
    if not .75 <= speed <= 1.35:
        instruction = 'shorten' if speed > 1.35 else 'lengthen'
        raise ValueError(f'Timing needs {speed:.3f}x speech speed; {instruction} dubText to fit '
                         f'the {seconds:.2f}s source speech window naturally. Original timing is preserved.')
    sf.write(work / 'trimmed.wav', trimmed, rate, subtype='PCM_16')
    target = work / 'fitted.wav'
    subprocess.run([ffmpeg, '-y', '-nostdin', '-v', 'error', '-i', str(work / 'trimmed.wav'),
        '-af', f'atempo={speed:.9f}', '-ar', '44100', '-ac', '1', str(target)], check=True)
    fitted, output_rate = sf.read(target, dtype='float32')
    expected = round(seconds * output_rate)
    if abs(len(fitted) - expected) > round(.08 * output_rate):
        raise ValueError('Time stretching missed its target; revise dubText and render again')
    # Correct small atempo edge rounding, with a 5ms end fade to avoid a cut click.
    fitted = np.pad(fitted[:expected], (0, max(0, expected-len(fitted))))
    fade = min(round(.005 * output_rate), len(fitted))
    fitted[-fade:] *= np.linspace(1, 0, fade)
    sf.write(target, fitted, output_rate, subtype='PCM_16')
    return dict(speed=speed, trimmedLeadingSeconds=removed, allocatedDuration=seconds,
                renderedDuration=len(fitted) / output_rate)
