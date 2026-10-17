"""Explicit setup downloads; rendering uses local models."""
from pathlib import Path
from huggingface_hub import snapshot_download

if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    snapshot_download('Systran/faster-whisper-base', local_dir=str(root / '.ai-dub/models/whisper-base'))
