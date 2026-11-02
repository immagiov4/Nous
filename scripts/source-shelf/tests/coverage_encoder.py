import json
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
palette_path = Path('packages/shared-types/sourceShelfPalettes.json')


def verify_encoding(script_root, scratch, measure=False):
    timeline = runpy.run_path(str(script_root / 'timeline.py'))
    palettes = json.loads((script_root.parents[1] / palette_path).read_text())
    for color in palettes:
        frames = scratch / color / 'frames'
        frames.mkdir(parents=True)
        for frame in range(1, timeline['T']['end'] + 1):
            Image.new('RGBA', (16, 16), (frame % 256, 130, 180, 120)).save(frames / f'frame-{frame:04d}.png')
    out = scratch / 'output'
    out.mkdir()
    env = dict(os.environ, COVERAGE_FILE=str(root / '.coverage-encoder'), SOURCE_SHELF_FRAMES_DIR=str(scratch))
    command = [sys.executable]
    if measure:
        command += ['-m', 'coverage', 'run']
    subprocess.run(command + [str(script_root / 'encode.py'), str(out)], env=env, check=True)
    files = list(out.glob('preparation-*'))
    assert len(files) == len(palettes) * (len(timeline['CLIPS']) + len(timeline['STILLS']))
    assert all(file.stat().st_size > 0 for file in files)
    for name, _start, count in timeline['CLIPS']:
        probe = subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', str(out / f'preparation-blue-{name}.webm')], text=True)
        assert int(json.loads(probe)['streams'][0]['nb_read_frames']) == count
    for name, frame in timeline['STILLS']:
        with Image.open(out / f'preparation-blue-{name}.webp') as poster:
            assert poster.getpixel((0, 0)) == (frame % 256, 130, 180, 120)
    if measure:
        subprocess.run([sys.executable, '-m', 'coverage', 'xml', '--include=' + str(root / '*.py'), '-o', str(root / 'coverage-encoder.xml')], env=env, check=True)


with tempfile.TemporaryDirectory(prefix='source-shelf-encoder-') as directory:
    scratch = Path(directory)
    verify_encoding(root, scratch / 'baseline', measure=True)
    scripts = scratch / 'repo/scripts/source-shelf'
    scripts.mkdir(parents=True)
    manifest = scratch / 'repo' / palette_path
    manifest.parent.mkdir(parents=True)
    palettes = json.loads((root.parents[1] / palette_path).read_text())
    palettes['verification'] = palettes['blue']
    manifest.write_text(json.dumps(palettes))
    shutil.copyfile(root / 'encode.py', scripts / 'encode.py')
    # Shift boundaries while preserving total length: frame-count-only checks cannot catch this.
    source = (root / 'timeline.py').read_text()
    (scripts / 'timeline.py').write_text(source.replace('L0 = 62', 'L0 = 63').replace('P = 80', 'P = 79'))
    verify_encoding(scripts, scratch / 'shifted')
