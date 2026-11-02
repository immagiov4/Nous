import os
import runpy
import sys
import tempfile
from pathlib import Path
import coverage

root = Path(__file__).resolve().parent.parent
cov = coverage.Coverage(data_file=str(root / '.coverage-blender'), source=[str(root)])
cov.start()
with tempfile.TemporaryDirectory(prefix='source-shelf-blender-') as scratch:
    work = Path(scratch) / 'palettes'
    work.mkdir()
    os.environ['SOURCE_SHELF_WORK_DIR'] = str(work)
    palette = sys.argv[-1]
    try:
        sys.argv[-1] = '../outside-palette'
        try:
            runpy.run_path(str(root / 'build.py'), run_name='__main__')
        except ValueError:
            pass
        else:
            raise AssertionError('Unknown palettes must be rejected')
        assert not (Path(scratch) / 'outside-palette').exists()
    finally:
        sys.argv[-1] = palette
    runpy.run_path(str(root / 'build.py'), run_name='__main__')
cov.stop()
cov.save()
cov.xml_report(outfile=str(root / 'coverage-blender.xml'), include=[str(root / 'build.py'), str(root / 'timeline.py')])
