"""Download and warm local quality engines before using prepared private clips."""
import os
from pathlib import Path

os.environ.setdefault('PKUSEG_HOME', str(Path('.ai-dub/models/pkuseg').resolve()))

if __name__ == '__main__':
    from huggingface_hub import snapshot_download
    from quality_clip import tools_dir
    tools_dir()
    from audio_separator.separator import Separator
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    folder = Path('.ai-dub/models/chatterbox').resolve()
    snapshot_download('ResembleAI/chatterbox', local_dir=str(folder),
                      allow_patterns=['ve.pt', 't3_mtl23ls_v2.safetensors', 's3gen.pt',
                                      'grapheme_mtl_merged_expanded_v1.json', 'Cangjie5_TC.json', 'README.md', 'LICENSE'])
    separator = Separator(model_file_dir=str(Path('.ai-dub/models/separation').resolve()))
    separator.load_model(model_filename='UVR-MDX-NET-Inst_HQ_3.onnx')
    del separator
    ChatterboxMultilingualTTS.from_local(str(folder), device='cpu')
    print('Quality engine preparation complete. No source media was uploaded.')
