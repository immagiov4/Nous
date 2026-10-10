import type {
  LessonPlaybackBlock,
  PlaybackContentBlock,
  PlaybackRange,
} from '@shared/lessonPlayback';

export interface CaptionWord {
  text: string;
  bold: boolean;
  code: boolean;
  list: boolean;
  breakBefore: boolean;
  marker: string;
  source: PlaybackRange;
}
export interface CaptionPause {
  time: number;
  delay: number;
  radius: number;
}

/** Recover the authored lines covered by the canonical speech/source mapping. */
export function captionSource(
  block: LessonPlaybackBlock,
  sources: readonly PlaybackContentBlock[]
) {
  const lines = new Map<string, { text: string; start: number; sourceBlockIndex: number }>();
  for (const span of block.spans) {
    if (span.source.start === span.source.end) continue;
    const source = sources[span.sourceBlockIndex];
    if (source?.type !== 'markdown') throw new Error('Caption source must be Markdown');
    const markdown = source.markdown;
    let start = markdown.lastIndexOf('\n', span.source.start - 1) + 1;
    while (start < span.source.end) {
      const newline = markdown.indexOf('\n', start);
      const end = newline < 0 ? markdown.length : newline;
      lines.set(`${span.sourceBlockIndex}:${start}`, {
        text: markdown.slice(start, end).replace(/\r$/u, ''),
        start,
        sourceBlockIndex: span.sourceBlockIndex,
      });
      start = end + 1;
    }
  }
  let markdown = '';
  const ranges: { source: PlaybackRange; speech: PlaybackRange }[] = [];
  for (const line of lines.values()) {
    const offset = markdown.length;
    for (const span of block.spans) {
      if (span.sourceBlockIndex !== line.sourceBlockIndex) continue;
      const start = Math.max(line.start, span.source.start);
      const end = Math.min(line.start + line.text.length, span.source.end);
      if (start >= end) continue;
      ranges.push({
        source: { start: offset + start - line.start, end: offset + end - line.start },
        speech: {
          start: span.speech.start + start - span.source.start,
          end: span.speech.start + end - span.source.start,
        },
      });
    }
    markdown += `${line.text}\n`;
  }
  return { markdown, ranges };
}

/** Laboratory formatting, retaining source positions for the API's quotation anchors. */
export function captionFormat(original: string) {
  const headings = Array.from(original.matchAll(/^#{1,6}\s+(.+)$/gm), match => match[1]);
  const headingWords = headings.join(' ').trim().split(/\s+/).filter(Boolean).length;
  // Preserve source offsets while omitting headings from the body, as the laboratory does.
  const body = original.replace(/^#{1,6}\s+.+$/gm, match => ' '.repeat(match.length));
  const lines = body.trim().split('\n');
  let lineStart = body.length - body.trimStart().length;
  const words: CaptionWord[] = [];
  let bold = false;
  let code = false;
  for (const line of lines) {
    const list = line.match(/^\s*([-*+]|\d+\.)\s+/);
    const text = list ? line.slice(list[0].length) : line;
    let partStart = lineStart + (list?.[0].length ?? 0);
    let first = true;
    for (const part of text.split(/(\*\*|`)/)) {
      if (part === '**') {
        bold = !bold;
        partStart += part.length;
        continue;
      }
      if (part === '`') {
        code = !code;
        partStart += part.length;
        continue;
      }
      for (const match of part.matchAll(/\S+/g)) {
        words.push({
          text: match[0],
          bold,
          code,
          list: !!list,
          breakBefore: first && !!list,
          marker: list ? (/\d/.test(list[1]) ? list[1] : '•') : '',
          source: {
            start: partStart + match.index,
            end: partStart + match.index + match[0].length,
          },
        });
        first = false;
      }
      partStart += part.length;
    }
    lineStart += line.length + 1;
  }
  return { headings, headingWords, words };
}

/** Keep formatted tokens aligned to canonical speech, including punctuation after inline code. */
export function captionSpeechRanges(
  words: readonly CaptionWord[],
  ranges: readonly { source: PlaybackRange; speech: PlaybackRange }[]
) {
  return words.map(word => {
    const overlaps = ranges.flatMap(range => {
      const start = Math.max(word.source.start, range.source.start);
      const end = Math.min(word.source.end, range.source.end);
      return start < end
        ? [
            {
              start: range.speech.start + start - range.source.start,
              end: range.speech.start + end - range.source.start,
            },
          ]
        : [];
    });
    return {
      start: Math.min(...overlaps.map(range => range.start)),
      end: Math.max(...overlaps.map(range => range.end)),
    };
  });
}

export const CAPTION_TIMING = {
  lookAheadSeconds: 1.3,
  highlightDelaySeconds: 1.3,
  readFadeSeconds: 2,
  readOpacity: 0.55,
};
export const CAPTION_SCROLL = { trigger: 0.5, destination: 0 };
const CAPTION_RHYTHM = {
  radiusSeconds: 0.65,
  commaDelay: 0.055,
  clauseDelay: 0.08,
  sentenceDelay: 0.12,
  maxDelayRatio: 0.2,
};
const CAPTION_CATCH_UP_SECONDS = 0.55;

export function captionPauses(
  words: readonly CaptionWord[],
  ends: readonly number[],
  duration: number
): CaptionPause[] {
  const cues = words.flatMap((word, index) => {
    if (word.code) return [];
    const punctuation = word.text.match(/([,;:.!?…])[”’"')\]]*$/)?.[1];
    if (!punctuation) return [];
    const delay =
      punctuation === ','
        ? CAPTION_RHYTHM.commaDelay
        : ';:'.includes(punctuation)
          ? CAPTION_RHYTHM.clauseDelay
          : CAPTION_RHYTHM.sentenceDelay;
    return [{ time: ends[index] * duration, delay }];
  });
  return cues
    .map((cue, index) => {
      const previous = cues[index - 1]?.time ?? 0;
      const next = cues[index + 1]?.time ?? duration;
      const radius = Math.min(
        CAPTION_RHYTHM.radiusSeconds,
        (cue.time - previous) / 2,
        (next - cue.time) / 2
      );
      return { ...cue, radius, delay: Math.min(cue.delay, radius * CAPTION_RHYTHM.maxDelayRatio) };
    })
    .filter(cue => cue.radius > 0);
}

export function pacedCaptionTime(time: number, cues: readonly CaptionPause[]) {
  const cue = cues.find(cue => Math.abs(time - cue.time) < cue.radius);
  if (!cue) return time;
  return time - (cue.delay * (1 + Math.cos((Math.PI * (time - cue.time)) / cue.radius))) / 2;
}

export function captionLookAhead(
  elapsedSeconds: number,
  playbackRate: number,
  leadSeconds: number
) {
  const fraction = Math.max(
    0,
    Math.min(1, elapsedSeconds / (CAPTION_CATCH_UP_SECONDS * playbackRate))
  );
  const eased = fraction ** 3 * (10 - 15 * fraction + 6 * fraction ** 2);
  return leadSeconds * playbackRate * eased;
}
