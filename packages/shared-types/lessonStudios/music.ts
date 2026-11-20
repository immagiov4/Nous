import { diagram, pill, textAt } from './chart';
import { chartViewport, studioViewportScale } from './chartDimensions';
import { MIN_TEXT_GAP_PX } from './layoutValidation';
import { copy } from './music.copy.it';
import {
  hitTracks,
  type MusicSpec,
  musicPitches,
  SIXTEENTHS_PER_BEAT,
  STEPS,
  transportStep,
} from './musicSpec';
import type { drawMusicStaff } from './musicStaff';
import { ARRIVE, appear, DIM, FOCUS, timeline } from './motion';
import type { StudioAnchor } from './studioTypography';
import { motionEase } from './timeline';
import { boxDistance, enclosingBoxes, vectorBounds } from './vectorBounds';
import { svg, type VectorNode } from './vectorScene';

export type BuildMusicStaff = typeof drawMusicStaff;
const SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const ACCENT = 'var(--accent)';
const NOTE = 'var(--note-ink)';
const INK = 'var(--ink)';
const COLORS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-0)'];
const font = (
  g: VectorNode,
  x: number,
  y: number,
  value: string,
  size: number,
  anchor: StudioAnchor = 'middle'
) => {
  const node = textAt(g, x, y, value, anchor, 'music-label');
  if (!node.viewport && node.label) node.label.size = size;
  return node;
};

function keyboard(surface: VectorNode, pitches: number[], y: number, height: number) {
  const first = Math.floor(Math.min(...pitches) / 12) * 12;
  const start = Math.max(first, Math.max(...pitches) - 23);
  const width = 810 / 14;
  const left = 95;
  let whites = 0;
  const black: number[] = [];
  const group = svg(surface, 'g', {});
  const keys = new Map<number, VectorNode>();
  const labels = new Map<number, { x: number; y: number; black: boolean }>();
  const rect = (midi: number, x: number, width: number, h: number, black: boolean) => {
    const key = svg(svg(group, 'g', {}), 'rect', {
      x,
      y,
      width,
      height: h,
      rx: black ? 4 : 5,
      class: black ? 'music-black' : 'music-white',
      'data-pitch': midi,
    });
    if (black) key.setAttribute('data-domain-occluder', '');
    keys.set(midi, key);
    labels.set(midi, { x: x + width / 2, y: y + h - 15, black });
  };
  for (let midi = start; midi < start + 24; midi++) {
    if (SEMITONES.includes(midi % 12))
      rect(midi, left + whites++ * width, width - 1, height, false);
    else black.push(midi);
  }
  const blackWidth = width * 0.68;
  for (const midi of black) {
    const index = Array.from(keys.keys()).filter(
      p => p < midi && SEMITONES.includes(p % 12)
    ).length;
    rect(midi, left + index * width - blackWidth / 2, blackWidth, height * 0.61, true);
  }
  return { group, keys, labels };
}

function drums(surface: VectorNode, pattern: NonNullable<MusicSpec['drums']>, y: number) {
  const group = svg(surface, 'g', { 'data-music-view': 'drums' });
  const left = 223,
    size = 42,
    h = 26,
    row = 33;
  const pal = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-0)'];
  for (const [index, track] of hitTracks.entries()) {
    const yy = y + row * index;
    font(group, left - 18, yy + 19, copy.percussion[index], 16, 'end');
    for (let step = 0; step < STEPS; step++) {
      const x = left + step * size;
      svg(group, 'rect', {
        x: x + 3,
        y: yy,
        width: size - 6,
        height: h,
        rx: 5,
        fill: pattern[track].includes(step + 1) ? pal[index] : 'var(--line)',
        'data-hit': pattern[track].includes(step + 1) ? track : '',
      });
    }
  }
  for (let beat = 0; beat < 4; beat++) {
    font(group, left + (beat * 4 + 0.5) * size, y - 19, String(beat + 1), 14);
  }
  const cursor = svg(group, 'rect', {
    x: left + 1,
    y: y - 3,
    width: size - 2,
    height: row * 2 + h + 6,
    rx: 7,
    fill: 'none',
    stroke: ACCENT,
    'stroke-width': 3,
    'data-drum-playhead': 0,
  });
  font(group, left - 18, y - 19, String(pattern.bpm) + copy.tempo, 14, 'end');
  return { group, cursor, x: left, size };
}

type Pitches = ReturnType<typeof musicPitches>;
type MusicBeat = MusicSpec['beats'][number];
type BeatState = {
  beat: MusicBeat;
  tick: number;
  active: number[];
  keys: Set<number>;
  drumsAt: number;
};
type Blend = (before: number, after: number) => number;
type Piano = ReturnType<typeof keyboard>;
type DrumSet = ReturnType<typeof drums>;
const ease = motionEase(FOCUS.ease);
const arrive = motionEase(ARRIVE.ease);

function pitchName(notes: Pitches[number]) {
  if (notes.length === 1) return notes[0].name;
  if (notes[2].midi - notes[0].midi === 6) return notes[0].name + copy.diminished;
  return notes[0].name + (notes[1].midi - notes[0].midi === 3 ? copy.minor : copy.major);
}

function drawIntervals(surface: VectorNode, pitches: Pitches, centers: number[], y: number) {
  return pitches.slice(1).map(([note], i) => {
    const left = centers[i] + 11;
    const right = centers[i + 1] - 11;
    const group = svg(surface, 'g', {});
    const short = note.midi - pitches[i][0].midi === 1;
    svg(group, 'path', {
      d: `M ${left} ${y - 8} v8 H ${right} v-8`,
      fill: 'none',
      stroke: short ? ACCENT : 'var(--chart-1)',
      'stroke-width': 2,
    });
    const label = font(group, (left + right) / 2, y - 9, short ? copy.semitone : copy.tone, 18);
    label.setAttribute('style', 'fill:' + (short ? NOTE : INK));
    return group;
  });
}

function drawKeyLabels(piano: Piano | undefined, pitches: Pitches, gap: number) {
  const labels = new Map<number, VectorNode>();
  if (!piano) return labels;
  const names = new Map(
    pitches.flatMap(group => group.map(note => [note.midi, note.name] as const))
  );
  for (const [midi, name] of names) {
    const pos = piano.labels.get(midi);
    if (!pos) continue;
    const key = piano.keys.get(midi)!;
    const node = font(key.parent!, pos.x, pos.y, name, 14);
    key.parent?.setAttribute('data-label-container', '');
    if (node.viewport && !labelFitsKey(node, key, piano.keys, gap))
      node.setAttribute('visibility', 'hidden');
    if (pos.black) node.setAttribute('style', 'fill:var(--surface)');
    labels.set(midi, node);
  }
  return labels;
}

function drawMusicPanels(
  surface: VectorNode,
  spec: MusicSpec,
  pitches: Pitches,
  staff?: BuildMusicStaff
) {
  const includes = (name: MusicSpec['views'][number]) => spec.views.includes(name);
  const dense = Boolean(spec.drums);
  const top = dense ? 0 : 15;
  const sheet = includes('staff') ? staff?.(surface, spec.key, pitches, top) : undefined;
  if (includes('staff') && !sheet) throw new Error('Music staff geometry is unavailable');
  const keyboardTop = includes('staff') ? 252 : 132;
  const piano = includes('keyboard')
    ? keyboard(
        surface,
        pitches.flatMap(chord => chord.map(note => note.midi)),
        dense ? 199 : keyboardTop,
        dense ? 87 : 135
      )
    : undefined;
  const drumY = includes('staff') || includes('keyboard') ? 345 : 196;
  const drum = spec.drums ? drums(surface, spec.drums, drumY) : undefined;
  const centers =
    sheet?.x ?? pitches.map((_, index) => 130 + (737 * index) / Math.max(1, pitches.length - 1));
  const row = svg(surface, 'g', { 'data-music-view': 'pitches' });
  const gap = surface.viewport ? MIN_TEXT_GAP_PX / studioViewportScale(surface.viewport) : 0;
  const staffBottom = sheet
    ? Math.max(...enclosingBoxes(sheet.surface).flatMap(mark => mark.boxes.map(box => box.bottom)))
    : chartViewport.top;
  const noteBaseline = Math.max(top + 109, staffBottom + 2 * gap + 5);
  const markers = pitches.map((notes, i) =>
    font(row, centers[i], noteBaseline, pitchName(notes), 19)
  );
  const intervals = includes('intervals')
    ? drawIntervals(surface, pitches, centers, top + 163)
    : [];
  return {
    sheet,
    piano,
    drum,
    markers,
    intervals,
    centers,
    top,
    drumY,
    keyLabels: drawKeyLabels(piano, pitches, gap),
  };
}

function musicCallout(beat: MusicBeat, pitches: Pitches) {
  if (beat.label) return beat.label;
  if (!beat.callout) return undefined;
  if (beat.cycle) return copy.perBar;
  if (beat.focus === 'drums') return copy.percussion.join(copy.separator);
  const selected = beat.active ?? pitches.map((_, index) => index);
  if (beat.focus === 'intervals') {
    const steps = pitches.slice(1).map(([pitch], index) => pitch.midi - pitches[index][0].midi);
    const highlighted = selected.slice(1).map(index => steps[index - 1]);
    if (highlighted.filter(value => value === 1).length === 2) return copy.twoSemitones;
    if (highlighted.length && highlighted.every(value => value === 2)) return copy.tones;
  }
  const notes = selected.flatMap(index => pitches[index].map(pitch => pitch.name));
  return [...new Set(notes)].join(copy.separator);
}

function musicState(
  spec: MusicSpec,
  pitches: Pitches,
  times: number[],
  index: number,
  seconds: number
): BeatState {
  const beat = spec.beats[index];
  const drumsAt = spec.beats
    .slice(0, index + 1)
    .findIndex(beat => beat.focus === 'drums' || beat.cycle);
  const tick =
    spec.drums && drumsAt >= 0 ? transportStep(seconds - times[drumsAt], spec.drums.bpm) : 0;
  const active = beat.cycle
    ? [Math.floor(tick / STEPS) % pitches.length]
    : (beat.active ?? pitches.map((_, i) => i));
  return {
    beat,
    tick,
    active,
    keys: new Set(active.flatMap(i => pitches[i].map(note => note.midi))),
    drumsAt,
  };
}

function viewStrength(name: MusicSpec['views'][number], { beat }: BeatState) {
  const focus = beat.focus;
  return !focus ||
    focus === name ||
    (focus === 'intervals' && name !== 'drums') ||
    (focus === 'drums' && beat.cycle && name === 'keyboard')
    ? 1
    : DIM;
}

function setAlpha(node: VectorNode | undefined, alpha: number) {
  if (node) node.opacity = alpha;
}

function paintMusicNotation(
  { sheet, markers, intervals }: ReturnType<typeof drawMusicPanels>,
  before: BeatState,
  after: BeatState,
  blend: Blend
) {
  const symbol = (state: BeatState, i: number) =>
    state.active.includes(i) && state.beat.focus !== 'signature' ? 1 : DIM;
  const interval = (state: BeatState, i: number) =>
    state.beat.focus === 'intervals' && state.active.includes(i) && state.active.includes(i + 1)
      ? 1
      : DIM;
  for (const [i, note] of (sheet?.notes ?? []).entries())
    setAlpha(note, blend(symbol(before, i), symbol(after, i)));
  markers.forEach((mark, i) => setAlpha(mark, blend(symbol(before, i), symbol(after, i))));
  intervals.forEach((mark, i) => setAlpha(mark, blend(interval(before, i), interval(after, i))));
  setAlpha(
    sheet?.stave,
    blend(before.beat.focus === 'signature' ? 1 : 0.75, after.beat.focus === 'signature' ? 1 : 0.75)
  );
}

function paintKeyboard(
  piano: Piano | undefined,
  labels: Map<number, VectorNode>,
  before: BeatState,
  after: BeatState,
  blend: Blend
) {
  if (!piano) return;
  setAlpha(piano.group, blend(viewStrength('keyboard', before), viewStrength('keyboard', after)));
  for (const [midi, key] of piano.keys) {
    const rest = key.hasClass('music-black') ? 'var(--ink)' : 'var(--surface)';
    const level = blend(Number(before.keys.has(midi)), Number(after.keys.has(midi)));
    key.setAttribute('style', `fill:color-mix(in srgb,${rest},${COLORS[0]} ${level * 78}%)`);
    setAlpha(labels.get(midi), level);
  }
}

function paintDrums(
  drum: DrumSet | undefined,
  before: BeatState,
  after: BeatState,
  elapsed: number
) {
  if (!drum) return;
  const started = after.drumsAt >= 0;
  const starting = started && before.drumsAt < 0;
  const base = viewStrength('drums', after);
  const opacity = starting
    ? arrive(Math.min(1, elapsed / ARRIVE.duration)) * (base - DIM) + DIM
    : base;
  setAlpha(drum.group, opacity);
  const step = after.tick % STEPS;
  drum.cursor.setAttribute('x', drum.x + 1 + step * drum.size);
  drum.cursor.setAttribute('data-drum-playhead', step + 1);
  setAlpha(drum.cursor, Number(started));
}

function placeMusicCallout(
  tag: ReturnType<typeof pill> | undefined,
  state: BeatState,
  { centers, top, drumY }: ReturnType<typeof drawMusicPanels>
) {
  if (!tag) return;
  const x = centers[state.active[0] ?? 0];
  if (state.beat.focus === 'signature') tag.place([114, top + 60], [197, top + 19]);
  else if (state.beat.focus === 'drums') tag.place([240, drumY], [338, drumY - 34]);
  else if (state.beat.focus === 'intervals') tag.place([x + 45, top + 160], [x + 105, top + 212]);
  else tag.place([x, top + 73], [x + (x > 795 ? -97 : 84), top + 10]);
}

export function buildMusic(
  spec: MusicSpec,
  root: VectorNode,
  beatTimesMs: number[],
  staff?: BuildMusicStaff
) {
  const surface = diagram(root, spec.title);
  const pitches = musicPitches(spec.key, spec.degrees);
  const times = beatTimesMs.map(ms => ms / 1000);
  const panels = drawMusicPanels(surface, spec, pitches, staff);
  const play = timeline();
  const callouts = spec.beats.map((beat, i) => {
    const label = musicCallout(beat, pitches);
    if (!label) return undefined;
    const tag = pill(surface, label, 'callout');
    tag.group.data.secondaryLabel = 'true';
    appear(play, tag.group, times[i], times[i + 1]);
    return tag;
  });
  const barDuration = spec.drums ? (60 / spec.drums.bpm) * (STEPS / SIXTEENTHS_PER_BEAT) : Infinity;
  return {
    cuts: new Set([...times, ...play.cuts]),
    seek(seconds: number, reduced = false) {
      const index = times.reduce((last, time, at) => (seconds >= time ? at : last), 0);
      const after = musicState(spec, pitches, times, index, seconds);
      const elapsed = Math.max(0, seconds - times[index]);
      const cycling = after.beat.cycle && after.tick >= STEPS;
      const barStart = cycling
        ? times[after.drumsAt] + Math.floor(after.tick / STEPS) * barDuration
        : times[index];
      const priorTime = index ? times[index] : seconds;
      const before = cycling
        ? musicState(spec, pitches, times, index, barStart - barDuration / 2)
        : musicState(spec, pitches, times, Math.max(0, index - 1), priorTime);
      const transitionElapsed = Math.max(0, seconds - barStart);
      const transition = Math.min(FOCUS.duration, (times[index + 1] ?? Infinity) - times[index]);
      const strength = reduced ? 1 : ease(Math.min(1, transitionElapsed / transition));
      const blend: Blend = (a, b) => a + (b - a) * strength;
      paintMusicNotation(panels, before, after, blend);
      paintKeyboard(panels.piano, panels.keyLabels, before, after, blend);
      paintDrums(panels.drum, before, after, elapsed);
      placeMusicCallout(callouts[index], after, panels);
      play.seek(seconds, reduced);
    },
  };
}
function labelFitsKey(
  node: VectorNode,
  key: VectorNode,
  keys: Map<number, VectorNode>,
  gap: number
) {
  const [ink] = vectorBounds(node);
  const [area] = vectorBounds(key);
  if (
    !ink ||
    !area ||
    ink.left < area.left ||
    ink.right > area.right ||
    ink.top < area.top ||
    ink.bottom > area.bottom
  )
    return false;
  for (const other of keys.values()) {
    if (other === key) continue;
    const [obstacle] = vectorBounds(other);
    if (obstacle && boxDistance(ink, obstacle) < gap) return false;
  }
  return true;
}
