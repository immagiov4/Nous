import { diagram, pill, placeTextAbove, textAt } from './chart';
import { studioStage } from './chartDimensions';
import { MIN_TEXT_GAP_PX, MIN_TEXT_PX } from './layoutValidation';
import { ARRIVE, appear, DIM, FOCUS, timeline } from './motion';
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
import { StudioLayoutError } from './studioLayoutError';
import { motionEase } from './timeline';
import { type Box, boxDistance, enclosingBoxes, vectorBounds } from './vectorBounds';
import { svg, type VectorNode } from './vectorScene';

export type BuildMusicStaff = typeof drawMusicStaff;
const SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const ACCENT = 'var(--accent)';
const NOTE = 'var(--note-ink)';
const INK = 'var(--ink)';
const COLORS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-0)'];
const CURSOR_STROKE = 3;
const CURSOR_PAD = 3;
const PREFERRED_CELL_HEIGHT = 26;
const MIN_KEYBOARD_HEIGHT = 26;
const PREFERRED_KEYBOARD_HEIGHT = 104;
const KEY_COUNT = 24;
const GAP = MIN_TEXT_GAP_PX;
const MIN_DRUM_STEP_WIDTH = CURSOR_STROKE + 2;

type PanelWidth = { left: number; right: number };
const WHITE_KEY_STROKE = 1.35;
const BLACK_KEY_STROKE = 1.3;

function placeTextBelow(node: VectorNode, limit: number) {
  const [ink] = vectorBounds(node);
  if (ink) node.setAttribute('y', node.number('y') + limit - ink.top);
}

function panelInk(group: VectorNode) {
  return enclosingBoxes(group).flatMap(mark => mark.boxes);
}

function bottomOf(group: VectorNode) {
  return Math.max(...panelInk(group).map(box => box.bottom));
}

function keyboard(
  surface: VectorNode,
  pitches: number[],
  { left, right, top: y, height }: PanelWidth & { top: number; height: number }
) {
  const first = Math.floor(Math.min(...pitches) / 12) * 12;
  const start = Math.max(first, Math.max(...pitches) - (KEY_COUNT - 1));
  const whiteCount = Array.from({ length: KEY_COUNT }, (_, index) => start + index).filter(midi =>
    SEMITONES.includes(midi % 12)
  ).length;
  const startsOnBlack = !SEMITONES.includes(start % 12);
  const blackWidthRatio = 0.68;
  const leading = startsOnBlack ? blackWidthRatio / 2 : 0;
  const width = (right - left) / (whiteCount + leading);
  const firstWhite = left + leading * width;
  let whites = 0;
  const black: number[] = [];
  const group = svg(surface, 'g', { class: 'music-keyboard' });
  const keys = new Map<number, VectorNode>();
  const labels = new Map<number, { x: number; y: number }>();
  const rect = (midi: number, x: number, width: number, h: number, black: boolean) => {
    const key = svg(svg(group, 'g', {}), 'rect', {
      x,
      y,
      width,
      height: h,
      rx: black ? 4 : 5,
      class: black ? 'music-black' : 'music-white',
      'data-pitch': midi,
      'stroke-width': black ? BLACK_KEY_STROKE : WHITE_KEY_STROKE,
    });
    if (black) key.setAttribute('data-domain-occluder', '');
    keys.set(midi, key);
    labels.set(midi, { x: x + width / 2, y: y + h - 15 });
  };
  for (let midi = start; midi < start + KEY_COUNT; midi++) {
    if (SEMITONES.includes(midi % 12))
      rect(midi, firstWhite + whites++ * width, width - 1, height, false);
    else black.push(midi);
  }
  const blackWidth = width * blackWidthRatio;
  for (const midi of black) {
    const index = Array.from(keys.keys()).filter(
      p => p < midi && SEMITONES.includes(p % 12)
    ).length;
    rect(midi, firstWhite + index * width - blackWidth / 2, blackWidth, height * 0.61, true);
  }
  return { keys, labels };
}

function drums(
  surface: VectorNode,
  pattern: NonNullable<MusicSpec['drums']>,
  { left, right, bottom, cellHeight }: PanelWidth & { bottom: number; cellHeight: number }
) {
  const group = svg(surface, 'g', { 'data-music-view': 'drums' });
  const tracks = copy.percussion.map(name => textAt(group, 0, 0, name, 'end', 'music-label'));
  const heading = textAt(group, 0, 0, String(pattern.bpm) + copy.tempo, 'end', 'music-label');
  const labelWidth = Math.max(...[...tracks, heading].map(label => -label.glyphs().bounds.left));
  const gridLeft = left + labelWidth + GAP + CURSOR_STROKE;
  const size = (right - gridLeft) / STEPS;
  if (size < MIN_DRUM_STEP_WIDTH) throw new StudioLayoutError('music-stage-too-small');
  const cellInset = Math.min(CURSOR_PAD, size / 4);
  const rowHeight = Math.max(
    cellHeight + GAP,
    ...tracks.map(label => label.glyphs().bounds.bottom - label.glyphs().bounds.top + GAP)
  );
  const gridHeight = rowHeight * (hitTracks.length - 1) + cellHeight;
  const y = bottom - gridHeight - CURSOR_PAD - CURSOR_STROKE / 2;
  const labelRight = gridLeft - GAP - CURSOR_STROKE;
  const headerBottom = y - CURSOR_PAD - CURSOR_STROKE / 2 - GAP;
  heading.setAttribute('x', labelRight);
  placeTextAbove(heading, headerBottom);
  for (const [index, track] of hitTracks.entries()) {
    const yy = y + rowHeight * index;
    const label = tracks[index];
    const ink = label.glyphs().bounds;
    label.setAttribute('x', labelRight);
    label.setAttribute('y', yy + (cellHeight - ink.top - ink.bottom) / 2);
    for (let step = 0; step < STEPS; step++) {
      const x = gridLeft + step * size;
      const hit = pattern[track].includes(step + 1);
      svg(group, 'rect', {
        x: x + cellInset,
        y: yy,
        width: size - 2 * cellInset,
        height: cellHeight,
        rx: Math.min(5, cellHeight / 3),
        fill: hit ? COLORS[index] : 'var(--line)',
        'data-hit': hit ? track : '',
      });
    }
  }
  const beatLabels = Array.from({ length: STEPS / SIXTEENTHS_PER_BEAT }, (_, beat) => {
    const tick = textAt(
      group,
      gridLeft + (beat * SIXTEENTHS_PER_BEAT + 0.5) * size,
      0,
      String(beat + 1),
      'middle',
      'music-label'
    );
    placeTextAbove(tick, headerBottom);
    return tick;
  });
  if (!labelsFit(beatLabels, { left, right })) beatLabels.forEach(hide);
  const cursor = svg(group, 'rect', {
    x: gridLeft + 1,
    y: y - CURSOR_PAD,
    width: size - 2,
    height: gridHeight + 2 * CURSOR_PAD,
    rx: 7,
    fill: 'none',
    stroke: ACCENT,
    'stroke-width': CURSOR_STROKE,
    'data-drum-playhead': 0,
  });
  return { group, cursor, x: gridLeft, size, y };
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

function drawIntervals(
  surface: VectorNode,
  pitches: Pitches,
  centers: number[],
  top: number,
  region: PanelWidth,
  tickHeight: number
) {
  const row = svg(surface, 'g', { 'data-music-view': 'intervals' });
  const groups = pitches.slice(1).map(([note], i) => {
    const semitones = note.midi - pitches[i][0].midi;
    const group = svg(row, 'g', { 'data-music-interval': semitones });
    const tickInset = Math.min(GAP / 2, (centers[i + 1] - centers[i]) / 4);
    const left = centers[i] + tickInset;
    const right = centers[i + 1] - tickInset;
    const short = semitones === 1;
    const label = textAt(
      group,
      (left + right) / 2,
      0,
      short ? copy.semitone : copy.tone,
      'middle',
      'music-label'
    );
    placeTextBelow(label, top);
    label.setAttribute('style', `fill:${short ? NOTE : INK}`);
    return { group, left, right, short, label };
  });
  if (
    !labelsFit(
      groups.map(({ label }) => label),
      region
    )
  )
    throw new StudioLayoutError('music-stage-too-small');
  const y = Math.ceil(bottomOf(row)) + GAP + tickHeight + 1;
  for (const { group, left, right, short } of groups) {
    svg(group, 'polyline', {
      points: tickHeight
        ? `${left},${y - tickHeight} ${left},${y} ${right},${y} ${right},${y - tickHeight}`
        : `${left},${y} ${right},${y}`,
      fill: 'none',
      stroke: short ? ACCENT : 'var(--chart-1)',
      'stroke-width': 2,
    });
  }
  return { row, groups: groups.map(({ group }) => group) };
}

function drawKeyLabels(piano: Piano | undefined, pitches: Pitches) {
  const labels = new Map<number, VectorNode>();
  if (!piano) return labels;
  const names = new Map(
    pitches.flatMap(group => group.map(note => [note.midi, note.name] as const))
  );
  for (const [midi, name] of names) {
    const pos = piano.labels.get(midi);
    if (!pos) continue;
    const key = piano.keys.get(midi);
    if (!key?.parent) continue;
    const node = textAt(key.parent, pos.x, pos.y, name, 'middle', 'music-label');
    key.parent.setAttribute('data-label-container', '');
    if (!labelFitsKey(node, key, piano.keys, GAP)) hide(node);
    labels.set(midi, node);
  }
  return labels;
}

function hide(node: VectorNode) {
  node.setAttribute('visibility', 'hidden');
}

function labelsFit(labels: VectorNode[], { left, right }: PanelWidth) {
  let previous: Box | undefined;
  for (const label of labels) {
    const [ink] = vectorBounds(label);
    if (
      !ink ||
      ink.left < left ||
      ink.right > right ||
      (previous && boxDistance(previous, ink) < GAP)
    )
      return false;
    previous = ink;
  }
  return true;
}

function drawPitchLabels(surface: VectorNode, pitches: Pitches, centers: number[], top: number) {
  const row = svg(surface, 'g', { 'data-music-view': 'pitches' });
  return pitches.map((notes, index) => {
    const label = textAt(row, centers[index], 0, pitchName(notes), 'middle', 'music-label');
    placeTextBelow(label, top);
    return label;
  });
}

function fitDrums(
  surface: VectorNode,
  pattern: NonNullable<MusicSpec['drums']>,
  {
    region,
    top,
    bottom,
    staffBottom,
    keyboardReserve,
    sideBySide,
  }: {
    region: PanelWidth;
    top: number;
    bottom: number;
    staffBottom: number;
    keyboardReserve: number;
    sideBySide: boolean;
  }
) {
  const trackCount = hitTracks.length;
  const compactHeight = trackCount * MIN_TEXT_PX + 4 * GAP + 2 * CURSOR_PAD + CURSOR_STROKE;
  const preferredHeight = compactHeight + trackCount * (PREFERRED_CELL_HEIGHT - MIN_TEXT_PX);
  const cellsGrow =
    sideBySide || bottom - staffBottom - keyboardReserve > preferredHeight + 2 * GAP;
  const preferredBottom = sideBySide
    ? top + preferredHeight
    : staffBottom + PREFERRED_KEYBOARD_HEIGHT + compactHeight + 5 * GAP;
  return drums(surface, pattern, {
    ...region,
    bottom: Math.min(bottom, preferredBottom),
    cellHeight: cellsGrow ? PREFERRED_CELL_HEIGHT : MIN_TEXT_PX,
  });
}

function drawPitchLayout(
  surface: VectorNode,
  pitches: Pitches,
  {
    region,
    centers,
    staffBottom,
    upperBottom,
    keyboardReserve,
    hasStaff,
    hasIntervals,
  }: {
    region: PanelWidth;
    centers: number[];
    staffBottom: number;
    upperBottom: number;
    keyboardReserve: number;
    hasStaff: boolean;
    hasIntervals: boolean;
  }
) {
  const tickHeight = upperBottom - staffBottom >= keyboardReserve + MIN_TEXT_PX + 5 * GAP ? GAP : 0;
  const intervalsReserve = hasIntervals ? MIN_TEXT_PX + 2 * GAP + tickHeight + 2 : 0;
  const markers = drawPitchLabels(surface, pitches, centers, Math.ceil(staffBottom) + GAP);
  const markerBottom = Math.max(
    ...markers.flatMap(marker => vectorBounds(marker).map(box => box.bottom))
  );
  const markersFit =
    labelsFit(markers, region) &&
    markerBottom + intervalsReserve + keyboardReserve + GAP <= upperBottom;
  if (!markersFit) {
    if (!hasStaff) throw new StudioLayoutError('music-stage-too-small');
    markers.forEach(hide);
  }
  const pitchBottom = markersFit ? markerBottom : staffBottom;
  const intervalLayout = hasIntervals
    ? drawIntervals(surface, pitches, centers, Math.ceil(pitchBottom) + GAP, region, tickHeight)
    : undefined;
  return {
    markers,
    intervals: intervalLayout?.groups ?? [],
    contentBottom: intervalLayout ? bottomOf(intervalLayout.row) : pitchBottom,
  };
}

function drawMusicPanels(
  surface: VectorNode,
  spec: MusicSpec,
  pitches: Pitches,
  staff: BuildMusicStaff | undefined,
  sideBySide: boolean
) {
  const stage = studioStage(surface.viewport);
  const top = stage.top + GAP;
  const bottom = stage.bottom - GAP;
  const fullWidth = { left: GAP, right: stage.width - GAP };
  const columnBreak = (fullWidth.left + fullWidth.right - GAP) / 2;
  const region = sideBySide ? { ...fullWidth, right: columnBreak } : fullWidth;
  const drumRegion = sideBySide ? { ...fullWidth, left: columnBreak + GAP } : fullWidth;
  const withStaff = spec.views.includes('staff');
  if (withStaff && !staff) throw new StudioLayoutError('music-staff-unavailable');
  const sheet = withStaff ? staff?.(surface, spec.key, pitches, region) : undefined;
  if (sheet) sheet.surface.y = top - Math.min(...panelInk(sheet.surface).map(box => box.top));
  const staffBottom = sheet ? bottomOf(sheet.surface) : stage.top;
  const keyboardShown = spec.views.includes('keyboard');
  const keyboardReserve = keyboardShown ? MIN_KEYBOARD_HEIGHT + WHITE_KEY_STROKE : 0;
  const drum = spec.drums
    ? fitDrums(surface, spec.drums, {
        region: drumRegion,
        top,
        bottom,
        staffBottom,
        keyboardReserve,
        sideBySide,
      })
    : undefined;
  const upperBottom =
    drum && !sideBySide
      ? Math.floor(Math.min(...panelInk(drum.group).map(box => box.top))) - GAP
      : bottom;
  const columnWidth = (region.right - region.left) / pitches.length;
  const centers = sheet?.x ?? pitches.map((_, index) => region.left + (index + 0.5) * columnWidth);
  const notation = drawPitchLayout(surface, pitches, {
    region,
    centers,
    staffBottom,
    upperBottom,
    keyboardReserve,
    hasStaff: withStaff,
    hasIntervals: spec.views.includes('intervals'),
  });
  const piano = drawKeyboard(surface, pitches, {
    region,
    contentBottom: notation.contentBottom,
    upperBottom,
    shown: keyboardShown,
  });
  return {
    ...notation,
    sheet,
    piano,
    drum,
    centers,
    top,
    keyLabels: drawKeyLabels(piano, pitches),
  };
}

function drawKeyboard(
  surface: VectorNode,
  pitches: Pitches,
  {
    region,
    contentBottom,
    upperBottom,
    shown,
  }: { region: PanelWidth; contentBottom: number; upperBottom: number; shown: boolean }
) {
  if (contentBottom > upperBottom) throw new StudioLayoutError('music-stage-too-small');
  if (!shown) return undefined;
  const top = Math.ceil(contentBottom) + GAP + WHITE_KEY_STROKE / 2;
  const height = Math.min(PREFERRED_KEYBOARD_HEIGHT, upperBottom - top - WHITE_KEY_STROKE / 2);
  if (height < MIN_KEYBOARD_HEIGHT) throw new StudioLayoutError('music-stage-too-small');
  return keyboard(
    surface,
    pitches.flatMap(chord => chord.map(note => note.midi)),
    { ...region, top, height }
  );
}

function fitMusicPanels(
  surface: VectorNode,
  spec: MusicSpec,
  pitches: Pitches,
  staff?: BuildMusicStaff
) {
  const stacked = svg(surface, 'g', {});
  try {
    return drawMusicPanels(stacked, spec, pitches, staff, false);
  } catch (error) {
    if (
      !spec.drums ||
      !(error instanceof StudioLayoutError) ||
      error.code !== 'music-stage-too-small'
    )
      throw error;
    surface.children.pop();
    return drawMusicPanels(svg(surface, 'g', {}), spec, pitches, staff, true);
  }
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
  for (const [i, mark] of markers.entries())
    setAlpha(mark, blend(symbol(before, i), symbol(after, i)));
  for (const [i, mark] of intervals.entries())
    setAlpha(mark, blend(interval(before, i), interval(after, i)));
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
  for (const [midi, key] of piano.keys) {
    const rest = key.hasClass('music-black') ? 'var(--ink)' : 'var(--surface)';
    const level = blend(Number(before.keys.has(midi)), Number(after.keys.has(midi)));
    key.setAttribute(
      'style',
      `fill:color-mix(in srgb,${rest},var(--music-active-key-fill) ${level * 100}%)`
    );
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
  const focus = after.beat.focus;
  const base = !focus || focus === 'drums' ? 1 : DIM;
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
  { centers, top, contentBottom, drum }: ReturnType<typeof drawMusicPanels>
) {
  if (!tag) return;
  const x = centers[state.active[0] ?? 0];
  const drumFocus = state.beat.focus === 'drums' ? drum : undefined;
  const referenceY = state.beat.focus === 'intervals' ? contentBottom : top;
  const y = drumFocus?.y ?? referenceY;
  const anchor = drumFocus?.x ?? x;
  tag.place([anchor, y], [anchor, y - GAP]);
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
  const panels = fitMusicPanels(surface, spec, pitches, staff);
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
