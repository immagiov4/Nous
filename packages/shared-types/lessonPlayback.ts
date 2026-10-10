import type { LessonScene } from './lessonScene';
import type { ProjectAssetRef } from './projectAsset';

/** UTF-16 offsets, end exclusive. */
export interface PlaybackRange {
  readonly start: number;
  readonly end: number;
}

/** Maps spoken text to the original markdown of its source content block. */
export interface PlaybackTextSpan {
  readonly speech: PlaybackRange;
  readonly sourceBlockIndex: number;
  /** Empty at the source boundary for an inserted separator between content blocks. */
  readonly source: PlaybackRange;
}

export type PlaybackVisual =
  | { readonly kind: 'markdown'; readonly markdown: string }
  | { readonly kind: 'generated-visual'; readonly visualId: string }
  | { readonly kind: 'scene'; readonly scene: LessonScene };

export interface PlaybackMotionEvent {
  readonly effect: 'focus' | 'reveal';
  readonly targets: readonly string[];
  readonly quote: string;
}

/** Stable scene element IDs shared by preparation and the playback renderer. */
export const motionTargets = (scene: LessonScene): { id: string; label: string }[] => {
  if (scene.type === 'matrix') {
    return (scene.criteria ?? scene.groups[0]?.items ?? []).map((label, index) => ({
      id: `row:${index}`,
      label,
    }));
  }
  if (scene.diagram) {
    return [
      ...scene.diagram.nodes.map(node => ({ id: `node:${node.id}`, label: node.label })),
      ...scene.diagram.edges.map((edge, index) => ({
        id: `edge:${index}`,
        label: edge.label || `${edge.from} → ${edge.to}`,
      })),
    ];
  }
  return scene.groups.length
    ? scene.groups.map((group, index) => ({
        id: `group:${index}`,
        label: [group.label, ...group.items].join(' · '),
      }))
    : scene.items.map((item, index) => ({
        id: `item:${index}`,
        label: [item.label, item.detail].filter(Boolean).join(' · '),
      }));
};

export interface PlaybackAudio {
  readonly model: string;
  readonly voice: string;
  readonly asset: ProjectAssetRef;
  readonly durationSeconds: number;
}

export interface LessonPlaybackBlock {
  /** `${index}`, stable for one lesson version. */
  readonly id: string;
  /** Latest heading text, empty before the first heading. */
  readonly heading: string;
  readonly speech: string;
  readonly spans: readonly PlaybackTextSpan[];
  readonly visuals: readonly PlaybackVisual[];
  readonly prepared?: {
    readonly scene?: LessonScene;
    readonly motion: readonly PlaybackMotionEvent[];
  };
  readonly audio: readonly PlaybackAudio[];
}

export interface LessonPlayback {
  readonly version: 1;
  readonly lessonKey: string;
  readonly blocks: readonly LessonPlaybackBlock[];
}

export type PlaybackContentBlock =
  | { readonly type: 'markdown'; readonly markdown: string }
  | { readonly type: 'generated-visual'; readonly visualId?: string }
  | { readonly type: 'inline-quiz' | 'youtube-clips' };

interface MarkdownChunk extends PlaybackRange {
  readonly kind: 'heading' | 'speech' | 'visual';
}

const HEADING_PREFIX = /^[ \t]*#{1,6}[ \t]+/u;
const FENCE_PREFIX = /^ {0,3}(`{3,}|~{3,})/u;
const IMAGE_CHUNK = /^!\[[^\]\r\n]*\]\((?:[^()\r\n]|\([^()\r\n]*\))*\)$/u;

/** Split at blank lines and heading/fence boundaries without normalizing source offsets. */
const markdownChunks = (markdown: string): MarkdownChunk[] => {
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  let end = 0;
  let fence = '';
  const flush = (fenced = false) => {
    if (end <= start) return;
    const text = markdown.slice(start, end);
    const visual =
      fenced ||
      text.split(/\r\n|[\r\n]/u).every(line => line.trimStart().startsWith('|')) ||
      IMAGE_CHUNK.test(text.trim());
    chunks.push({ start, end, kind: visual ? 'visual' : 'speech' });
    start = end;
  };

  for (const line of markdown.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/gu)) {
    if (!line[0]) continue;
    const text = line[0].replace(/[\r\n]+$/u, '');
    const lineStart = line.index;
    const lineEnd = lineStart + text.length;
    const marker = FENCE_PREFIX.exec(text)?.[1];
    if (fence) {
      end = lineEnd;
      if (marker?.[0] === fence[0] && marker.length >= fence.length && text.trim() === marker) {
        flush(true);
        fence = '';
      }
      continue;
    }
    if (marker) {
      flush();
      start = lineStart;
      end = lineEnd;
      fence = marker;
      continue;
    }
    if (!text.trim()) {
      flush();
      start = lineEnd;
      end = lineEnd;
      continue;
    }
    if (HEADING_PREFIX.test(text)) {
      flush();
      chunks.push({ start: lineStart, end: lineEnd, kind: 'heading' });
      start = lineEnd;
      end = lineEnd;
      continue;
    }
    if (end === start) start = lineStart;
    end = lineEnd;
  }
  flush(Boolean(fence));
  return chunks;
};

interface SpokenText {
  speech: string;
  spans: PlaybackTextSpan[];
  readonly sourceBlockIndex: number;
}

const appendSource = (result: SpokenText, markdown: string, start: number, end: number): void => {
  if (start === end) return;
  const speechStart = result.speech.length;
  result.speech += markdown.slice(start, end);
  const previous = result.spans.at(-1);
  if (previous?.source.end === start && previous.sourceBlockIndex === result.sourceBlockIndex) {
    result.spans[result.spans.length - 1] = {
      speech: { start: previous.speech.start, end: result.speech.length },
      source: { start: previous.source.start, end },
      sourceBlockIndex: result.sourceBlockIndex,
    };
  } else {
    result.spans.push({
      speech: { start: speechStart, end: result.speech.length },
      source: { start, end },
      sourceBlockIndex: result.sourceBlockIndex,
    });
  }
};

// Inline code is consumed first so its literal punctuation is never treated as emphasis.
const INLINE_MARKUP =
  /(`+)([\s\S]*?)\1(?!`)|\[([^\]\r\n]+)\]\((?:[^()\r\n]|\([^()\r\n]*\))*\)|(\*{1,3})(?=\S)([\s\S]*?\S)\4|(?<![\p{L}\p{N}_])(_{1,3})(?=\S)([\s\S]*?\S)\6(?![\p{L}\p{N}_])/gu;

const appendInline = (result: SpokenText, markdown: string, range: PlaybackRange): void => {
  const text = markdown.slice(range.start, range.end);
  let cursor = range.start;
  for (const match of text.matchAll(INLINE_MARKUP)) {
    const start = range.start + match.index;
    appendSource(result, markdown, cursor, start);
    const delimiter = match[1] ?? match[4] ?? match[6] ?? '[';
    const content = match[2] ?? match[3] ?? match[5] ?? match[7] ?? '';
    const inner = {
      start: start + delimiter.length,
      end: start + delimiter.length + content.length,
    };
    if (match[1]) appendSource(result, markdown, inner.start, inner.end);
    else appendInline(result, markdown, inner);
    cursor = start + match[0].length;
  }
  appendSource(result, markdown, cursor, range.end);
};

const spokenText = (
  markdown: string,
  range: PlaybackRange,
  sourceBlockIndex: number
): SpokenText => {
  const result: SpokenText = { speech: '', spans: [], sourceBlockIndex };
  const text = markdown.slice(range.start, range.end);
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/gu)) {
    if (!line[0]) continue;
    const prefix =
      /^(?:[ \t]*>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-+*]|\d+[.)])[ \t]+)?/u.exec(line[0])?.[0] ??
      '';
    const start = range.start + line.index + prefix.length;
    appendInline(result, markdown, { start, end: range.start + line.index + line[0].length });
  }
  return result;
};

/** Join independently mapped passages, shifting only their speech offsets. */
const joinSpokenText = (parts: readonly SpokenText[]): Pick<SpokenText, 'speech' | 'spans'> => {
  const result: Pick<SpokenText, 'speech' | 'spans'> = { speech: '', spans: [] };
  for (const part of parts) {
    const offset = result.speech.length;
    result.speech += part.speech;
    result.spans.push(
      ...part.spans.map(span => ({
        ...span,
        speech: { start: span.speech.start + offset, end: span.speech.end + offset },
      }))
    );
  }
  return result;
};

/** Deterministically segment authored lesson text and attach visuals to its spoken introductions. */
export const segmentLessonPlayback = (
  contentBlocks: readonly PlaybackContentBlock[]
): LessonPlaybackBlock[] => {
  const blocks: (Omit<LessonPlaybackBlock, 'visuals'> & { visuals: PlaybackVisual[] })[] = [];
  let heading = '';
  let pendingHeadings: SpokenText[] = [];
  let pendingVisuals: PlaybackVisual[] = [];
  const attachVisual = (visual: PlaybackVisual) => {
    const previous = blocks.at(-1);
    if (previous) previous.visuals.push(visual);
    else pendingVisuals.push(visual);
  };

  for (const [sourceBlockIndex, content] of contentBlocks.entries()) {
    if (content.type === 'generated-visual') {
      if (content.visualId) attachVisual({ kind: 'generated-visual', visualId: content.visualId });
      continue;
    }
    if (content.type !== 'markdown') continue;
    const { markdown } = content;
    for (const chunk of markdownChunks(markdown)) {
      if (chunk.kind === 'visual') {
        attachVisual({ kind: 'markdown', markdown: markdown.slice(chunk.start, chunk.end) });
        continue;
      }
      const text = spokenText(markdown, chunk, sourceBlockIndex);
      if (chunk.kind === 'heading') {
        heading = text.speech;
        const newline = /^(?:\r\n|[\r\n])/u.exec(markdown.slice(chunk.end))?.[0];
        if (newline) appendSource(text, markdown, chunk.end, chunk.end + newline.length);
        else {
          // A heading-only content block has no authored separator before the next block.
          text.spans.push({
            speech: { start: text.speech.length, end: text.speech.length + 1 },
            source: { start: chunk.end, end: chunk.end },
            sourceBlockIndex,
          });
          text.speech += '\n';
        }
        pendingHeadings.push(text);
        continue;
      }
      if (!text.speech) continue;
      const spoken = joinSpokenText([...pendingHeadings, text]);
      blocks.push({
        id: `${blocks.length}`,
        heading,
        speech: spoken.speech,
        spans: spoken.spans,
        visuals: pendingVisuals,
        audio: [],
      });
      pendingHeadings = [];
      pendingVisuals = [];
    }
  }
  return blocks;
};
