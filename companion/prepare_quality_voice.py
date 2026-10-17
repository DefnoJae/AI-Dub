"""Explicitly download higher-quality local models when the user requests setup.

No model download happens during playback or generation.
"""
from pathlib import Path
import shutil
import urllib.request
from huggingface_hub import snapshot_download

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
ASSETS = {
    "kokoro-v1.0.onnx": 20_000_000,
    "voices-v1.0.bin": 1_000_000
}


def get_asset(name, minimum_bytes, directory):
    target = directory / name
    if target.is_file() and target.stat().st_size >= minimum_bytes:
        print("Already installed:", name, flush=True)
        return
    temp = directory / (name + ".partial")
    temp.unlink(missing_ok=True)
    print("Downloading:", name, flush=True)
    try:
        with urllib.request.urlopen(BASE + name, timeout=60) as response, temp.open("wb") as out:
            shutil.copyfileobj(response, out)
        if temp.stat().st_size < minimum_bytes:
            raise ValueError(name + " download incomplete")
        temp.replace(target)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def main():
    root = Path(".ai-dub/models")
    voice_dir = root / "kokoro"
    voice_dir.mkdir(parents=True, exist_ok=True)
    for name, minimum in ASSETS.items():
        get_asset(name, minimum, voice_dir)
    print("Downloading better Japanese-to-English Whisper model...", flush=True)
    snapshot_download("Systran/faster-whisper-small", local_dir=str(root / "whisper-small"))
    print("High-quality Kokoro voice and Whisper-small models prepared locally.", flush=True)


if __name__ == "__main__":
    main()
