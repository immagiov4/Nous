import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import {
  buildImageAnnotateLayout,
  checkImageAnnotateLayout,
} from '@shared/lessonStudios/imageAnnotate';
import { drawImageAnnotation } from '@shared/lessonStudios/imageAnnotateDraw';
import { ImageAnnotateSpecSchema } from '@shared/lessonStudios/imageAnnotateSpec';
import { boxDistance } from '@shared/lessonStudios/vectorBounds';
import { assert, expect, test } from 'vitest';
import { imageAnnotateGold } from './imageAnnotateGold';

test.each(
  Object.entries({
    ...readerStudioViewports,
    wideDesktop: { width: 650, height: 330 },
    widePhone: { width: 350, height: 178 },
  })
)('%s maintains the gold picture, highlights and guide marks at any seek', (_, viewport) => {
  for (const raw of imageAnnotateGold) {
    const spec = ImageAnnotateSpecSchema.parse(raw);
    const times = spec.beats.map((_, index) => 250 + index * 2000);
    const layout = buildImageAnnotateLayout(spec, times, viewport);
    expect(checkImageAnnotateLayout(layout)).toEqual([]);
    const intro = layout.frameAt(0);
    expect(intro.image).toEqual(intro.clip);
    expect(intro.focus).toBeUndefined();
    for (const [index, beat] of spec.beats.entries()) {
      const time = times[index];
      const settled = layout.frameAt(time, true);
      expect(layout.frameAt(time + 500)).toEqual(settled);
      expect(Boolean(settled.focus)).toBe(Boolean(beat.region));
      expect(settled.label?.text).toBe(beat.label);
      expect(settled.rays).toHaveLength(beat.showOverlay ? (spec.overlay?.from.length ?? 0) : 0);
      expect(Boolean(settled.point)).toBe(Boolean(beat.showOverlay));
      for (let offset = 0; offset <= 600; offset += 25) {
        const frame = layout.frameAt(time + offset);
        expect(frame.clip.right).toBeGreaterThan(frame.clip.left);
        expect(frame.clip.bottom).toBeGreaterThan(frame.clip.top);
        for (const ray of frame.rays) {
          for (const [x, y] of [ray.from, ray.to]) {
            expect(x).toBeGreaterThanOrEqual(frame.clip.left);
            expect(x).toBeLessThanOrEqual(frame.clip.right);
            expect(y).toBeGreaterThanOrEqual(frame.clip.top);
            expect(y).toBeLessThanOrEqual(frame.clip.bottom);
          }
        }
        if (frame.label) {
          expect(frame.label.fontPx).toBeGreaterThanOrEqual(14);
          expect(boxDistance(frame.label.bounds, frame.clip)).toBeGreaterThanOrEqual(8);
        }
      }
      expect(layout.frameAt(time + 500)).toEqual(settled);
    }
  }
});

test('rejects a stage that cannot fit an authored annotation', () => {
  const raw = imageAnnotateGold[0];
  const viewport = readerStudioViewports.phone;
  const spec = ImageAnnotateSpecSchema.parse({
    ...raw,
    image: { ...raw.image, width: 100, height: 300 },
    overlay: undefined,
    beats: [{ at: 'b1', region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, label: 'Il centro' }],
  });
  const layout = buildImageAnnotateLayout(spec, [0], viewport);
  const frame = layout.frameAt(500);
  assert(frame.label);
  expect(frame.label.shape.glyphs.length).toBeGreaterThan(0);
  expect(boxDistance(frame.label.bounds, frame.clip)).toBeGreaterThanOrEqual(8);
  const long = {
    ...spec,
    beats: [{ ...spec.beats[0], label: 'Precipitazioni particolarmente intense' }],
  };
  const crowded = buildImageAnnotateLayout(long, [0], { width: 110, height: viewport.height });
  expect(checkImageAnnotateLayout(crowded)).toContain('label-placement');
  expect(crowded.frameAt(500).focus).toBeDefined();
});

test('a brief guided beat shows its label and guides before the next cue', () => {
  const spec = ImageAnnotateSpecSchema.parse(imageAnnotateGold[0]);
  const layout = buildImageAnnotateLayout(spec, [0, 100, 200], readerStudioViewports.phone);
  const frame = layout.frameAt(150);
  expect(frame.label?.text).toBe(spec.beats[1].label);
  expect(frame.rays).toHaveLength(spec.overlay?.from.length ?? 0);
  expect(layout.frameAt(200).label?.text).toBe(spec.beats[2].label);
});

test.each([0, 1])('keeps source pixels visible beneath annotations in gold %s', gold => {
  const spec = ImageAnnotateSpecSchema.parse(imageAnnotateGold[gold]);
  const cues = spec.beats.map((_, index) => index * 2000);
  const drawing = drawImageAnnotation(spec, cues, readerStudioViewports.desktopTall);
  const [clip] = drawing.surface.children;
  const sourceIndex = clip.children.findIndex(node => node.tag === 'image');
  expect(sourceIndex).toBeGreaterThanOrEqual(0);

  for (const [index, beat] of spec.beats.entries()) {
    if (!beat.region) continue;
    drawing.seek(cues[index], true);
    const overlays = clip.children
      .slice(sourceIndex + 1)
      .filter(node => node.attrs.visibility !== 'hidden');
    expect(overlays.some(node => node.tag === 'path' && node.attrs.d)).toBe(true);
    for (const overlay of overlays) {
      expect(overlay.opacity ?? 1).toBeGreaterThan(0);
      expect(overlay.opacity ?? 1).toBeLessThan(1);
    }
  }
});

test('rejects regions outside the image and an overlay reference without data', () => {
  const raw = imageAnnotateGold[0];
  for (const beat of [{ region: { x: 0.8, y: 0, w: 0.5, h: 0.5 } }, { showOverlay: true }]) {
    expect(
      ImageAnnotateSpecSchema.safeParse({
        ...raw,
        overlay: undefined,
        beats: [{ at: 'b1', ...beat }],
      }).success
    ).toBe(false);
  }
});
