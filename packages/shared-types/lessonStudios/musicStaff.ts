import { Accidental, Formatter, Stave, StaveNote, SVGContext, Voice } from 'vexflow/bravura';
import type { musicPitches } from './musicSpec';
import { studioTextShape } from './studioTypography';
import { descendants, svg, VectorNode, type VectorTag } from './vectorScene';

type StaffTag = 'svg' | 'g' | 'path' | 'rect' | 'text';

/** VexFlow writes its SVG commands directly into the vector tree, with no DOM measurement. */
class StaffElement extends VectorNode {
  readonly nodeName: string;
  readonly style = {};

  constructor(tag: VectorTag) {
    super(tag);
    this.nodeName = tag;
  }

  appendChild(child: StaffElement) {
    this.append(child);
    return child;
  }

  setAttributeNS(_namespace: string | null, name: string, value: string) {
    this.setAttribute(name, value);
  }
}

class StaffContext extends SVGContext {
  constructor() {
    super(new StaffElement('root') as unknown as HTMLElement);
  }

  override create(tag: 'svg'): SVGSVGElement;
  override create(tag: 'g'): SVGGElement;
  override create(tag: 'path'): SVGPathElement;
  override create(tag: 'rect'): SVGRectElement;
  override create(tag: 'text'): SVGTextElement;
  override create(tag: string): SVGElement;
  override create(tag: string): SVGElement {
    return new StaffElement(tag as StaffTag) as unknown as SVGElement;
  }

  override measureText(text: string) {
    const { bounds, advance } = studioTextShape(text, 'music-label', 'start');
    return { x: bounds.left, y: bounds.top, width: advance, height: bounds.bottom - bounds.top };
  }
}

function paintStaffChild(parent: VectorNode, source: VectorNode): VectorNode {
  const node = svg(parent, source.tag, { ...source.attrs });
  for (const child of source.children) paintStaffChild(node, child);
  return node;
}

export function drawMusicStaff(
  surface: VectorNode,
  key: string,
  pitches: ReturnType<typeof musicPitches>,
  { left, right }: { left: number; right: number }
) {
  const ctx = new StaffContext();
  ctx.setFillStyle('var(--ink)').setStrokeStyle('var(--ink)');
  const stave = new Stave(left, 0, right - left).addClef('treble').addKeySignature(key);
  stave.setContext(ctx).draw();
  const notes = pitches.map(
    group => new StaveNote({ keys: group.map(note => note.key), duration: 'w' })
  );
  const voice = new Voice({ num_beats: notes.length * 4, beat_value: 4 }).addTickables(notes);
  Accidental.applyAccidentals([voice], key);
  new Formatter().joinVoices([voice]).formatToStave([voice], stave);
  voice.draw(ctx, stave);
  const staff = svg(surface, 'g', { class: 'music-staff' });
  const recorded = ctx.svg as unknown as StaffElement;
  for (const child of recorded.children) paintStaffChild(staff, child);
  const nodes = [...descendants(staff)];
  return {
    surface: staff,
    stave: nodes.find(node => node.hasClass('vf-stave')),
    notes: notes.map(note => nodes.find(node => node.attrs.id === `vf-${note.getAttribute('id')}`)),
    x: notes.map(note => note.getAbsoluteX() + note.getGlyphWidth() / 2),
  };
}
