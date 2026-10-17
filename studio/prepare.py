"""Explicit setup downloads; rendering uses local models."""
from pathlib import Path
from huggingface_hub import snapshot_download

if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    snapshot_download('Systran/faster-whisper-small', local_dir=str(root / '.ai-dub/models/whisper-small'))
    snapshot_download('Qwen/Qwen2.5-1.5B-Instruct', local_dir=str(root / '.ai-dub/models/dialogue-v1'),
                      allow_patterns=['*.json','*.safetensors','*.txt','*.model','LICENSE','README.md'])
    import sys
    sys.path.insert(0,str(root / 'companion'))
    from prepare_quality_voice import get_asset, ASSETS
    (root / '.ai-dub/models/kokoro').mkdir(parents=True,exist_ok=True)
    for name, minimum in ASSETS.items():
        get_asset(name,minimum,root / '.ai-dub/models/kokoro')
