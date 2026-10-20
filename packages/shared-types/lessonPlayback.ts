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
  /** Formula omitted from the source projection until the model supplies its pronunciation. */
  readonly math?: string;
  /** Ambiguous fenced source awaiting the model's prose/code decision. */
  readonly fencedCode?: { readonly visualIndex: number; readonly markdown: string };
  readonly sourceBlockIndex: number;
  /** Empty at the source boundary for an inserted separator between content blocks. */
  readonly source: PlaybackRange;
}

export type PlaybackVisual =
  | { readonly kind: 'markdown'; readonly markdown: string }
  | { readonly kind: 'mermaid'; readonly code: string }
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
    readonly spokenMath?: readonly PlaybackSpokenMath[];
    readonly fencedCode?: readonly PlaybackFencedCodeDecision[];
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
  readonly visual?: PlaybackVisual;
  readonly fencedProseCandidate?: { readonly markdown: string; readonly source: PlaybackRange };
}

const IMAGE_CHUNK = /^!\[[^\]\r\n]*\]\((?:[^()\r\n]|\([^()\r\n]*\))*\)$/u;
const PDF_IMAGE = /\{\{PDF_IMAGE:[^|{}]+(?:\|alt=[^|{}]*)?(?:\|caption=[^{}]*)?\}\}/gu;
const VISUAL_EXAMPLE = /\{\{VISUAL_EXAMPLE:([^|{}]+)(?:\|title=[^{}]*)?\}\}/gu;
const markdownParser = unified().use(remarkParse).use(remarkGfm);

interface MarkdownAnalysis {
  readonly headings: PlaybackRange[];
  readonly blocks: MarkdownChunk[];
  readonly inlineCode: PlaybackRange[];
  readonly text: PlaybackRange[];
  readonly omissions: PlaybackRange[];
  readonly annotationTags: PlaybackRange[];
  readonly inlineVisuals: (PlaybackRange & { readonly visual?: PlaybackVisual })[];
  readonly math: PlaybackRange[];
}

interface MarkdownNode {
  readonly type: string;
  readonly lang?: string | null;
  readonly value?: string;
  readonly position: {
    readonly start: { readonly offset: number };
    readonly end: { readonly offset: number };
  };
  readonly children?: readonly MarkdownNode[];
}

/** Include table-cell prose while keeping code and link destinations out of visual references. */
const collectParsedTextRanges = (node: MarkdownNode, analysis: MarkdownAnalysis): void => {
  if (node.type === 'text')
    analysis.text.push({ start: node.position.start.offset, end: node.position.end.offset });
  if (node.children) for (const child of node.children) collectParsedTextRanges(child, analysis);
};

/** Parser-recognized fence bodies retain source offsets, including unclosed fences. */
const ambiguousFence = (node: MarkdownNode, markdown: string) => {
  if (
    node.type !== 'code' ||
    (node.lang && !['text', 'plaintext'].includes(node.lang.toLowerCase()))
  )
    return undefined;
  const start = node.position.start.offset;
  const end = node.position.end.offset;
  const source = markdown.slice(start, end);
  const opening = /^(`{3,}|~{3,})[^\r\n]*(?:\r\n|[\r\n])/u.exec(source);
  if (!opening || !node.value?.trim()) return undefined;
  const lastLine = /(?:\r\n|[\r\n])[^\r\n]*$/u.exec(source);
  const closing = lastLine?.[0].match(/^[\r\n \t>]*(`+|~+)[ \t]*$/u);
  const closed =
    lastLine && closing?.[1][0] === opening[1][0] && closing[1].length >= opening[1].length;
  return {
    markdown: node.value,
    source: { start: start + opening[0].length, end: closed ? start + lastLine.index : end },
  };
};

/** Return only ambiguous fences, never indented or language-declared code. */
export const getAmbiguousFencedBlocks = (
  markdown: string
): { source: string; markdown: string }[] => {
  const result: { source: string; markdown: string }[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'code') {
      const fence = ambiguousFence(node, markdown);
      if (fence)
        result.push({
          source: markdown.slice(node.position.start.offset, node.position.end.offset),
          markdown: fence.markdown,
        });
      return;
    }
    if (node.children) for (const child of node.children) visit(child);
  };
  visit(markdownParser.parse(markdown) as MarkdownNode);
  return result;
};

const analyzeMarkdown = (markdown: string): MarkdownAnalysis => {
  const analysis: MarkdownAnalysis = {
    headings: [],
    blocks: [],
    inlineCode: [],
    text: [],
    omissions: [],
    annotationTags: [],
    inlineVisuals: [],
    math: [],
  };
  const visit = (node: MarkdownNode): void => {
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (
      node.type === 'html' &&
      /^<(?:figure|picture|figcaption|script|style)(?=[\s>])/iu.test(markdown.slice(start, end))
    ) {
      analysis.blocks.push({ start, end, kind: 'omitted' });
      return;
    }
    if (['code', 'table', 'definition', 'thematicBreak'].includes(node.type)) {
      analysis.blocks.push({
        start,
        end,
        kind: node.type === 'code' || node.type === 'table' ? 'visual' : 'omitted',
        ...(node.type === 'code' && node.lang?.toLowerCase() === 'mermaid'
          ? { visual: { kind: 'mermaid' as const, code: node.value ?? '' } }
          : {}),
        fencedProseCandidate: ambiguousFence(node, markdown),
      });
      return;
    }
    if (node.type === 'heading') analysis.headings.push({ start, end });
    collectInlineRanges(node, markdown, analysis);
    if (node.children) for (const child of node.children) visit(child);
  };
  const parsed = markdownParser.parse(markdown) as MarkdownNode;
  collectParsedTextRanges(parsed, analysis);
  visit(parsed);
  if (analysis.annotationTags.length) {
    // Mask supported wrappers without changing UTF-16 source offsets before parsing their prose.
    const unwrapped = analysis.annotationTags.reduce(
      (source, tag) =>
        source.slice(0, tag.start) +
        source
          .slice(tag.start, tag.end)
          .replaceAll(/[^\r\n]/gu, character => ' '.repeat(character.length)) +
        source.slice(tag.end),
      markdown
    );
    collectParsedTextRanges(markdownParser.parse(unwrapped) as MarkdownNode, analysis);
  }
  collectVisualReferences(markdown, analysis);
  collectMathRanges(markdown, analysis);
  analysis.omissions.sort((left, right) => left.start - right.start);
  analysis.inlineVisuals.sort((left, right) => left.start - right.start);
  return {
    ...analysis,
    blocks: analysis.blocks.filter(
      block => !analysis.math.some(math => math.start <= block.start && math.end >= block.end)
    ),
    // A heading boundary inside a visual belongs to that visual's syntax.
    headings: analysis.headings.filter(
      heading =>
        !analysis.inlineVisuals.some(
          visual =>
            (visual.start < heading.start && visual.end > heading.start) ||
            (visual.start < heading.end && visual.end > heading.end)
        )
    ),
  };
};

const collectMathRanges = (markdown: string, analysis: MarkdownAnalysis): void => {
  const blockRanges = new Set<PlaybackRange>(analysis.blocks);
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
    // A formula can contain complete parser blocks, but cannot close inside protected syntax.
    const overlapsProtectedSyntax =
      mathRange &&
      protectedRanges
        .slice(protectedIndex)
        .some(
          range =>
            range.start < mathRange.end && (!blockRanges.has(range) || range.end > mathRange.end)
        );
    if (mathRange && !overlapsProtectedSyntax) {
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

/** A placeholder title can span parsed emphasis or inline-code nodes. */
const collectVisualReferences = (markdown: string, analysis: MarkdownAnalysis): void => {
  for (const match of markdown.matchAll(VISUAL_EXAMPLE)) {
    if (!analysis.text.some(text => text.start <= match.index && text.end > match.index)) continue;
    const range = { start: match.index, end: match.index + match[0].length };
    analysis.inlineVisuals.push({
      ...range,
      visual: { kind: 'generated-visual', visualId: match[1].trim() },
    });
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
    // Internal visual lines cannot end the surrounding spoken passage.
    if (analysis.inlineVisuals.some(visual => visual.start < lineStart && visual.end > lineStart)) {
      end = lineEnd;
      continue;
    }
    const block = analysis.blocks[blockIndex];
    if (block && block.start >= lineStart && block.start <= lineEnd) {
      flush();
      chunks.push({ ...block, start: lineStart });
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

/** Keep container structure while moving its recognized references into typed playback visuals. */
const projectBlockVisuals = (
  markdown: string,
  chunk: MarkdownChunk,
  analysis: MarkdownAnalysis
): PlaybackVisual[] => {
  if (chunk.visual) return [chunk.visual];
  const references = analysis.inlineVisuals.filter(
    (range): range is PlaybackRange & { readonly visual: PlaybackVisual } =>
      range.visual !== undefined && range.start >= chunk.start && range.end <= chunk.end
  );
  return [
    { kind: 'markdown', markdown: omitMarkdownRanges(markdown, chunk, references) },
    ...references.map(reference => reference.visual),
  ];
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
  if (
    previous?.source.end === start &&
    !previous.math &&
    previous.sourceBlockIndex === result.sourceBlockIndex
  ) {
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
    if (analysis.math.includes(omitted) && omitted.start >= range.start) {
      result.spans.push({
        speech: { start: result.speech.length, end: result.speech.length },
        source: { start: omitted.start, end: omitted.end },
        sourceBlockIndex: result.sourceBlockIndex,
        math: markdown.slice(omitted.start, omitted.end),
      });
    }
    cursor = Math.min(range.end, omitted.end);
  }
  appendSource(result, markdown, cursor, range.end);
  for (const visual of analysis.inlineVisuals) {
    if (visual.start >= range.start && visual.start < range.end) {
      result.visuals.push(
        visual.visual ?? { kind: 'markdown', markdown: markdown.slice(visual.start, visual.end) }
      );
    }
  }
};

const speechPrefixLength = (line: string): number => {
  const indentation = /^[ \t>]*/u.exec(line)?.[0].length ?? 0;
  const marker = /^(?:#{1,6}|[-+*]|\d+[.)])[ \t]+/u.exec(line.slice(indentation));
  return indentation + (marker?.[0].length ?? 0);
};

/** Omit recognized markup from a visual or identity projection while retaining the source. */
const omitMarkdownRanges = (
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

/** Escape syntax that reparsing would consume from originally literal text after unwrapping. */
const contextualMarkdown = (
  markdown: string,
  range: PlaybackRange,
  analysis: MarkdownAnalysis
): string => {
  const references = analysis.inlineVisuals.filter(visual => visual.visual !== undefined);
  const tags = [
    ...analysis.annotationTags.filter(
      tag => !references.some(reference => reference.start <= tag.start && reference.end >= tag.end)
    ),
    ...references,
  ]
    .filter(tag => tag.start >= range.start && tag.end <= range.end)
    .sort((left, right) => left.start - right.start);
  let text = omitMarkdownRanges(markdown, range, tags);
  if (!tags.length) return text;
  const escapes = new Set<number>();
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'text') return;
    const end = node.children?.[0]?.position.start.offset ?? node.position.end.offset;
    for (let offset = node.position.start.offset; offset < end; offset += 1) {
      if (!/[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/u.test(text[offset])) continue;
      let sourceOffset = range.start + offset;
      for (const tag of tags) {
        if (tag.start > sourceOffset) break;
        sourceOffset += tag.end - tag.start;
      }
      if (
        analysis.text.some(source => source.start <= sourceOffset && source.end > sourceOffset) &&
        !analysis.math.some(math => math.start <= sourceOffset && math.end > sourceOffset)
      ) {
        escapes.add(offset);
      }
    }
    if (node.children) for (const child of node.children) visit(child);
  };
  visit(markdownParser.parse(text) as MarkdownNode);
  for (const offset of [...escapes].sort((left, right) => right - left)) {
    text = `${text.slice(0, offset)}&#${text[offset].codePointAt(0)};${text.slice(offset + 1)}`;
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
        markdown: contextualMarkdown(markdown, range, analysis),
      },
      ...result.visuals.filter(visual => visual.kind !== 'markdown'),
    ];
  }
  return result;
};

/** Join independently mapped passages, shifting only their speech offsets. */
const joinSpokenText = (
  parts: readonly Pick<LessonPlaybackBlock, 'speech' | 'spans' | 'visuals'>[]
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
  let hasLegacyVisuals = false;
  const referencedVisualIds = new Set<string>();
  const blocks: (Omit<LessonPlaybackBlock, 'visuals' | 'spans'> & {
    visuals: PlaybackVisual[];
    spans: readonly PlaybackTextSpan[];
  })[] = [];
  let heading = '';
  let pendingIntroductions: SpokenText[] = [];
  let pendingVisuals: PlaybackVisual[] = [];
  const attachVisual = (visual: PlaybackVisual) => {
    const hasPendingFence = pendingIntroductions.some(text =>
      text.spans.some(span => span.fencedCode)
    );
    const previous = hasPendingFence ? undefined : blocks.at(-1);
    if (previous) previous.visuals.push(visual);
    else pendingVisuals.push(visual);
  };

  const recordContentProjection = (
    markdown: string,
    sourceBlockIndex: number,
    analysis: MarkdownAnalysis
  ): void => {
    for (const range of [...analysis.inlineVisuals, ...analysis.blocks]) {
      if (range.visual) hasLegacyVisuals = true;
      if (range.visual?.kind === 'generated-visual') referencedVisualIds.add(range.visual.visualId);
    }
    if (analysis.annotationTags.length) {
      hasAnnotations = true;
      const projectedMarkdown = omitMarkdownRanges(
        markdown,
        { start: 0, end: markdown.length },
        analysis.annotationTags
      );
      projectedContent[sourceBlockIndex] = { type: 'markdown', markdown: projectedMarkdown };
    }
  };

  const attachMarkdownVisual = (
    chunk: MarkdownChunk,
    markdown: string,
    sourceBlockIndex: number,
    analysis: MarkdownAnalysis
  ) => {
    const visual: PlaybackVisual = {
      kind: 'markdown',
      markdown: markdown.slice(chunk.start, chunk.end),
    };
    const candidate = chunk.fencedProseCandidate;
    if (!candidate) {
      for (const projected of projectBlockVisuals(markdown, chunk, analysis))
        attachVisual(projected);
      return;
    }
    const previous = pendingIntroductions.length ? undefined : blocks.at(-1);
    const visuals = previous?.visuals ?? pendingVisuals;
    const span: PlaybackTextSpan = {
      speech: { start: previous?.speech.length ?? 0, end: previous?.speech.length ?? 0 },
      source: candidate.source,
      sourceBlockIndex,
      fencedCode: { visualIndex: visuals.length, markdown: candidate.markdown },
    };
    if (previous) previous.spans = [...previous.spans, span];
    else pendingIntroductions.push({ speech: '', spans: [span], visuals: [], sourceBlockIndex });
    visuals.push(visual);
  };

  const appendMarkdown = (markdown: string, sourceBlockIndex: number): void => {
    const analysis = analyzeMarkdown(markdown);
    recordContentProjection(markdown, sourceBlockIndex, analysis);
    for (const chunk of markdownChunks(markdown, analysis)) {
      if (chunk.kind === 'omitted') continue;
      if (chunk.kind === 'visual') {
        attachMarkdownVisual(chunk, markdown, sourceBlockIndex, analysis);
        continue;
      }
      const text = spokenText(markdown, chunk, sourceBlockIndex, analysis);
      if (chunk.kind === 'heading') {
        heading = text.speech;
        appendHeadingSeparator(text, markdown, chunk.end);
        pendingIntroductions.push(text);
        continue;
      }
      if (!text.speech.trim()) {
        const formulas = text.spans.filter(span => span.math);
        if (formulas.length) {
          const previous = pendingIntroductions.length ? undefined : blocks.at(-1);
          const offset = previous?.speech.length ?? 0;
          const spans = formulas.map(span => ({ ...span, speech: { start: offset, end: offset } }));
          if (previous) previous.spans = [...previous.spans, ...spans];
          else pendingIntroductions.push({ ...text, speech: '', spans, visuals: [] });
        }
        for (const visual of text.visuals) attachVisual(visual);
        continue;
      }
      const spoken = joinSpokenText([...pendingIntroductions, text]);
      blocks.push({
        id: `${blocks.length}`,
        heading,
        speech: spoken.speech,
        spans: spoken.spans,
        visuals: [...pendingVisuals, ...spoken.visuals],
        audio: [],
      });
      pendingIntroductions = [];
      pendingVisuals = [];
    }
  };

  for (const [sourceBlockIndex, content] of contentBlocks.entries()) {
    if (content.type === 'generated-visual') {
      if (content.visualId) {
        referencedVisualIds.add(content.visualId);
        attachVisual({ kind: 'generated-visual', visualId: content.visualId });
      }
      continue;
    }
    if (content.type === 'markdown') appendMarkdown(content.markdown, sourceBlockIndex);
  }
  if (!blocks.length && pendingIntroductions.some(text => text.spans.some(span => span.math))) {
    const spoken = joinSpokenText(pendingIntroductions);
    blocks.push({
      id: '0',
      heading,
      ...spoken,
      visuals: [...pendingVisuals, ...spoken.visuals],
      audio: [],
    });
    pendingIntroductions = [];
  }
  // A final fenced explanation still has the previous narrated passage as its playback anchor.
  const previous = blocks.at(-1);
  if (
    previous &&
    pendingIntroductions.some(text => text.spans.some(span => span.fencedCode || span.math))
  ) {
    const first = pendingIntroductions[0].spans[0];
    const separator = {
      speech: '\n',
      spans: [
        {
          speech: { start: 0, end: 1 },
          source: { start: first.source.start, end: first.source.start },
          sourceBlockIndex: first.sourceBlockIndex,
        },
      ],
      visuals: [],
    };
    const pending = pendingIntroductions.map(text => ({
      ...text,
      spans: text.spans.map(span =>
        span.fencedCode
          ? {
              ...span,
              fencedCode: {
                ...span.fencedCode,
                visualIndex: previous.visuals.length + span.fencedCode.visualIndex,
              },
            }
          : span
      ),
    }));
    blocks[blocks.length - 1] = {
      ...previous,
      ...joinSpokenText([previous, separator, ...pending]),
      visuals: [
        ...previous.visuals,
        ...pendingVisuals,
        ...pendingIntroductions.flatMap(text => text.visuals),
      ],
    };
  }
  return {
    blocks,
    contentBlocks: projectedContent,
    hasAnnotations,
    hasLegacyVisuals,
    referencedVisualIds,
  };
};

/** Deterministically segment authored lesson text and attach visuals to its spoken introductions. */
export const segmentLessonPlayback = (
  contentBlocks: readonly PlaybackContentBlock[]
): LessonPlaybackBlock[] => projectLessonPlayback(contentBlocks).blocks;

/** Authored math context is syntax-derived input; the model still chooses its visual form. */
export const getPlaybackMathMarkdown = (block: LessonPlaybackBlock): string | undefined => {
  if (!block.visuals.length) return undefined;
  const passages: string[] = [];
  for (const visual of block.visuals) {
    if (visual.kind !== 'markdown' || !analyzeMarkdown(visual.markdown).math.length)
      return undefined;
    passages.push(visual.markdown);
  }
  return passages.join('\n\n');
};

/** Model-authored pronunciations, one per formula occurrence in source order. */
export interface PlaybackSpokenMath {
  readonly formula: string;
  readonly spoken: string;
}

/** Validate complete occurrence coverage; repeated formulas remain separate entries. */
export const validatePlaybackSpokenMath = (
  block: LessonPlaybackBlock,
  spokenMath: readonly PlaybackSpokenMath[]
): void => {
  const formulas = block.spans.flatMap(span => (span.math ? [span.math] : []));
  if (
    formulas.length !== spokenMath.length ||
    spokenMath.some((entry, index) => entry.formula !== formulas[index] || !entry.spoken.trim())
  )
    throw new Error('Spoken math must cover every inline formula in source order.');
};

export interface PlaybackFencedCodeDecision {
  readonly visualIndex: number;
  readonly kind: 'prose' | 'code';
  readonly spoken: string;
}

/** Every eligible source occurrence needs exactly one decision; declared code is never eligible. */
export const validatePlaybackFencedCode = (
  block: LessonPlaybackBlock,
  decisions: readonly PlaybackFencedCodeDecision[]
): void => {
  const candidates = block.spans.flatMap(span => (span.fencedCode ? [span.fencedCode] : []));
  if (
    candidates.length !== decisions.length ||
    decisions.some(
      (decision, index) =>
        decision.visualIndex !== candidates[index].visualIndex ||
        (decision.kind === 'prose' ? !decision.spoken.trim() : decision.spoken !== '')
    )
  )
    throw new Error('Fenced code decisions must cover every ambiguous occurrence in source order.');
};

/** Resolve narration and visuals once for TTS, captions, motion and source anchors. Idempotent. */
export const resolvePlaybackNarration = (
  block: LessonPlaybackBlock,
  spokenMath = block.prepared?.spokenMath,
  fencedCode = block.prepared?.fencedCode
): LessonPlaybackBlock => {
  if (!spokenMath && !fencedCode) return block;
  if (spokenMath) validatePlaybackSpokenMath(block, spokenMath);
  if (fencedCode) validatePlaybackFencedCode(block, fencedCode);
  let speech = '';
  let formulaIndex = 0;
  let fenceIndex = 0;
  const visuals = [...block.visuals];
  const spans = block.spans.map((span, index) => {
    const start = speech.length;
    if (span.fencedCode) {
      const decision = fencedCode?.[fenceIndex++];
      if (decision?.kind === 'prose') {
        if (speech && !speech.endsWith('\n')) speech += '\n';
        speech += decision.spoken;
        if (
          (block.speech.slice(span.speech.end) ||
            block.spans.slice(index + 1).some(next => next.math)) &&
          block.speech[span.speech.end] !== '\n'
        )
          speech += '\n';
        // Escape leading whitespace so classified prose cannot become indented Markdown code.
        visuals[decision.visualIndex] = {
          kind: 'markdown',
          markdown: span.fencedCode.markdown.replaceAll(/^[ \t]/gmu, character =>
            character === '\t' ? '&#9;' : '&#32;'
          ),
        };
      }
    } else {
      if (span.math && spokenMath) {
        const display = span.math.startsWith('$$') || span.math.startsWith(String.raw`\[`);
        if (display && speech && !/\s$/u.test(speech)) speech += '\n';
        speech += spokenMath[formulaIndex++].spoken;
        if (
          display &&
          index < block.spans.length - 1 &&
          !/^[\s.,;:!?]/u.test(block.speech.slice(span.speech.end))
        )
          speech += '\n';
      } else {
        speech += block.speech.slice(span.speech.start, span.speech.end);
      }
    }
    return { ...span, speech: { start, end: speech.length } };
  });
  return { ...block, speech, spans, visuals };
};

/** Detect saved audio that still uses the projection with silent inline formulas. No regeneration. */
export const hasOmittedPlaybackMath = (block: LessonPlaybackBlock): boolean =>
  Boolean(
    block.prepared &&
      block.audio.length &&
      block.spans.some(span => span.math) &&
      !block.prepared.spokenMath
  );
