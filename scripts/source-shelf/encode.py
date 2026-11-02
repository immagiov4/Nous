# Encode the PR533 motion revision into the product's existing asset names.
import subprocess,json,sys,os
from pathlib import Path
import numpy as np
from PIL import Image
root=Path(os.environ.get('SOURCE_SHELF_FRAMES_DIR', Path(__file__).parent)).resolve()
out=Path(sys.argv[1]).resolve()
CLIPS=[('reading',1,61),('search',62,80),('complete',142,55)]  # 24 fps throughout
STILLS=[('closed',1),('reading',62),('complete',196)]
def px(c,f):return np.asarray(Image.open(root/c/'frames'/f'frame-{f:04d}.png'),dtype=np.int16)
report={}
for c in ['blue','copper','sage']:
 fr=root/c/'frames';assert len(list(fr.glob('frame-*.png')))==196
 # Seams in actual pixels: each boundary should look like an ordinary consecutive-frame step.
 step=lambda a,b:int(np.abs(px(c,a)-px(c,b)).max())
 report[c]={'introToLoop':step(61,62),'loopWrap':step(141,62),'loopToClose':step(141,142),'loopRestFrames':step(62,142),'closedVsComplete':step(1,196)}
 for name,start,count in CLIPS:
  subprocess.run(['ffmpeg','-y','-v','error','-framerate','24','-start_number',str(start),'-i',str(fr/'frame-%04d.png'),'-frames:v',str(count),'-an','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-b:v','0','-crf','25','-auto-alt-ref','0','-row-mt','1',str(out/f'preparation-{c}-{name}.webm')],check=True)
 for name,f in STILLS:Image.open(fr/f'frame-{f:04d}.png').save(out/f'preparation-{c}-{name}.webp',lossless=True)
report['bytes']={p.name:p.stat().st_size for p in sorted(out.glob('preparation-*'))}
print(json.dumps(report,indent=1))
