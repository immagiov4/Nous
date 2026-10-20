import type { PlaybackRange } from '../../../packages/shared-types/lessonPlayback';

export const POSITIONS = { start: 0, middle: 1 / 2, end: 1 } as const;
export type Position = keyof typeof POSITIONS;
export interface AtlasFinding {
  kind:
    | 'visual-empty'
    | 'visual-symbol-only'
    | 'caption-word-mismatch'
    | 'speech-inline-math-omitted'
    | 'visual-clipped'
    | 'console-error'
    | 'render-error'
    | 'scene-invalid'
    | 'import-error';
  detail: unknown;
}
export interface VisualFacts {
  text: string;
  prose: string;
  mediaCount: number;
  mathCount: number;
}

/** Rendered mathematics is content; punctuation-only prose remains a structural finding. */
export function visualFindings(
  facts: VisualFacts,
  speech: string,
  expectedVisual: boolean
): AtlasFinding[] {
  if (!expectedVisual || !speech.trim() || facts.mediaCount || facts.mathCount) return [];
  if (!facts.text.trim() && !facts.mathCount) return [{ kind: 'visual-empty', detail: facts }];
  if (!/[\p{L}\p{N}]/u.test(facts.prose)) return [{ kind: 'visual-symbol-only', detail: facts }];
  return [];
}

/** Use Unicode word boundaries and canonical speech offsets, rather than substring membership. */
export function captionFindings(
  speech: string,
  captions: readonly { text: string; range: PlaybackRange }[]
): AtlasFinding[] {
  const spoken = Array.from(
    new Intl.Segmenter('it', { granularity: 'word' }).segment(speech)
  ).filter(part => part.isWordLike);
  return captions.flatMap(caption => {
    const overlapping = spoken.filter(
      part =>
        part.index < caption.range.end && part.index + part.segment.length > caption.range.start
    );
    const partial = overlapping.some(
      part =>
        part.index < caption.range.start || part.index + part.segment.length > caption.range.end
    );
    const captionWords = Array.from(
      new Intl.Segmenter('it', { granularity: 'word' }).segment(caption.text)
    )
      .filter(part => part.isWordLike)
      .map(part => part.segment);
    const matches = captionWords.join(' ') === overlapping.map(part => part.segment).join(' ');
    return partial || !matches
      ? [
          {
            kind: 'caption-word-mismatch' as const,
            detail: { ...caption, spoken: overlapping.map(part => part.segment) },
          },
        ]
      : [];
  });
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export function outsideBox(box: Box, boundary: Box) {
  return {
    left: Math.max(0, boundary.left - box.left),
    top: Math.max(0, boundary.top - box.top),
    right: Math.max(0, box.right - boundary.right),
    bottom: Math.max(0, box.bottom - boundary.bottom),
  };
}
