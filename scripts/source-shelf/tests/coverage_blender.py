import os
import runpy
import tempfile
from pathlib import Path
import coverage

root = Path(__file__).resolve().parent.parent
cov = coverage.Coverage(data_file=str(root / '.coverage-blender'), source=[str(root)])
cov.start()
with tempfile.TemporaryDirectory(prefix='source-shelf-blender-') as scratch:
    os.environ['SOURCE_SHELF_WORK_DIR'] = scratch
    runpy.run_path(str(root / 'build.py'), run_name='__main__')
cov.stop()
cov.save()
cov.xml_report(outfile=str(root / 'coverage-blender.xml'), include=[str(root / 'build.py'), str(root / 'timeline.py')])
