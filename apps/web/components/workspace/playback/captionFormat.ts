import { renderSpotlightSymbol } from '@shared/formulaSpotlight';
import type {
  LessonPlaybackBlock,
  PlaybackContentBlock,
  PlaybackRange,
} from '@shared/lessonPlayback';
import { getAllowedRawHtmlTagRanges } from '../../../utils/markdown/html.ts';

const CAPTION_HIDDEN_TAG_CHARACTER = '\0';

export interface CaptionWord {
  text: string;
  mathHtml?: string;
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

function captionSourceLines(block: LessonPlaybackBlock, sources: readonly PlaybackContentBlock[]) {
  const lines = new Map<
    string,
    { text: string; start: number; sourceBlockIndex: number; fencedSpeech?: PlaybackRange }
  >();
  for (const span of block.spans) {
    if (span.source.start === span.source.end) continue;
    if (span.fencedCode) {
      if (span.speech.start !== span.speech.end)
        lines.set(`fence:${span.sourceBlockIndex}:${span.source.start}`, {
          text: block.speech.slice(span.speech.start, span.speech.end),
          start: span.source.start,
          sourceBlockIndex: span.sourceBlockIndex,
          fencedSpeech: span.speech,
        });
      continue;
    }
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
  return lines;
}

/** Recover the authored lines covered by the canonical speech/source mapping. */
export function captionSource(
  block: LessonPlaybackBlock,
  sources: readonly PlaybackContentBlock[]
) {
  const lines = captionSourceLines(block, sources);
  let markdown = '';
  const ranges: { source: PlaybackRange; speech: PlaybackRange }[] = [];
  for (const line of lines.values()) {
    if (line.fencedSpeech) {
      ranges.push({
        source: { start: markdown.length, end: markdown.length + line.text.length },
        speech: line.fencedSpeech,
      });
      markdown += `${line.text}\n`;
      continue;
    }
    let cursor = line.start;
    const lineSpans = block.spans.filter(
      span =>
        !span.fencedCode &&
        span.sourceBlockIndex === line.sourceBlockIndex &&
        span.speech.start !== span.speech.end
    );
    for (const span of lineSpans) {
      const start = Math.max(line.start, span.source.start);
      const end = Math.min(line.start + line.text.length, span.source.end);
      if (start >= end) continue;
      markdown += line.text.slice(cursor - line.start, start - line.start);
      const speech = span.math
        ? span.speech
        : {
            start: span.speech.start + start - span.source.start,
            end: span.speech.start + end - span.source.start,
          };
      const text = span.math
        ? block.speech.slice(speech.start, speech.end)
        : line.text.slice(start - line.start, end - line.start);
      ranges.push({
        source: { start: markdown.length, end: markdown.length + text.length },
        speech,
      });
      markdown += text;
      cursor = end;
    }
    markdown += `${line.text.slice(cursor - line.start)}\n`;
  }
  return { markdown, ranges };
}

interface CaptionStyle {
  bold: boolean;
  codeDelimiter: string;
}

function consumeCaptionDelimiter(part: string, state: CaptionStyle) {
  if (part === '**' && !state.codeDelimiter) {
    state.bold = !state.bold;
    return true;
  }
  if (part.startsWith('`') && (!state.codeDelimiter || part === state.codeDelimiter)) {
    state.codeDelimiter = state.codeDelimiter ? '' : part;
    return true;
  }
  return false;
}

function captionCodeMath(code: string): string | undefined {
  if (!/^\s*\\[A-Za-z]+/u.test(code)) return undefined;
  try {
    return renderSpotlightSymbol(code);
  } catch {
    // Invalid notation remains literal authored code.
    return undefined;
  }
}

function appendCaptionLine({
  line,
  lineStart,
  words,
  state,
  visibleText,
  visibleOffsets,
  hasRanges,
}: {
  line: string;
  lineStart: number;
  words: CaptionWord[];
  state: CaptionStyle;
  visibleText: (start: number, end: number) => string;
  visibleOffsets: (start: number, end: number) => number[];
  hasRanges: boolean;
}) {
  const list = /^\s*([-*+]|\d+\.)\s+/.exec(line);
  let marker = '';
  if (list) marker = /\d/.test(list[1]) ? list[1] : '•';
  const text = list ? line.slice(list[0].length) : line;
  let partStart = lineStart + (list?.[0].length ?? 0);
  let first = true;
  for (const part of text.split(/(\*\*|`+)/)) {
    const delimiter = !hasRanges || !visibleText(partStart, partStart + part.length);
    if (delimiter && consumeCaptionDelimiter(part, state)) {
      partStart += part.length;
      continue;
    }
    const offsets = visibleOffsets(partStart, partStart + part.length);
    const projected = visibleText(partStart, partStart + part.length);
    const mathHtml = state.codeDelimiter && captionCodeMath(projected);
    const tokens = mathHtml ? /\S(?:.*\S)?/g : /\S+/g;
    for (const match of projected.matchAll(tokens)) {
      const start = offsets[match.index];
      const end = offsets[match.index + match[0].length - 1] + 1;
      const text = match[0];
      words.push({
        text,
        ...(mathHtml && { mathHtml }),
        bold: state.bold,
        code: Boolean(state.codeDelimiter),
        list: !!list,
        breakBefore: first && !!list,
        marker,
        source: {
          start,
          end,
        },
      });
      first = false;
    }
    partStart += part.length;
  }
}

/** Laboratory formatting, retaining source positions for the API's quotation anchors. */
export function captionFormat(original: string, ranges?: readonly { source: PlaybackRange }[]) {
  // Canonical spans exclude Markdown syntax; retain the authored offsets and styling.
  const visibleText = (start: number, end: number) => {
    if (!ranges) return original.slice(start, end);
    return ranges
      .flatMap(({ source }) => {
        const from = Math.max(start, source.start);
        const to = Math.min(end, source.end);
        return from < to ? [original.slice(from, to)] : [];
      })
      .join('');
  };
  const visibleOffsets = (start: number, end: number) => {
    const sources = ranges?.map(range => range.source) ?? [{ start, end }];
    return sources.flatMap(source => {
      const from = Math.max(start, source.start);
      const to = Math.min(end, source.end);
      return Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index);
    });
  };
  // A non-whitespace mask preserves offsets without creating list or heading markers.
  let source = original;
  for (const tag of getAllowedRawHtmlTagRanges(original)) {
    if (visibleText(tag.start, tag.end)) continue;
    source =
      source.slice(0, tag.start) +
      CAPTION_HIDDEN_TAG_CHARACTER.repeat(tag.end - tag.start) +
      source.slice(tag.end);
  }
  // Non-whitespace starts the content, or one trailing space is the entire content.
  // This keeps whitespace-only headings without overlapping unbounded repetitions.
  const headingPattern = /^#{1,6}\s+(\S.*|(?=.)\s)$/gm;
  const headings = Array.from(source.matchAll(headingPattern), match =>
    visibleText(match.index + match[0].length - match[1].length, match.index + match[0].length)
  );
  const headingWords = headings.join(' ').trim().split(/\s+/).filter(Boolean).length;
  const body = source.replaceAll(headingPattern, match => ' '.repeat(match.length));
  const lines = body.trim().split('\n');
  let lineStart = body.length - body.trimStart().length;
  const words: CaptionWord[] = [];
  const state: CaptionStyle = { bold: false, codeDelimiter: '' };
  for (const line of lines) {
    appendCaptionLine({
      line,
      lineStart,
      words,
      state,
      visibleText,
      visibleOffsets,
      hasRanges: Boolean(ranges),
    });
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
    const punctuation = /([,;:.!?…])[”’"')\]]*$/.exec(word.text)?.[1];
    if (!punctuation) return [];
    let delay = CAPTION_RHYTHM.sentenceDelay;
    if (punctuation === ',') delay = CAPTION_RHYTHM.commaDelay;
    else if (';:'.includes(punctuation)) delay = CAPTION_RHYTHM.clauseDelay;
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
