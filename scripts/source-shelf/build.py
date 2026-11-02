# Opus motion revision of the issue-520 reading-books scene.
# Self-contained scene, including the approved book geometry, materials and lights.
# Only timing, lens choreography and the (now fixed) camera differ.
# Usage: blender -b --python-exit-code 1 --python build.py -- check|draft|preview|alpha blue|copper|sage
import bpy, math, sys, json, os
from mathutils import Vector, Matrix
from pathlib import Path
from bpy_extras.object_utils import world_to_camera_view
OUT=Path(os.environ.get('SOURCE_SHELF_WORK_DIR', Path(__file__).parent)) / sys.argv[-1]; OUT.mkdir(exist_ok=True)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
scene.render.engine='BLENDER_EEVEE'
scene.eevee.use_gtao=True;scene.eevee.gtao_distance=.3;scene.eevee.gtao_factor=.8
scene.eevee.use_soft_shadows=True;scene.eevee.taa_render_samples=96
scene.render.resolution_x=768;scene.render.resolution_y=768;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
scene.render.film_transparent=True
scene.render.fps=24
scene.view_settings.view_transform='Standard';scene.view_settings.look='Medium High Contrast';scene.view_settings.exposure=0;scene.view_settings.gamma=1
scene.world.color=(.7,.7,.7)

# ---------------------------------------------------------------- timeline
# One reading cycle, 24 fps. Every number the choreography uses lives here.
# PR533 motion revision: three seamless product clips. Every boundary is a full rest pose,
# so intro -> loop, loop -> loop and loop -> close join without a visible cut.
#   intro    1..L0-1  cover swings open (eased, 1.5 s) and the first sheet follows
#   loop     L0..L1-1 lens reads two lines, steps aside, one sheet turns, lens returns
#   complete L1..end  lens lifts away, sheets fold back, cover closes softly
L0=62;P=80;L1=L0+P
T={
 'open':(3,39),
 'turns':[(31,53),(L0+46,L0+66)],
 'lens_out':(L1,L1+12),
 'pages_close':(L1+6,L1+34),
 'cover_close':(L1+8,L1+40),
 'bookmark':(L1+40,L1+41),
 'end':L1+54,
 'loop':(L0,L1),
}
Z=.54;HOP=.60;LIFT=.70;ASIDE=1.32
S=(-.40,.62,Z)   # rest pose at the head of the first line: every clip boundary
LENS=[
 (44,(-.12,.98,.95)),             # arrives from above once the first sheet has settled
 (58,S),(L0,S),(L0+3,S),          # settles; loop starts from rest
 (L0+19,(.36,.57,Z)),             # reads along the line
 (L0+25,(-.36,.10,HOP)),          # soft carriage return
 (L0+39,(.34,.03,Z)),             # reads a line further down
 (L0+46,(ASIDE,-.05,LIFT)),       # carries on off the line end and steps aside
 (L0+58,(ASIDE,-.05,LIFT)),       # waits while the sheet passes vertical
 (L0+74,S),(L1,S),(L1+2,S),       # returns to the identical rest pose
 (L1+14,(.30,.46,1.05)),          # lifts away before closing
]
SCALE=[(44,0),(53,1),(L1+2,1),(L1+14,0)]
TILT_DEG=6
scene.frame_start=1;scene.frame_end=T['end']

# ---------------------------------------------------------------- geometry (unchanged)
PRINCIPLED_BSDF = 'Principled BSDF'
def mat(name,hexval,rough=.4,metal=0):
 h=hexval.lstrip('#');srgb=[int(h[i:i+2],16)/255 for i in (0,2,4)]
 rgb=[v/12.92 if v<.04045 else ((v+.055)/1.055)**2.4 for v in srgb]
 m=bpy.data.materials.new(name);m.diffuse_color=(*rgb,1);m.use_nodes=True
 p=m.node_tree.nodes.get(PRINCIPLED_BSDF);p.inputs['Base Color'].default_value=(*rgb,1);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal
 return m
PALETTES={'blue':('#78B4E4','#367ED1'),'copper':('#C9876D','#97523E'),'sage':('#93AE91','#567B61')}
cover_color,spine_color=PALETTES[sys.argv[-1]]
blue=mat('Source satin cover',cover_color,.32)
blueedge=mat('Source bound spine',spine_color,.32)
purple=mat('Lavender satin cover','#9683E4',.32)
purpleedge=mat('Violet bound spine','#6544C9',.32)
paper=mat('Warm white page edges','#F3F0E7',.64)
paperline=mat('Individual paper edges','#E5E1D6',.72)
ribbon=mat('Lime woven bookmark','#B9D84E',.58)
lensrim=mat('Deep blue lens rim','#255C9A',.24,.32)
lenshandle=mat('Blue soft touch lens handle','#75AFE2',.3)
glass=mat('Optical glass','#D7EDFF',.1)
pp=paper.node_tree.nodes.get(PRINCIPLED_BSDF);pp.inputs['Emission'].default_value=(.75,.72,.65,1);pp.inputs['Emission Strength'].default_value=.10
gp=glass.node_tree.nodes.get(PRINCIPLED_BSDF);gp.inputs['Alpha'].default_value=.18;glass.blend_method='BLEND';glass.use_screen_refraction=True
ink=mat('Page typographic lines','#8F9CA6',.7)

def empty(name,parent=None):
 o=bpy.data.objects.new(name,None);scene.collection.objects.link(o);o.parent=parent;return o

def rounded(name,w,h,depth,radius,z,material,parent=None,x=0,y=0):
 verts=[];steps=12
 for zz in [-depth/2,depth/2]:
  for cx,cy,start in [(w/2-radius,h/2-radius,0),(-w/2+radius,h/2-radius,90),(-w/2+radius,-h/2+radius,180),(w/2-radius,-h/2+radius,270)]:
   for i in range(steps+1):
    a=math.radians(start+i*90/steps);verts.append((cx+radius*math.cos(a),cy+radius*math.sin(a),zz))
 n=len(verts)//2;faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]
 for i in range(n):j=(i+1)%n;faces.append((i,j,j+n,i+n))
 mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.materials.append(material);mesh.update();mesh.use_auto_smooth=True;mesh.auto_smooth_angle=math.radians(60)
 o=bpy.data.objects.new(name,mesh);scene.collection.objects.link(o);o.parent=parent;o.location=(x,y,z)
 bevel=o.modifiers.new('Soft manufactured edges','BEVEL');bevel.width=min(depth*.28,.028);bevel.segments=3
 o.modifiers.new('Weighted surface normals','WEIGHTED_NORMAL')
 for p in mesh.polygons:p.use_smooth=True
 return o

def key(o,prop,frames,free=()):
 """Insert keys; frames in `free` get AUTO handles (flow through), others AUTO_CLAMPED (ease/rest)."""
 for f,v in frames:
  setattr(o,prop,v);o.keyframe_insert(data_path=prop,frame=f)
 for fc in o.animation_data.action.fcurves:
  if fc.data_path!=prop:continue
  for k in fc.keyframe_points:
   k.interpolation='BEZIER'
   t='AUTO' if round(k.co.x) in free else 'AUTO_CLAMPED'
   k.handle_left_type=t;k.handle_right_type=t
  fc.update()

def bookmark(parent,name,animated=False):
 verts=[(-.18,-1.10,.18),(.18,-1.10,.18),(.18,-1.64,.14),(.18,-1.85,.055),(0,-1.72,.055),(-.18,-1.85,.055),(-.18,-1.64,.14)]
 mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],[(0,1,2,6),(6,2,3,4,5)]);mesh.materials.append(ribbon)
 o=bpy.data.objects.new(name,mesh);scene.collection.objects.link(o);o.parent=parent;o.location.x=-.48
 sol=o.modifiers.new('Woven ribbon thickness','SOLIDIFY');sol.thickness=.017
 be=o.modifiers.new('Soft ribbon edge','BEVEL');be.width=.009;be.segments=3
 if animated:
  a,b=T['bookmark'];key(o,'location',[(1,(-.48,.9,0)),(a,(-.48,.9,0)),(b,(-.48,0,0)),(T['end'],(-.48,0,0))])
 return o

def build_lens(root):
 lens=empty('Reading magnifier',root)
 bpy.ops.mesh.primitive_torus_add(major_radius=.286,minor_radius=.045,major_segments=64,minor_segments=16)
 ring=bpy.context.object;ring.name='Continuous polished lens rim';ring.parent=lens;ring.data.materials.append(lensrim)
 for p in ring.data.polygons:p.use_smooth=True
 bpy.ops.mesh.primitive_cylinder_add(vertices=64,radius=.263,depth=.018)
 disc=bpy.context.object;disc.name='Clear lens';disc.parent=lens;disc.data.materials.append(glass)
 for p in disc.data.polygons:p.use_smooth=True
 handle=rounded('Magnifier rounded handle',.14,.55,.13,.067,0,lenshandle,lens,x=.24,y=-.42);handle.rotation_euler.z=math.radians(33)
 return lens

def animate_lens(lens):
 key(lens,'location',[(f,p) for f,p in LENS])
 key(lens,'scale',[(f,(s,s,s)) for f,s in SCALE])
 # Secondary motion: bank a few degrees into the current velocity, keyed every 3 frames
 # from the location curves so it always agrees with the path when waypoints change.
 fcs={fc.array_index:fc for fc in lens.animation_data.action.fcurves if fc.data_path=='location'}
 k=math.radians(TILT_DEG)/0.12
 tilt=[]
 for f in sorted(set(list(range(LENS[0][0],LENS[-1][0]+1,3))+[LENS[-1][0],*T['loop'],T['loop'][0]+3,T['loop'][1]+2])):
  vx=fcs[0].evaluate(f+.5)-fcs[0].evaluate(f-.5);vy=fcs[1].evaluate(f+.5)-fcs[1].evaluate(f-.5)
  c=lambda v:max(-math.radians(TILT_DEG),min(math.radians(TILT_DEG),v*k))
  tilt.append((f,(c(-vy),c(vx),0)))
 key(lens,'rotation_euler',tilt)  # clamped: no banking overshoot through the rest poses

def animate_book(name,root,hinge):
 o0,o1=T['open'];c0,c1=T['cover_close'];E=T['end']
 key(hinge,'rotation_euler',[(1,(0,0,0)),(o0,(0,0,0)),(o1,(0,math.radians(-180),0)),(c0,(0,math.radians(-180),0)),(c1,(0,0,0)),(E,(0,0,0))])
 rounded(name+' right reading sheet',1.83,2.67,.008,.17,.329,paper,root,x=.025)
 for j in range(9):rounded(name+' base text %d'%j,1.18 if j%3 else .88,.012,.001,.005,.336,ink,root,x=.025,y=.83-j*.17)
 p0,p1=T['pages_close']
 for i in range(3):
  ph=empty(name+' page turn %d'%i,root);ph.location=(-.89,0,.346-i*.004)
  rounded(name+' turning page %d'%i,1.83,2.67,.008,.17,0,paper,ph,x=.915)
  for j in range(9):
   rounded(name+' typeset line %d %d'%(i,j),1.18 if j%3 else .88,.012,.001,.005,.008,ink,ph,x=.91,y=.83-j*.17)
   rounded(name+' reverse typeset line %d %d'%(i,j),1.18 if j%3 else .88,.012,.001,.005,-.008,ink,ph,x=.91,y=.83-j*.17)
  if i<len(T['turns']):
   s,e=T['turns'][i]
   flat=(-.89,0,.346-i*.004);left=(-.89,0,.412+i*.009)
   key(ph,'rotation_euler',[(1,(0,0,0)),(s,(0,0,0)),(e,(0,math.radians(-179.5),0)),(p0,(0,math.radians(-179.5),0)),(p1,(0,0,0)),(E,(0,0,0))])
   key(ph,'location',[(1,flat),(s,flat),(e,left),(p0,left),(p1,flat),(E,flat)])
 lens=build_lens(root);animate_lens(lens)

def book(name,position,yaw,cover,spine,animated=False):
 root=empty(name);root.location=position;root.rotation_euler.z=math.radians(yaw)
 rounded(name+' bottom cover',2.08,2.94,.075,.25,.038,cover,root)
 rounded(name+' paper block',1.91,2.76,.235,.195,.196,paper,root,x=.025)
 for i in range(37):rounded(name+' paper leaf edge %02d'%i,1.918,2.768,.0017,.195,.084+i*.0062,paperline,root,x=.025)
 rounded(name+' rounded spine',.15,2.84,.32,.065,.193,spine,root,x=-.997)
 hinge=empty(name+' cover hinge',root);hinge.location=(-.98,0,.363)
 rounded(name+' top cover',2.08,2.94,.075,.25,0,cover,hinge,x=.98)
 rounded(name+' hinge seam',.028,2.63,.008,.013,.043,spine,hinge,x=.018)
 bookmark(root,name+' bookmark',False)
 if animated: animate_book(name,root,hinge)
 return root


book('Upper sky book',(0,0,.10),14,blue,blueedge,True)
stage=rounded('Lavender rounded stage',20,20,.02,.10,-.045,mat('Reference lavender backdrop','#E7E7F6',.8))
for name,loc,energy,size in [('Large softbox',(-3,-4,8),550,5),('Cool fill',(5,1,5),180,5),('Rim',(0,5,7),240,4)]:
 bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.name=name;o.data.energy=energy;o.data.size=size;o.rotation_euler=(Vector((0,0,.3))-o.location).to_track_quat('-Z','Y').to_euler()

# ---------------------------------------------------------------- fixed camera, framed BEFORE animation review
# Same viewing direction as the reference pose. Position and ortho scale are solved once from
# the union of every frame's geometry, then never keyed.
bpy.ops.object.camera_add(location=(5,-7.5,10.5));cam=bpy.context.object;cam.name='Reference orthographic camera'
cam.rotation_euler=(Vector((.3,.2,.45))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';scene.camera=cam
MARGIN=.045
def mesh_objects():return [o for o in scene.objects if o.type=='MESH' and o!=stage]
def union_cam_bounds():
 bpy.context.view_layer.update();inv=cam.matrix_world.inverted();lo=[1e9,1e9];hi=[-1e9,-1e9]
 for f in range(1,T['end']+1):
  scene.frame_set(f)
  for o in mesh_objects():
   if max(o.matrix_world.to_scale())<1e-4:continue
   for c in o.bound_box:
    p=inv@(o.matrix_world@Vector(c))
    lo=[min(lo[0],p.x),min(lo[1],p.y)];hi=[max(hi[0],p.x),max(hi[1],p.y)]
 return lo,hi
cam.location=(3.760453224182129,-7.751106262207031,10.887298583984375)
cam.rotation_euler=(0.7314988374710083,-5.4816489125641965e-08,0.5480239391326904)
cam.data.ortho_scale=5.437449932098389
scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'reading-books.blend'))

# ---------------------------------------------------------------- verification (every frame, with sub-frames)
def sheet_gap(ob,points,margin):
 inv=ob.matrix_world.inverted();bb=ob.bound_box
 hx=max(abs(c[0]) for c in bb);hy=max(abs(c[1]) for c in bb);hz=max(abs(c[2]) for c in bb)
 local=[inv@p for p in points]
 inside=[q for q in local if abs(q.x)<hx+margin and abs(q.y)<hy+margin]
 if not inside:return None
 zs=[q.z for q in inside]
 if min(zs)>0:return min(zs)-hz
 if max(zs)<0:return -hz-max(zs)
 return -1

def verify_clearance(report,lens,parts,lens_local,obstacles,cam0):
 margin=.03
 for f in range(1,T['end']+1):
  for sub in (0,.25,.5,.75):
   scene.frame_set(f,subframe=sub)
   if any(abs(a-b)>1e-9 for r1,r2 in zip(cam.matrix_world,cam0[0]) for a,b in zip(r1,r2)) or cam.data.ortho_scale!=cam0[1]:
    report['cameraConstant']=False
   if max(lens.matrix_world.to_scale())<1e-3:continue
   pts=[o.matrix_world@c for o in parts for c in lens_local[o.name]]
   for ob in obstacles:
    gap=sheet_gap(ob,pts,margin)
    if gap is not None and gap<report['minLensClearance']:
     report['minLensClearance']=gap;report['minLensClearanceAt']=[f+sub,ob.name]

def verify_frame_geometry(report,lens):
 for f in range(1,T['end']+1):
  scene.frame_set(f)
  for o in mesh_objects():
   if max(o.matrix_world.to_scale())<1e-4:continue
   for c in o.bound_box:
    p=world_to_camera_view(scene,cam,o.matrix_world@Vector(c));b=report['boundsNormalized']
    report['boundsNormalized']=[min(b[0],p.x),min(b[1],p.y),max(b[2],p.x),max(b[3],p.y)]
  p=world_to_camera_view(scene,cam,lens.matrix_world.translation)
  report['trajectory'].append([f,round(p.x,4),round(p.y,4),round(max(lens.matrix_world.to_scale()),3)])
  for i,(s,e) in enumerate(T['turns']):
   pg=bpy.data.objects['Upper sky book page turn %d'%i]
   if e<=f<=T['pages_close'][0] and (abs(math.degrees(pg.rotation_euler.y)+179.5)>.01 or pg.hide_render):report['turnedPagesRetained']=False

def verify_bookmark(report):
 prev=.9
 for f in range(T['bookmark'][0],T['bookmark'][1]+1):
  scene.frame_set(f);y=bpy.data.objects['Upper sky book bookmark'].location.y
  if y>prev+1e-6:report['bookmarkMonotonic']=False
  prev=y

def verify():
 lens=bpy.data.objects['Reading magnifier']
 parts=list(lens.children)
 obstacles=[bpy.data.objects['Upper sky book top cover']]+[bpy.data.objects['Upper sky book turning page %d'%i] for i in range(3)]
 dg=bpy.context.evaluated_depsgraph_get()
 lens_local={o.name:[v.co.copy() for v in o.evaluated_get(dg).data.vertices] for o in parts}
 cam0=(cam.matrix_world.copy(),cam.data.ortho_scale)
 report={'frames':T['end'],'cameraKeyed':bool(cam.animation_data),'cameraConstant':True,'minLensClearance':9,'minLensClearanceAt':None,
         'boundsNormalized':[1,1,0,0],'turnedPagesRetained':True,'bookmarkMonotonic':True,'trajectory':[]}
 verify_clearance(report,lens,parts,lens_local,obstacles,cam0)
 verify_frame_geometry(report,lens)
 verify_bookmark(report)
 def pose(f):
  scene.frame_set(f);return [list(r) for r in lens.matrix_world]+[[math.degrees(bpy.data.objects['Upper sky book cover hinge'].rotation_euler.y)]]
 a0,a1=T['loop'];d=lambda x,y:max(abs(u-v) for r1,r2 in zip(x,y) for u,v in zip(r1,r2))
 report['loopSeam']=d(pose(a0),pose(a1));report['restVelocity']=max(d(pose(a0),pose(a0+1)),d(pose(a1-1),pose(a1)))
 assert report['loopSeam']<1e-6,report['loopSeam']
 b=report['boundsNormalized']
 report['noClipping']=b[0]>0.01 and b[1]>0.01 and b[2]<0.99 and b[3]<0.99
 report['lensNeverTouchesSheets']=report['minLensClearance']>0.02
 report['camera']={'location':list(cam.location),'rotation':list(cam.rotation_euler),'orthoScale':cam.data.ortho_scale}
 (OUT/'geometry-verification.json').write_text(json.dumps(report,indent=1))
 summary={k:v for k,v in report.items() if k!='trajectory'};print('VERIFY',json.dumps(summary))
 assert not report['cameraKeyed'] and report['cameraConstant'],'camera moves'
 assert report['noClipping'],b
 assert report['lensNeverTouchesSheets'],(report['minLensClearance'],report['minLensClearanceAt'])
 assert report['turnedPagesRetained'] and report['bookmarkMonotonic']

mode=sys.argv[sys.argv.index('--')+1] if '--' in sys.argv else 'check'
verify()
if mode in('draft','preview','alpha'):
 scene.render.resolution_x=scene.render.resolution_y=512
 scene.eevee.taa_render_samples=48 if mode!='draft' else 12
 stage.hide_render=(mode=='alpha')
 folder={'draft':'draft-frames','preview':'preview-frames','alpha':'frames'}[mode]
 (OUT/folder).mkdir(exist_ok=True);scene.render.filepath=str(OUT/folder/'frame-');bpy.ops.render.render(animation=True)
