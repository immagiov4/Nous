import { create, type Font } from 'fontkit';
import { interLatin } from './interLatin';
import type { LayoutBounds } from './layoutValidation';

export const studioTypeStyles = {
  'array-value': [32, 700, true],
  'hud-number': [47, 700, true],
  'hud-label': [17, 640, false],
  'settled-label': [16, 650, false],
  'search-label': [13, 650, false],
  'heap-value': [22, 720, true],
  'heap-index': [13, 400, false],
  'heap-legend': [13, 690, false],
  'pill-text': [16, 640, false],
  'axis-label': [14, 630, false],
  tick: [14, 400, false],
} as const;

export type StudioTextStyle = keyof typeof studioTypeStyles;
export type StudioAnchor = 'start' | 'middle' | 'end';

interface GlyphShape {
  readonly path: string;
  readonly x: number;
  readonly y: number;
}

export interface StudioTextShape {
  readonly advance: number;
  readonly scale: number;
  readonly bounds: LayoutBounds;
  readonly glyphs: readonly GlyphShape[];
}

// Fontkit 3 uses Uint8Array in both its browser and Node entry points.
const loadFont = create as unknown as (bytes: Uint8Array) => Font;
const weights = new Map<number, Font>();
let inter: Font | undefined;

function fontAt(weight: number): Font {
  const cached = weights.get(weight);
  if (cached) return cached;
  inter ??= loadFont(Uint8Array.from(atob(interLatin), char => char.codePointAt(0) ?? 0));
  const font = inter.getVariation({ wght: weight });
  weights.set(weight, font);
  return font;
}

/** Measured ink and painted paths come from the same shaped Inter glyphs. */
export function studioTextShape(
  text: string,
  style: StudioTextStyle,
  anchor: StudioAnchor,
  size: number = studioTypeStyles[style][0]
): StudioTextShape {
  const rows = text.split('\n');
  if (rows.length > 1) return multilineShape(rows, style, anchor, size);
  const [, weight, tabular] = studioTypeStyles[style];
  const font = fontAt(weight);
  const run = font.layout(text, tabular ? ['tnum'] : []);
  const scale = size / font.unitsPerEm;
  const offset = run.advanceWidth * (anchor === 'middle' ? 0.5 : Number(anchor === 'end'));
  let cursorX = -offset;
  let cursorY = 0;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const glyphs: GlyphShape[] = [];
  run.glyphs.forEach((glyph, index) => {
    const { xOffset, yOffset, xAdvance, yAdvance } = run.positions[index];
    const x = cursorX + xOffset;
    const y = cursorY + yOffset;
    cursorX += xAdvance;
    cursorY += yAdvance;
    const path = glyph.path;
    const { minX, minY, maxX, maxY } = path.bbox;
    if (!Number.isFinite(minX)) return;
    glyphs.push({ path: path.toSVG(), x: x * scale, y: -y * scale });
    left = Math.min(left, (x + minX) * scale);
    top = Math.min(top, -(y + maxY) * scale);
    right = Math.max(right, (x + maxX) * scale);
    bottom = Math.max(bottom, -(y + minY) * scale);
  });
  const bounds = glyphs.length
    ? { left, top, right, bottom }
    : { left: 0, top: 0, right: 0, bottom: 0 };
  return { advance: run.advanceWidth * scale, scale, bounds, glyphs };
}

function multilineShape(
  rows: string[],
  style: StudioTextStyle,
  anchor: StudioAnchor,
  size: number
) {
  const lines = rows.map(row => studioTextShape(row, style, anchor, size));
  const leading = size * 1.06;
  const baseline = (index: number) => (index - (rows.length - 1) / 2) * leading;
  const ink = lines.flatMap((line, index) => {
    if (!line.glyphs.length) return [];
    const y = baseline(index);
    return [{ ...line.bounds, top: line.bounds.top + y, bottom: line.bounds.bottom + y }];
  });
  return {
    advance: Math.max(...lines.map(line => line.advance)),
    scale: lines[0].scale,
    bounds: ink.length
      ? {
          left: Math.min(...ink.map(box => box.left)),
          top: Math.min(...ink.map(box => box.top)),
          right: Math.max(...ink.map(box => box.right)),
          bottom: Math.max(...ink.map(box => box.bottom)),
        }
      : lines[0].bounds,
    glyphs: lines.flatMap((line, index) =>
      line.glyphs.map(glyph => ({ ...glyph, y: glyph.y + baseline(index) }))
    ),
  };
}
