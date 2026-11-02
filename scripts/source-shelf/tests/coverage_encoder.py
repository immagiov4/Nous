import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='source-shelf-encoder-') as directory:
    scratch = Path(directory)
    for color in ('blue', 'copper', 'sage'):
        frames = scratch / color / 'frames'
        frames.mkdir(parents=True, exist_ok=True)
        image = Image.new('RGBA', (16, 16), (100, 130, 180, 120))
        for frame in range(1, 197):
            image.save(frames / f'frame-{frame:04d}.png')
    out = scratch / 'output'
    out.mkdir(exist_ok=True)
    env = dict(os.environ, COVERAGE_FILE=str(root / '.coverage-encoder'), SOURCE_SHELF_FRAMES_DIR=str(scratch))
    subprocess.run([sys.executable, '-m', 'coverage', 'run', str(root / 'encode.py'), str(out)], env=env, check=True)
    files = list(out.glob('preparation-*'))
    assert len(files) == 18 and all(file.stat().st_size > 0 for file in files)
    probe = subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', str(out / 'preparation-blue-reading.webm')], text=True)
    assert int(json.loads(probe)['streams'][0]['nb_read_frames']) == 61
subprocess.run([sys.executable, '-m', 'coverage', 'xml', '--include=' + str(root / 'encode.py'), '-o', str(root / 'coverage-encoder.xml')], env=env, check=True)
