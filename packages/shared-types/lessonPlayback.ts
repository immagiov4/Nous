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
  if (scene.type === 'composition') {
    return (scene.panels as NonNullable<LessonScene['panels']>).map((panel, index) => ({
      id: `panel:${index}`,
      label: [
        panel.title,
        ...panel.items.map(item => [item.label, item.detail].filter(Boolean).join(' · ')),
      ].join(' · '),
    }));
  }
  if (scene.type === 'heatmap' || scene.type === 'security') {
    return (scene.rows as NonNullable<LessonScene['rows']>).map((row, index) => ({
      id: `row:${index}`,
      label: row.label,
    }));
  }
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
  readonly kind: 'heading' | 'speech' | 'visual' | 'omitted';
}

const IMAGE_CHUNK = /^!\[[^\]\r\n]*\]\((?:[^()\r\n]|\([^()\r\n]*\))*\)$/u;
const PDF_IMAGE = /\{\{PDF_IMAGE:[^|{}]+(?:\|alt=[^|{}]*)?(?:\|caption=[^{}]*)?\}\}/gu;
const markdownParser = unified().use(remarkParse).use(remarkGfm);

interface MarkdownAnalysis {
  readonly headings: PlaybackRange[];
  readonly blocks: MarkdownChunk[];
  readonly inlineCode: PlaybackRange[];
  readonly omissions: PlaybackRange[];
  readonly annotationTags: PlaybackRange[];
  readonly inlineVisuals: PlaybackRange[];
  readonly math: PlaybackRange[];
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
    blocks: [],
    inlineCode: [],
    omissions: [],
    annotationTags: [],
    inlineVisuals: [],
    math: [],
  };
  const visit = (node: MarkdownNode): void => {
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (['code', 'table', 'definition', 'thematicBreak'].includes(node.type)) {
      analysis.blocks.push({
        start,
        end,
        kind: node.type === 'code' || node.type === 'table' ? 'visual' : 'omitted',
      });
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
    ...analysis.blocks,
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
      analysis.math.push(mathRange);
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
  } else if (node.type === 'html') {
    collectAnnotationRanges(node, markdown, analysis);
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
    collectTextRanges(node, markdown, analysis);
  }
};

/** Collect escaped punctuation and visual placeholders only from parsed prose. */
const collectTextRanges = (
  node: MarkdownNode,
  markdown: string,
  analysis: MarkdownAnalysis
): void => {
  const start = node.position.start.offset;
  const end = node.position.end.offset;
  const text = markdown.slice(start, end);
  for (const match of text.matchAll(/\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu)) {
    analysis.omissions.push({ start: start + match.index, end: start + match.index + 1 });
  }
  for (const match of text.matchAll(PDF_IMAGE)) {
    const range = { start: start + match.index, end: start + match.index + match[0].length };
    analysis.inlineVisuals.push(range);
    analysis.omissions.push(range);
  }
};

/** Find a tag boundary without treating quoted angle brackets as delimiters. */
const htmlTagEnd = (html: string, start: number): number => {
  let quote: string | undefined;
  for (let cursor = start; cursor < html.length; cursor += 1) {
    const character = html[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return cursor + 1;
    } else if (character === '<') {
      return -1;
    }
  }
  return -1;
};

/** HTML nodes can contain a complete multiline wrapper; ignore comments and quoted tag syntax. */
const collectAnnotationRanges = (
  node: MarkdownNode,
  markdown: string,
  analysis: MarkdownAnalysis
): void => {
  const sourceStart = node.position.start.offset;
  const html = markdown.slice(sourceStart, node.position.end.offset);
  // Comments, declarations, CDATA and processing instructions contain no annotation elements.
  if (html.startsWith('<!') || html.startsWith('<?')) return;
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start === -1) break;
    if (html.startsWith('<!--', start)) {
      const close = html.indexOf('-->', start + '<!--'.length);
      cursor = close === -1 ? html.length : close + '-->'.length;
      continue;
    }
    const tag = /^<\/?([a-z][a-z0-9-]*)(?=[\s>])/iu.exec(html.slice(start));
    const end = tag ? htmlTagEnd(html, start + tag[0].length) : -1;
    cursor = end === -1 ? start + 1 : end;
    if (end === -1 || tag?.[1].toLowerCase() !== 'mark') continue;
    const range = { start: sourceStart + start, end: sourceStart + end };
    analysis.annotationTags.push(range);
    analysis.omissions.push(range);
  }
};

/** Preserve both content and line-ending offsets, including bare CR and blank lines. */
function* markdownLines(markdown: string) {
  let start = 0;
  for (const newline of markdown.matchAll(/\r\n|[\r\n]/gu)) {
    const end = newline.index + newline[0].length;
    yield { start, end, contentEnd: newline.index };
    start = end;
  }
  if (start < markdown.length) yield { start, end: markdown.length, contentEnd: markdown.length };
}

const lineStructure = (text: string, current: string): string => {
  if (/^[ \t]*>/u.test(text)) return 'quote';
  if (/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/u.test(text)) return 'list';
  return current;
};

/** Keep source offsets while separating authored prose and container-relative visual blocks. */
const markdownChunks = (markdown: string, analysis: MarkdownAnalysis): MarkdownChunk[] => {
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  let end = 0;
  let structure = 'paragraph';
  let blockIndex = 0;
  let headingIndex = 0;
  let consumedEnd = 0;
  const flush = () => {
    if (end <= start) return;
    const text = markdown.slice(start, end);
    const visual = IMAGE_CHUNK.test(text.trim()) || text.trim().replace(PDF_IMAGE, '') === '';
    chunks.push({ start, end, kind: visual ? 'visual' : 'speech' });
    start = end;
  };
  const appendParagraphLine = (text: string, lineStart: number, lineEnd: number) => {
    const nextStructure = lineStructure(text, structure);
    if (nextStructure !== structure) flush();
    structure = nextStructure;
    if (end === start) start = lineStart;
    end = lineEnd;
  };

  for (const line of markdownLines(markdown)) {
    const text = markdown.slice(line.start, line.contentEnd);
    const lineStart = line.start;
    const lineEnd = line.contentEnd;
    if (lineStart < consumedEnd) continue;
    const block = analysis.blocks[blockIndex];
    if (block && block.start >= lineStart && block.start <= lineEnd) {
      flush();
      chunks.push({ start: lineStart, end: block.end, kind: block.kind });
      consumedEnd = block.end;
      blockIndex += 1;
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
    appendParagraphLine(text, lineStart, lineEnd);
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

const speechPrefixLength = (line: string): number => {
  const indentation = /^[ \t>]*/u.exec(line)?.[0].length ?? 0;
  const marker = /^(?:#{1,6}|[-+*]|\d+[.)])[ \t]+/u.exec(line.slice(indentation));
  return indentation + (marker?.[0].length ?? 0);
};

/** Remove parsed annotation wrappers without changing the authored content around them. */
const annotationFreeMarkdown = (
  markdown: string,
  range: PlaybackRange,
  tags: readonly PlaybackRange[]
): string => {
  let text = markdown.slice(range.start, range.end);
  const contained = tags
    .filter(tag => tag.start >= range.start && tag.end <= range.end)
    .sort((left, right) => right.start - left.start);
  for (const tag of contained) {
    text = text.slice(0, tag.start - range.start) + text.slice(tag.end - range.start);
  }
  return text;
};

const spokenText = (
  markdown: string,
  range: PlaybackRange,
  sourceBlockIndex: number,
  analysis: MarkdownAnalysis
): SpokenText => {
  const result: SpokenText = { speech: '', spans: [], visuals: [], sourceBlockIndex };
  const text = markdown.slice(range.start, range.end);
  for (const line of markdownLines(text)) {
    const lineStart = range.start + line.start;
    const insideCode = analysis.inlineCode.some(
      code => code.start < lineStart && code.end > lineStart
    );
    const prefixLength = insideCode ? 0 : speechPrefixLength(text.slice(line.start, line.end));
    const start = lineStart + prefixLength;
    appendInline(result, markdown, { start, end: range.start + line.end }, analysis);
  }
  // Inline symbols need their authored explanation, rather than isolated timed cards.
  if (
    result.speech.trim() &&
    analysis.math.some(math => math.start >= range.start && math.end <= range.end)
  ) {
    result.visuals = [
      {
        kind: 'markdown',
        markdown: annotationFreeMarkdown(markdown, range, analysis.annotationTags),
      },
    ];
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

const appendHeadingSeparator = (text: SpokenText, markdown: string, end: number): void => {
  const newline = /^(?:\r\n|[\r\n])/u.exec(markdown.slice(end))?.[0];
  if (newline) {
    appendSource(text, markdown, end, end + newline.length);
    return;
  }
  // A heading-only content block has no authored separator before the next block.
  text.spans.push({
    speech: { start: text.speech.length, end: text.speech.length + 1 },
    source: { start: end, end },
    sourceBlockIndex: text.sourceBlockIndex,
  });
  text.speech += '\n';
};

/** Build speech and annotation-free content identity from the same parsed Markdown analysis. */
export const projectLessonPlayback = (contentBlocks: readonly PlaybackContentBlock[]) => {
  const projectedContent = [...contentBlocks];
  let hasAnnotations = false;
  const blocks: (Omit<LessonPlaybackBlock, 'visuals'> & { visuals: PlaybackVisual[] })[] = [];
  let heading = '';
  let pendingHeadings: SpokenText[] = [];
  let pendingVisuals: PlaybackVisual[] = [];
  const attachVisual = (visual: PlaybackVisual) => {
    const previous = blocks.at(-1);
    if (previous) previous.visuals.push(visual);
    else pendingVisuals.push(visual);
  };

  const appendMarkdown = (markdown: string, sourceBlockIndex: number): void => {
    const analysis = analyzeMarkdown(markdown);
    if (analysis.annotationTags.length) {
      hasAnnotations = true;
      const projectedMarkdown = annotationFreeMarkdown(
        markdown,
        { start: 0, end: markdown.length },
        analysis.annotationTags
      );
      projectedContent[sourceBlockIndex] = { type: 'markdown', markdown: projectedMarkdown };
    }
    for (const chunk of markdownChunks(markdown, analysis)) {
      if (chunk.kind === 'omitted') continue;
      if (chunk.kind === 'visual') {
        attachVisual({ kind: 'markdown', markdown: markdown.slice(chunk.start, chunk.end) });
        continue;
      }
      const text = spokenText(markdown, chunk, sourceBlockIndex, analysis);
      if (chunk.kind === 'heading') {
        heading = text.speech;
        appendHeadingSeparator(text, markdown, chunk.end);
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
  };

  for (const [sourceBlockIndex, content] of contentBlocks.entries()) {
    if (content.type === 'generated-visual') {
      if (content.visualId) attachVisual({ kind: 'generated-visual', visualId: content.visualId });
      continue;
    }
    if (content.type === 'markdown') appendMarkdown(content.markdown, sourceBlockIndex);
  }
  return { blocks, contentBlocks: projectedContent, hasAnnotations };
};

/** Deterministically segment authored lesson text and attach visuals to its spoken introductions. */
export const segmentLessonPlayback = (
  contentBlocks: readonly PlaybackContentBlock[]
): LessonPlaybackBlock[] => projectLessonPlayback(contentBlocks).blocks;
