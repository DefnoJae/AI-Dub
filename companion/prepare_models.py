"""Explicit one-time model downloads. Never run automatically on source audio."""
from pathlib import Path
import subprocess
import sys
from huggingface_hub import snapshot_download, hf_hub_download


if __name__ == '__main__':
    root = Path('.ai-dub/models')
    subprocess.run([sys.executable, '-m', 'piper.download_voices', 'en_US-lessac-medium',
                    '--data-dir', str(root / 'piper')], check=True)
    hf_hub_download('rhasspy/piper-voices', 'en/en_US/lessac/medium/MODEL_CARD',
                    local_dir=str(root / 'licenses'))
    snapshot_download('Systran/faster-whisper-base', local_dir=str(root / 'whisper-base'))
    print('Models downloaded. Processing uses local paths with downloads disabled.')
