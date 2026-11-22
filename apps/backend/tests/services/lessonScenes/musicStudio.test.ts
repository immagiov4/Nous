import { planCallouts } from '@shared/lessonStudios/callouts';
import { readerStudioViewports, type StudioViewport } from '@shared/lessonStudios/chartDimensions';
import { MIN_TEXT_GAP_PX, MIN_TEXT_PX } from '@shared/lessonStudios/layoutValidation';
import { buildMusic } from '@shared/lessonStudios/music';
import { checkMusicSpec, MusicSpecSchema } from '@shared/lessonStudios/musicSpec';
import { studioTextShape } from '@shared/lessonStudios/studioTypography';
import { boxDistance, enclosingBoxes, isVisible } from '@shared/lessonStudios/vectorBounds';
import { descendants, VectorNode } from '@shared/lessonStudios/vectorScene';
import { assert, describe, expect, test } from 'vitest';

const scaleFixture = {
  title: 'La scala di Si minore naturale',
  key: 'Bm',
  views: ['staff', 'keyboard', 'intervals'],
  beats: [
    { label: 'Due diesis', focus: 'signature' },
    { label: 'Da Si a Si', focus: 'keyboard' },
    { label: 'Due semitoni', focus: 'intervals', active: [1, 2, 4, 5] },
    { label: 'Toni interi', focus: 'intervals' },
  ],
};

const rhythmFixture = {
  title: 'Accordi e ritmo in Si minore',
  key: 'Bm',
  degrees: [1, 6, 3, 7],
  views: ['staff', 'keyboard', 'drums'],
  drums: {
    bpm: 96,
    kick: [1, 9],
    snare: [5, 13],
    hat: [1, 3, 5, 7, 9, 11, 13, 15],
  },
  beats: [
    { label: 'Si, Re, Fa♯', focus: 'staff', active: [0] },
    { label: 'Sol maggiore', focus: 'staff', active: [1] },
    { label: 'Re e La', focus: 'staff', active: [2, 3] },
    { label: 'Un accordo per battuta', focus: 'drums', cycle: true },
  ],
};

const duration = 18;

async function play(fixture: unknown, viewport: StudioViewport) {
  const spec = MusicSpecSchema.parse(fixture);
  checkMusicSpec(spec);
  const root = new VectorNode('root', {}, viewport);
  root.data.durationMs = String(duration * 1000);
  const { drawMusicStaff } = await import('@shared/lessonStudios/musicStaff');
  const motion = buildMusic(spec, root, [0, 2000, 4000, 6000], drawMusicStaff);
  const surface = root.children[0];
  const callouts = planCallouts(surface, motion, duration);
  return {
    surface,
    seek(seconds: number, reduced = false) {
      motion.seek(seconds, reduced);
      callouts(seconds);
    },
  };
}

function expectReadable(surface: VectorNode, viewport: StudioViewport, at: number) {
  const painted = enclosingBoxes(surface).filter(mark => !mark.element.hasClass('leader'));
  for (const { element, boxes } of painted) {
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(viewport.width);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(viewport.height);
    }
    if (!element.label) continue;
    expect(element.label.size).toBeGreaterThanOrEqual(MIN_TEXT_PX);
    const key = element.parent?.children.find(node => node.attrs['data-pitch'] !== undefined);
    const pill = element.parent?.parent?.children.find(node => node.tag === 'rect');
    for (const other of painted) {
      if ([element, key, pill].includes(other.element)) continue;
      const distance = Math.min(
        ...boxes.flatMap(box => other.boxes.map(obstacle => boxDistance(box, obstacle)))
      );
      const name = other.element.textContent || other.element.attrs.class || other.element.tag;
      expect(distance, `${element.textContent} against ${name} at ${at}s`).toBeGreaterThanOrEqual(
        MIN_TEXT_GAP_PX - 1e-8
      );
    }
  }
}

function activeKeys(nodes: VectorNode[]) {
  return nodes
    .filter(node => String(node.attrs.style).includes('100%)'))
    .map(node => node.number('data-pitch'))
    .sort((a, b) => a - b);
}

test('renders readable accidentals in captions with the bundled font', () => {
  const sharp = studioTextShape('Do♯', 'music-label', 'start');
  const flat = studioTextShape('Si♭', 'music-label', 'start');
  expect(sharp.glyphs).toEqual(studioTextShape('Do#', 'music-label', 'start').glyphs);
  expect(flat.glyphs).toEqual(studioTextShape('Sib', 'music-label', 'start').glyphs);
});

const wideStage = {
  desktop: readerStudioViewports.desktop,
  compactPhone: readerStudioViewports.compactPhone,
  phoneFullscreen: readerStudioViewports.phoneFullscreen,
};

describe.each(Object.entries(wideStage))('%s candidate stage', (_name, viewport) => {
  test('shows the B minor key signature and both semitones at readable spacing', async () => {
    const scene = await play(scaleFixture, viewport);
    const nodes = [...descendants(scene.surface)];
    const notes = nodes.filter(node => node.hasClass('vf-stavenote'));
    const keys = nodes.filter(node => node.attrs['data-pitch'] !== undefined);
    const intervals = nodes.filter(node => node.attrs['data-music-interval'] !== undefined);
    expect(notes).toHaveLength(8);
    const signature = nodes.find(node => node.hasClass('vf-keysignature'));
    assert(signature);
    expect(signature.children.filter(node => node.tag === 'path')).toHaveLength(2);
    expect(keys).toHaveLength(24);
    for (const at of [0, 0.2, 1, 2, 2.2, 3, 4, 4.2, 5, 6, 6.2, 7]) {
      scene.seek(at);
      expectReadable(scene.surface, viewport, at);
    }
    expect(intervals.map(node => node.number('data-music-interval'))).toEqual([
      2, 1, 2, 2, 1, 2, 2,
    ]);
    scene.seek(5);
    expect(intervals.flatMap((node, index) => (node.opacity === 1 ? [index] : []))).toEqual([1, 4]);
    expect(activeKeys(keys)).toEqual([73, 74, 78, 79]);
    scene.seek(7);
    expect(intervals.every(node => node.opacity === 1)).toBe(true);
    scene.seek(0, true);
    expect(notes.every(node => (node.opacity ?? 1) < 1)).toBe(true);
  });

  test('keeps every drum cell readable through a bar and seeks across the four triads', async () => {
    const scene = await play(rhythmFixture, viewport);
    const nodes = [...descendants(scene.surface)];
    const notes = nodes.filter(node => node.hasClass('vf-stavenote'));
    const keys = nodes.filter(node => node.attrs['data-pitch'] !== undefined);
    const cells = nodes.filter(node => node.attrs['data-hit'] !== undefined);
    const cursor = nodes.find(node => node.attrs['data-drum-playhead'] !== undefined);
    assert(cursor);
    expect(notes).toHaveLength(4);
    expect(keys).toHaveLength(24);
    expect(cells).toHaveLength(48);
    for (const [index, [track, steps]] of Object.entries(rhythmFixture.drums)
      .filter((entry): entry is [string, number[]] => Array.isArray(entry[1]))
      .entries()) {
      expect(
        cells
          .slice(index * 16, (index + 1) * 16)
          .flatMap((cell, step) => (cell.attrs['data-hit'] === track ? [step + 1] : []))
      ).toEqual(steps);
    }
    for (const at of [0, 0.2, 1, 2, 2.2, 3, 4, 4.2, 5, 6, 6.2]) {
      scene.seek(at);
      expectReadable(scene.surface, viewport, at);
    }
    for (let step = 0; step < 16; step++) {
      const at = 6 + ((step + 0.5) * 60) / (96 * 4);
      scene.seek(at);
      expect(cursor.number('data-drum-playhead')).toBe(step + 1);
      expectReadable(scene.surface, viewport, at);
    }
    for (const [bar, expected] of [
      [71, 74, 78],
      [67, 71, 74],
      [62, 66, 69],
      [69, 73, 76],
    ].entries()) {
      scene.seek(6.5 + bar * 2.5);
      expect(activeKeys(keys)).toEqual(expected);
      expect(notes.flatMap((node, index) => (node.opacity === 1 ? [index] : []))).toEqual([bar]);
    }
    scene.seek(0, true);
    expect(isVisible(cursor)).toBe(false);
    expect(activeKeys(keys)).toEqual([71, 74, 78]);
  });
});

test('a narrow keyboard-only layout cannot hide its only pitch names', async () => {
  await expect(
    play(
      { ...rhythmFixture, views: ['keyboard'], drums: undefined, beats: [{ focus: 'keyboard' }] },
      readerStudioViewports.compactPhoneInline
    )
  ).rejects.toMatchObject({ code: 'music-stage-too-small' });
});
