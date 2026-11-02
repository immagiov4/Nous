# Encode the PR533 motion revision into the product's existing asset names.
import subprocess,json,sys,os,runpy
from pathlib import Path
import numpy as np
from PIL import Image
root=Path(os.environ.get('SOURCE_SHELF_FRAMES_DIR', Path(__file__).parent)).resolve()
out=Path(sys.argv[1]).resolve()
timeline=runpy.run_path(str(Path(__file__).with_name('timeline.py')))
CLIPS=timeline['CLIPS']
STILLS=timeline['STILLS']
def px(c,f):return np.asarray(Image.open(root/c/'frames'/f'frame-{f:04d}.png'),dtype=np.int16)
report={}
for c in ['blue','copper','sage']:
 fr=root/c/'frames';assert len(list(fr.glob('frame-*.png')))==timeline['T']['end']
 # Seams in actual pixels: each boundary should look like an ordinary consecutive-frame step.
 step=lambda a,b:int(np.abs(px(c,a)-px(c,b)).max())
 report[c]={name:step(a,b) for name,(a,b) in timeline['SEAMS'].items()}
 for name,start,count in CLIPS:
  subprocess.run(['ffmpeg','-y','-v','error','-framerate',str(timeline['FPS']),'-start_number',str(start),'-i',str(fr/'frame-%04d.png'),'-frames:v',str(count),'-an','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-b:v','0','-crf','25','-auto-alt-ref','0','-row-mt','1',str(out/f'preparation-{c}-{name}.webm')],check=True)
 for name,f in STILLS:Image.open(fr/f'frame-{f:04d}.png').save(out/f'preparation-{c}-{name}.webp',lossless=True)
report['bytes']={p.name:p.stat().st_size for p in sorted(out.glob('preparation-*'))}
print(json.dumps(report,indent=1))
