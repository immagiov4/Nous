import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { isAnimatedLessonScene, type LessonScene } from './lessonScene';
import { getMarkdownMathRangeAt } from './markdownMathSyntax';
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
  if (isAnimatedLessonScene(scene)) return [];
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

const IMAGE_CHUNK = /^!\[[^\]\r\n]*\]\((?:[^()\r\n]|\([^()\r\n]*\))*\)$/u;
const PDF_IMAGE = /\{\{PDF_IMAGE:[^|{}]+(?:\|alt=[^|{}]*)?(?:\|caption=[^{}]*)?\}\}/gu;
const markdownParser = unified().use(remarkParse).use(remarkGfm);

interface MarkdownAnalysis {
  readonly headings: PlaybackRange[];
  readonly visuals: PlaybackRange[];
  readonly inlineCode: PlaybackRange[];
  readonly omissions: PlaybackRange[];
  readonly inlineVisuals: PlaybackRange[];
}

interface MarkdownNode {
  readonly type: string;
  readonly position: {
    readonly start: { readonly offset: number };
    readonly end: { readonly offset: number };
  };
  readonly children?: readonly MarkdownNode[];
}

const analyzeMarkdown = (markdown: string): MarkdownAnalysis => {
  const analysis: MarkdownAnalysis = {
    headings: [],
    visuals: [],
    inlineCode: [],
    omissions: [],
    inlineVisuals: [],
  };
  const visit = (node: MarkdownNode): void => {
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (node.type === 'code' || node.type === 'table') {
      analysis.visuals.push({ start, end });
      return;
    }
    if (node.type === 'heading') analysis.headings.push({ start, end });
    collectInlineRanges(node, markdown, analysis);
    if (node.children) for (const child of node.children) visit(child);
  };
  visit(markdownParser.parse(markdown) as MarkdownNode);
  collectMathRanges(markdown, analysis);
  analysis.omissions.sort((left, right) => left.start - right.start);
  analysis.inlineVisuals.sort((left, right) => left.start - right.start);
  return analysis;
};

const collectMathRanges = (markdown: string, analysis: MarkdownAnalysis): void => {
  const protectedRanges = [
    ...analysis.visuals,
    ...analysis.inlineCode,
    ...analysis.inlineVisuals,
  ].sort((left, right) => left.start - right.start);
  let protectedIndex = 0;
  let cursor = 0;
  while (cursor < markdown.length) {
    while (protectedRanges[protectedIndex]?.end <= cursor) protectedIndex += 1;
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && protectedRange.start <= cursor) {
      cursor = protectedRange.end;
      continue;
    }
    const mathRange = getMarkdownMathRangeAt(markdown, cursor);
    if (mathRange && (!protectedRange || mathRange.end <= protectedRange.start)) {
      analysis.omissions.push(mathRange);
      analysis.inlineVisuals.push(mathRange);
      cursor = mathRange.end;
    } else {
      cursor += 1;
    }
  }
};

const collectInlineRanges = (
  node: MarkdownNode,
  markdown: string,
  analysis: MarkdownAnalysis
): void => {
  const start = node.position.start.offset;
  const end = node.position.end.offset;
  if (node.type === 'image' || node.type === 'imageReference') {
    analysis.inlineVisuals.push({ start, end });
    analysis.omissions.push({ start, end });
  } else if (node.type === 'inlineCode') {
    const delimiter = /^`+/u.exec(markdown.slice(start, end));
    if (!delimiter) throw new TypeError('Inline code must start with its parsed delimiter.');
    const delimiterLength = delimiter[0].length;
    analysis.inlineCode.push({ start, end });
    analysis.omissions.push(
      { start, end: start + delimiterLength },
      { start: end - delimiterLength, end }
    );
  } else if (
    ['heading', 'emphasis', 'strong', 'delete', 'link', 'linkReference'].includes(node.type)
  ) {
    const first = node.children?.[0];
    const last = node.children?.at(-1);
    if (first && last) {
      analysis.omissions.push(
        { start, end: first.position.start.offset },
        { start: last.position.end.offset, end }
      );
    } else {
      analysis.omissions.push({ start, end });
    }
  } else if (node.type === 'text') {
    const text = markdown.slice(start, end);
    for (const match of text.matchAll(/\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu)) {
      analysis.omissions.push({ start: start + match.index, end: start + match.index + 1 });
    }
    for (const match of text.matchAll(PDF_IMAGE)) {
      const range = { start: start + match.index, end: start + match.index + match[0].length };
      analysis.inlineVisuals.push(range);
      analysis.omissions.push(range);
    }
  }
};

/** Keep source offsets while separating authored prose and container-relative visual blocks. */
const markdownChunks = (markdown: string, analysis: MarkdownAnalysis): MarkdownChunk[] => {
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  let end = 0;
  let structure = 'paragraph';
  let visualIndex = 0;
  let headingIndex = 0;
  let consumedEnd = 0;
  const flush = () => {
    if (end <= start) return;
    const text = markdown.slice(start, end);
    const visual = IMAGE_CHUNK.test(text.trim()) || text.trim().replace(PDF_IMAGE, '') === '';
    chunks.push({ start, end, kind: visual ? 'visual' : 'speech' });
    start = end;
  };

  for (const line of markdown.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/gu)) {
    if (!line[0]) continue;
    const text = line[0].replace(/[\r\n]+$/u, '');
    const lineStart = line.index;
    const lineEnd = lineStart + text.length;
    if (lineStart < consumedEnd) continue;
    const visual = analysis.visuals[visualIndex];
    if (visual && visual.start >= lineStart && visual.start <= lineEnd) {
      flush();
      chunks.push({ start: lineStart, end: visual.end, kind: 'visual' });
      consumedEnd = visual.end;
      visualIndex += 1;
      start = consumedEnd;
      end = consumedEnd;
      continue;
    }
    if (!text.trim()) {
      flush();
      start = lineEnd;
      end = lineEnd;
      structure = 'paragraph';
      continue;
    }
    const heading = analysis.headings[headingIndex];
    if (heading && heading.start >= lineStart && heading.start <= lineEnd) {
      flush();
      chunks.push({ start: lineStart, end: heading.end, kind: 'heading' });
      consumedEnd = heading.end;
      headingIndex += 1;
      start = consumedEnd;
      end = consumedEnd;
      structure = 'paragraph';
      continue;
    }
    const nextStructure = /^[ \t]*>/u.test(text)
      ? 'quote'
      : /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/u.test(text)
        ? 'list'
        : structure;
    if (nextStructure !== structure) flush();
    structure = nextStructure;
    if (end === start) start = lineStart;
    end = lineEnd;
  }
  flush();
  return chunks;
};

interface SpokenText {
  speech: string;
  spans: PlaybackTextSpan[];
  visuals: PlaybackVisual[];
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

/** Project inline syntax ranges while preserving every spoken character's authored offset. */
const appendInline = (
  result: SpokenText,
  markdown: string,
  range: PlaybackRange,
  analysis: MarkdownAnalysis
): void => {
  let cursor = range.start;
  for (const omitted of analysis.omissions) {
    if (omitted.end <= cursor || omitted.start >= range.end) continue;
    appendSource(result, markdown, cursor, Math.max(cursor, omitted.start));
    cursor = Math.min(range.end, omitted.end);
  }
  appendSource(result, markdown, cursor, range.end);
  for (const visual of analysis.inlineVisuals) {
    if (visual.start >= range.start && visual.start < range.end) {
      result.visuals.push({ kind: 'markdown', markdown: markdown.slice(visual.start, visual.end) });
    }
  }
};

const spokenText = (
  markdown: string,
  range: PlaybackRange,
  sourceBlockIndex: number,
  analysis: MarkdownAnalysis
): SpokenText => {
  const result: SpokenText = { speech: '', spans: [], visuals: [], sourceBlockIndex };
  const text = markdown.slice(range.start, range.end);
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/gu)) {
    if (!line[0]) continue;
    const lineStart = range.start + line.index;
    const insideCode = analysis.inlineCode.some(
      code => code.start < lineStart && code.end > lineStart
    );
    const prefix = insideCode
      ? ''
      : (/^(?:[ \t]*>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-+*]|\d+[.)])[ \t]+)?/u.exec(line[0])?.[0] ??
        '');
    const start = range.start + line.index + prefix.length;
    appendInline(
      result,
      markdown,
      { start, end: range.start + line.index + line[0].length },
      analysis
    );
  }
  return result;
};

/** Join independently mapped passages, shifting only their speech offsets. */
const joinSpokenText = (
  parts: readonly SpokenText[]
): Pick<SpokenText, 'speech' | 'spans' | 'visuals'> => {
  const result: Pick<SpokenText, 'speech' | 'spans' | 'visuals'> = {
    speech: '',
    spans: [],
    visuals: [],
  };
  for (const part of parts) {
    const offset = result.speech.length;
    result.speech += part.speech;
    result.visuals.push(...part.visuals);
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
    const analysis = analyzeMarkdown(markdown);
    for (const chunk of markdownChunks(markdown, analysis)) {
      if (chunk.kind === 'visual') {
        attachVisual({ kind: 'markdown', markdown: markdown.slice(chunk.start, chunk.end) });
        continue;
      }
      const text = spokenText(markdown, chunk, sourceBlockIndex, analysis);
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
      if (!text.speech.trim()) {
        for (const visual of text.visuals) attachVisual(visual);
        continue;
      }
      const spoken = joinSpokenText([...pendingHeadings, text]);
      blocks.push({
        id: `${blocks.length}`,
        heading,
        speech: spoken.speech,
        spans: spoken.spans,
        visuals: [...pendingVisuals, ...spoken.visuals],
        audio: [],
      });
      pendingHeadings = [];
      pendingVisuals = [];
    }
  }
  return blocks;
};
