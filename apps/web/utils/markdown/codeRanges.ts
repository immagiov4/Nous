import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import {
  escapeDisallowedRawHtml,
  getAllowedRawHtmlTagRanges,
  projectDisallowedRawHtml,
} from './html.ts';
import {
  getAccidentalPlainTextIndentationRanges,
  projectAccidentalPlainTextIndentation,
} from './indentation.ts';
import { getRenderedMathSourceRanges } from './mathNormalization.ts';

export { getMarkdownMathRangeAt } from './mathSyntax.ts';

export interface MarkdownRange {
  start: number;
  end: number;
}

const MARK_TAG_REGEX = /<\/?mark\b[^>]*>/g;
const TEXT_LIKE_MATH_COMMANDS = new Set(['text', 'mathrm', 'mathtt', 'operatorname']);
const ZERO_WIDTH_CHARACTERS_REGEX = /[\u200b-\u200d\uFEFF]/gu;
export const NON_ANCHORABLE_MARKDOWN_PLACEHOLDER_PREFIXES = [
  '{{PDF_IMAGE:',
  '{{VISUAL_EXAMPLE:',
  '{{YOUTUBE_CLIP_SOURCE:',
  '{{INLINE_QUIZ:',
  '{{VISUAL_SLOT:',
] as const;

const isValidMarkdownPlaceholderPayload = (prefix: string, payload: string): boolean => {
  switch (prefix) {
    case '{{PDF_IMAGE:':
      return /^[^|{}]+(?:\|alt=[^|{}]*)?(?:\|caption=[^{}]*)?$/u.test(payload);
    case '{{VISUAL_EXAMPLE:':
      return /^[^|{}]+(?:\|title=[^{}]*)?$/u.test(payload);
    case '{{YOUTUBE_CLIP_SOURCE:':
      return /^\d+(?:\|START:\d+\|END:\d+)?$/u.test(payload);
    case '{{INLINE_QUIZ:':
      return /^\d+$/u.test(payload);
    case '{{VISUAL_SLOT:':
      return /^[^{}]+$/u.test(payload);
    default:
      return false;
  }
};

export const readCompleteMarkdownPlaceholderRange = (
  content: string,
  start: number
): MarkdownRange | null => {
  const prefix = NON_ANCHORABLE_MARKDOWN_PLACEHOLDER_PREFIXES.find(candidate =>
    content.startsWith(candidate, start)
  );
  if (!prefix) return null;

  const closingIndex = content.indexOf('}}', start + prefix.length);
  if (closingIndex === -1) return null;
  const payload = content.slice(start + prefix.length, closingIndex);
  return isValidMarkdownPlaceholderPayload(prefix, payload)
    ? { start, end: closingIndex + 2 }
    : null;
};

export const isMarkdownPlaceholderLiteralInsideCode = (content: string, start: number): boolean =>
  content.startsWith('{{INLINE_QUIZ:', start);

const isAsciiAlphaNumeric = (character: string | undefined): boolean =>
  Boolean(character && /[A-Za-z0-9]/u.test(character));

const getMarkdownMathInnerRange = (content: string, range: MarkdownRange): MarkdownRange => {
  if (content.startsWith('$$', range.start)) {
    return { start: range.start + 2, end: Math.max(range.start + 2, range.end - 2) };
  }

  if (content[range.start] === '$') {
    return { start: range.start + 1, end: Math.max(range.start + 1, range.end - 1) };
  }

  if (
    content.startsWith(String.raw`\(`, range.start) ||
    content.startsWith(String.raw`\[`, range.start)
  ) {
    return { start: range.start + 2, end: Math.max(range.start + 2, range.end - 2) };
  }

  if (content[range.start] === '(' || content[range.start] === '[') {
    return { start: range.start + 1, end: Math.max(range.start + 1, range.end - 1) };
  }

  return range;
};

export const projectMarkdownMathRange = (
  content: string,
  range: MarkdownRange
): { text: string; sourceIndexes: number[] } => {
  const innerRange = getMarkdownMathInnerRange(content, range);
  const characters: string[] = [];
  const sourceIndexes: number[] = [];

  const pushCharacter = (character: string, sourceIndex: number) => {
    characters.push(character);
    sourceIndexes.push(sourceIndex);
  };

  const pushCommandText = (command: string, sourceIndex: number) => {
    for (let index = 0; index < command.length; index += 1) {
      pushCharacter(command[index], Math.min(sourceIndex + index, innerRange.end - 1));
    }
  };

  let index = innerRange.start;

  while (index < innerRange.end) {
    if (content[index] === '\\') {
      const commandMatch = content.slice(index + 1, innerRange.end).match(/^[A-Za-z]+/u);

      if (commandMatch) {
        const command = commandMatch[0];
        const commandStart = index + 1;
        index = commandStart + command.length;

        if (!TEXT_LIKE_MATH_COMMANDS.has(command)) {
          pushCommandText(command, commandStart);
        }
        continue;
      }

      if (index + 1 < innerRange.end) {
        pushCharacter(content[index + 1], index + 1);
        index += 2;
        continue;
      }
    }

    const currentCharacter = content[index];
    if (
      currentCharacter === '{' ||
      currentCharacter === '}' ||
      currentCharacter === '_' ||
      currentCharacter === '^'
    ) {
      index += 1;
      continue;
    }

    pushCharacter(currentCharacter, index);
    index += 1;
  }

  return {
    text: characters.join(''),
    sourceIndexes,
  };
};

export const projectKatexAnnotationSource = (texSource: string): string => {
  const wrappedExpression = `$${texSource}$`;
  return projectMarkdownMathRange(wrappedExpression, {
    start: 0,
    end: wrappedExpression.length,
  }).text;
};

const projectInlineMathLikeExpression = (expression: string): string => {
  const projected = projectMarkdownMathRange(`$${expression}$`, {
    start: 0,
    end: expression.length + 2,
  }).text;

  return projected || expression;
};

const findClosingBraceIndex = (value: string, openingBraceIndex: number): number => {
  let braceDepth = 0;

  for (let index = openingBraceIndex; index < value.length; index += 1) {
    if (value[index] === '{') {
      braceDepth += 1;
      continue;
    }

    if (value[index] !== '}') {
      continue;
    }

    braceDepth -= 1;
    if (braceDepth === 0) {
      return index;
    }
  }

  return -1;
};

const findInlineMathLikeExpressionEnd = (value: string, startIndex: number): number | null => {
  let cursor = startIndex;

  while (isAsciiAlphaNumeric(value[cursor])) {
    cursor += 1;
  }

  if (cursor === startIndex) {
    return null;
  }

  let scriptCount = 0;

  while ((value[cursor] === '_' || value[cursor] === '^') && value[cursor + 1] === '{') {
    const closingBraceIndex = findClosingBraceIndex(value, cursor + 1);
    if (closingBraceIndex === -1 || closingBraceIndex === cursor + 2) {
      return scriptCount > 0 ? cursor : null;
    }

    scriptCount += 1;
    cursor = closingBraceIndex + 1;
  }

  return scriptCount > 0 ? cursor : null;
};

const collapseAdjacentDuplicatedWordRuns = (value: string): string => {
  let nextValue = value;

  while (true) {
    const collapsedValue = nextValue.replaceAll(/([A-Za-z][A-Za-z0-9]{2,})(?:\1){1,}/gu, '$1');

    if (collapsedValue === nextValue) {
      return collapsedValue;
    }

    nextValue = collapsedValue;
  }
};

export const normalizeMathSelectionArtifacts = (value: string): string => {
  const strippedValue = value.replaceAll(ZERO_WIDTH_CHARACTERS_REGEX, '');
  let projectedValue = '';
  let cursor = 0;

  while (cursor < strippedValue.length) {
    const expressionEnd = findInlineMathLikeExpressionEnd(strippedValue, cursor);
    if (expressionEnd === null) {
      projectedValue += strippedValue[cursor];
      cursor += 1;
      continue;
    }

    projectedValue += projectInlineMathLikeExpression(strippedValue.slice(cursor, expressionEnd));
    cursor = expressionEnd;
  }

  if (projectedValue === strippedValue) {
    return strippedValue;
  }

  return collapseAdjacentDuplicatedWordRuns(projectedValue);
};

const mergeRanges = (ranges: MarkdownRange[]): MarkdownRange[] => {
  if (ranges.length <= 1) {
    return ranges;
  }

  const sortedRanges = [...ranges].sort((left, right) => left.start - right.start);
  const mergedRanges: MarkdownRange[] = [sortedRanges[0]];

  for (let index = 1; index < sortedRanges.length; index += 1) {
    const currentRange = sortedRanges[index];
    const lastMergedRange = mergedRanges.at(-1) as MarkdownRange;

    if (currentRange.start <= lastMergedRange.end) {
      lastMergedRange.end = Math.max(lastMergedRange.end, currentRange.end);
      continue;
    }

    mergedRanges.push({ ...currentRange });
  }

  return mergedRanges;
};

export const mergeOverlappingMarkdownRanges = (ranges: MarkdownRange[]): MarkdownRange[] => {
  const mergedRanges: MarkdownRange[] = [];

  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const previousRange = mergedRanges.at(-1);
    if (previousRange && range.start < previousRange.end) {
      previousRange.end = Math.max(previousRange.end, range.end);
    } else {
      mergedRanges.push({ ...range });
    }
  }

  return mergedRanges;
};

interface MarkdownAstPosition {
  end: { offset?: number };
  start: { offset?: number };
}

interface MarkdownAstNode {
  checked?: boolean | null;
  children?: MarkdownAstNode[];
  position?: MarkdownAstPosition;
  type: string;
  url?: string;
  value?: string;
}

export interface MarkdownAnalysis {
  annotationOnlyRanges: MarkdownRange[];
  codeRanges: MarkdownRange[];
  escapedFenceOpenerRanges: MarkdownRange[];
  htmlSyntaxRanges: MarkdownRange[];
  imageRanges: MarkdownRange[];
  inlineBoundaryRanges: MarkdownRange[];
  linkDestinationRanges: MarkdownRange[];
  mathRanges: MarkdownRange[];
  referenceDefinitionRanges: MarkdownRange[];
  referenceLinkLabelRanges: MarkdownRange[];
  rendererNormalizedIndentRanges: MarkdownRange[];
  structuralRanges: MarkdownRange[];
}

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkBreaks);

const rendererParsesImageSource = (source: string): boolean => {
  const renderedSource = escapeDisallowedRawHtml(source);
  if (renderedSource === source) return true;
  const root = markdownParser.parse(renderedSource) as MarkdownAstNode;
  return (
    root.children?.some(node =>
      node.children?.some(child => child.type === 'image' || child.type === 'imageReference')
    ) ?? false
  );
};

const getNodeRange = (node: MarkdownAstNode, sourceOffsets: number[]): MarkdownRange | null => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined
    ? null
    : { start: sourceOffsets[start] ?? start, end: sourceOffsets[end] ?? end };
};

const expandToLineBounds = (content: string, range: MarkdownRange): MarkdownRange => {
  const lineStart = content.lastIndexOf('\n', range.start - 1) + 1;
  if (range.end > range.start && content[range.end - 1] === '\n') {
    return { start: lineStart, end: range.end };
  }
  const lineBreak = content.indexOf('\n', range.end);
  return { start: lineStart, end: lineBreak === -1 ? content.length : lineBreak };
};

export interface MarkdownFencedCodePlan {
  closedRanges: MarkdownRange[];
  unclosedRanges: MarkdownRange[];
}

const CLOSED_FENCE_BOUNDARY_LINE_COUNT = 2;
const MAX_MARKDOWN_FENCE_INDENT = 3;
const MIN_MARKDOWN_FENCE_LENGTH = 3;
const MARKDOWN_FENCE_OPENER_PATTERN = new RegExp(
  `^(\`{${MIN_MARKDOWN_FENCE_LENGTH},}|~{${MIN_MARKDOWN_FENCE_LENGTH},})`,
  'u'
);

const hasClosingFence = (source: string, parsedCode: string): boolean => {
  const lines = source.split(/\r?\n/u);
  const openingMatch = lines[0]?.match(MARKDOWN_FENCE_OPENER_PATTERN);
  if (!openingMatch || lines.length < 2) {
    return false;
  }

  const openingFence = openingMatch[1];
  const closingFence = new RegExp(
    `^[\\t >]*${openingFence[0]}{${openingFence.length},}[\\t ]*$`,
    'u'
  );
  const parsedCodeLineCount = parsedCode.length === 0 ? 0 : parsedCode.split(/\r?\n/u).length;
  return (
    closingFence.test(lines.at(-1) ?? '') &&
    lines.length >= parsedCodeLineCount + CLOSED_FENCE_BOUNDARY_LINE_COUNT
  );
};

export const planMarkdownFencedCode = (content: string): MarkdownFencedCodePlan => {
  const root = markdownParser.runSync(markdownParser.parse(content)) as MarkdownAstNode;
  const plan: MarkdownFencedCodePlan = { closedRanges: [], unclosedRanges: [] };
  const visit = (node: MarkdownAstNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === 'code' && start !== undefined && end !== undefined) {
      const source = content.slice(start, end);
      if (MARKDOWN_FENCE_OPENER_PATTERN.test(source)) {
        const range = expandToLineBounds(content, { start, end });
        const target = hasClosingFence(source, node.value ?? '')
          ? plan.closedRanges
          : plan.unclosedRanges;
        target.push(range);
      }
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return plan;
};

const getFenceOpeningRange = (content: string, range: MarkdownRange): MarkdownRange => {
  const openingLineEnd = content.indexOf('\n', range.start);
  const openingLine = content.slice(
    range.start,
    openingLineEnd === -1 ? range.end : openingLineEnd
  );
  const openingFenceStart = range.start + Math.max(openingLine.search(/[`~]/u), 0);
  const openingFenceLength = content.slice(openingFenceStart).match(/^[`~]+/u)?.[0].length ?? 0;
  return { start: openingFenceStart, end: openingFenceStart + openingFenceLength };
};

const projectFenceOpeners = (
  content: string,
  openingRanges: readonly MarkdownRange[]
): { content: string; sourceOffsets: number[] } => {
  const characters: string[] = [];
  const sourceOffsets: number[] = [];
  let cursor = 0;
  const appendSource = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      characters.push(content[index]);
      sourceOffsets.push(index);
    }
  };

  for (const range of [...openingRanges].sort((left, right) => left.start - right.start)) {
    const openingFenceStart = range.start;
    if (openingFenceStart < cursor) continue;
    appendSource(cursor, openingFenceStart);
    characters.push('\\');
    sourceOffsets.push(openingFenceStart);
    cursor = openingFenceStart;
  }
  appendSource(cursor, content.length);
  sourceOffsets.push(content.length);
  return { content: characters.join(''), sourceOffsets };
};

interface UnclosedFenceProjection {
  content: string;
  escapedOpenerRanges: MarkdownRange[];
  sourceOffsets: number[];
}

const getFenceOpenersInsideUnclosedRanges = (
  content: string,
  unclosedRanges: readonly MarkdownRange[]
): MarkdownRange[] => {
  const openingRanges: MarkdownRange[] = [];
  for (const unclosedRange of unclosedRanges) {
    const rangeContent = content.slice(unclosedRange.start, unclosedRange.end);
    const firstOpeningRange = getFenceOpeningRange(content, unclosedRange);
    const containerPrefixWidth = Math.max(
      0,
      firstOpeningRange.start - unclosedRange.start - MAX_MARKDOWN_FENCE_INDENT
    );
    let lineStart = 0;

    for (const line of rangeContent.split('\n')) {
      const candidates = [{ sourceOffset: 0, value: line }];
      const containerPrefix = line.slice(0, containerPrefixWidth);
      if (
        containerPrefixWidth > 0 &&
        containerPrefix.length === containerPrefixWidth &&
        /^[\t >+*().\d-]+$/u.test(containerPrefix)
      ) {
        candidates.push({
          sourceOffset: containerPrefixWidth,
          value: line.slice(containerPrefixWidth),
        });
      }

      for (const candidate of candidates) {
        const linePlan = planMarkdownFencedCode(candidate.value);
        const lineRange = linePlan.unclosedRanges[0];
        if (!lineRange) continue;
        const openingRange = getFenceOpeningRange(candidate.value, lineRange);
        openingRanges.push({
          start: unclosedRange.start + lineStart + candidate.sourceOffset + openingRange.start,
          end: unclosedRange.start + lineStart + candidate.sourceOffset + openingRange.end,
        });
        break;
      }
      lineStart += line.length + 1;
    }
  }
  return openingRanges;
};

const projectAllUnclosedFenceOpeners = (content: string): UnclosedFenceProjection => {
  const initialUnclosedRanges = planMarkdownFencedCode(content).unclosedRanges;
  const initialOpeningRanges = initialUnclosedRanges.map(range =>
    getFenceOpeningRange(content, range)
  );
  const initialProjection = projectFenceOpeners(content, initialOpeningRanges);
  const remainingUnclosedRanges = planMarkdownFencedCode(initialProjection.content).unclosedRanges;
  const remainingProjectedOpeningRanges = getFenceOpenersInsideUnclosedRanges(
    initialProjection.content,
    remainingUnclosedRanges
  );
  const remainingOpeningRanges = remainingProjectedOpeningRanges.map(range => ({
    start: initialProjection.sourceOffsets[range.start] ?? range.start,
    end: initialProjection.sourceOffsets[range.end] ?? range.end,
  }));
  const finalProjection = projectFenceOpeners(
    initialProjection.content,
    remainingProjectedOpeningRanges
  );
  const sourceOffsets = finalProjection.sourceOffsets.map(
    offset => initialProjection.sourceOffsets[offset] ?? offset
  );
  return {
    content: finalProjection.content,
    escapedOpenerRanges: [...initialOpeningRanges, ...remainingOpeningRanges],
    sourceOffsets,
  };
};

export const escapeUnclosedMarkdownFenceOpeners = (content: string): string =>
  projectAllUnclosedFenceOpeners(content).content;

const getTableDelimiterRange = (
  content: string,
  node: MarkdownAstNode,
  nodeRange: MarkdownRange,
  sourceOffsets: number[]
): MarkdownRange | null => {
  const headerRow = node.children?.[0];
  if (!headerRow) return null;
  const headerRange = getNodeRange(headerRow, sourceOffsets);
  if (!headerRange) return null;
  const headerLineBreak = content.indexOf('\n', headerRange.end);
  if (headerLineBreak === -1 || headerLineBreak >= nodeRange.end) return null;
  const start = headerLineBreak + 1;
  const delimiterLineBreak = content.indexOf('\n', start);
  const end = delimiterLineBreak === -1 ? nodeRange.end : delimiterLineBreak;
  return start < end && end <= nodeRange.end ? { start, end } : null;
};

const getInlineLinkDestinationRange = (
  content: string,
  node: MarkdownAstNode,
  nodeRange: MarkdownRange,
  sourceOffsets: number[]
): MarkdownRange | null => {
  const childEnd = node.children?.at(-1)?.position?.end.offset;
  const lastChildEnd =
    childEnd === undefined ? nodeRange.start : (sourceOffsets[childEnd] ?? childEnd);
  const destinationStart = content.indexOf('](', lastChildEnd);
  return destinationStart !== -1 && destinationStart < nodeRange.end
    ? { start: destinationStart + 1, end: nodeRange.end }
    : null;
};

const getReferenceLabelRange = (
  content: string,
  node: MarkdownAstNode,
  nodeRange: MarkdownRange,
  sourceOffsets: number[]
): MarkdownRange | null => {
  const childEnd = node.children?.at(-1)?.position?.end.offset;
  const lastChildEnd =
    childEnd === undefined ? nodeRange.start : (sourceOffsets[childEnd] ?? childEnd);
  const referenceStart = content.indexOf('[', lastChildEnd);
  return referenceStart !== -1 && referenceStart < nodeRange.end
    ? { start: referenceStart, end: nodeRange.end }
    : null;
};

const getFootnoteDefinitionLabelRange = (
  node: MarkdownAstNode,
  nodeRange: MarkdownRange,
  sourceOffsets: number[]
): MarkdownRange | null => {
  const contentStart = node.children?.[0]?.position?.start.offset;
  if (contentStart === undefined) return nodeRange;
  const end = sourceOffsets[contentStart] ?? contentStart;
  return nodeRange.start < end ? { start: nodeRange.start, end } : null;
};

const getStructuralRangesForNode = (
  content: string,
  node: MarkdownAstNode,
  nodeRange: MarkdownRange,
  sourceOffsets: number[]
): MarkdownRange[] => {
  if (node.type === 'thematicBreak' || node.type === 'footnoteReference') return [nodeRange];
  if (node.type === 'listItem' && node.checked !== null && node.checked !== undefined) {
    const lineEnd = content.indexOf('\n', nodeRange.start);
    const firstLineEnd = lineEnd === -1 ? nodeRange.end : Math.min(lineEnd, nodeRange.end);
    const taskMarker = /\[[ xX]\]/u.exec(content.slice(nodeRange.start, firstLineEnd));
    if (taskMarker) {
      const markerStart = nodeRange.start + taskMarker.index;
      return [{ start: markerStart, end: markerStart + taskMarker[0].length }];
    }
  }
  if (node.type === 'heading') {
    const underlineStart = content.lastIndexOf('\n', nodeRange.end - 1) + 1;
    if (underlineStart > nodeRange.start) return [{ start: underlineStart, end: nodeRange.end }];
  }
  if (node.type === 'footnoteDefinition') {
    const labelRange = getFootnoteDefinitionLabelRange(node, nodeRange, sourceOffsets);
    return labelRange ? [labelRange] : [];
  }
  if (node.type === 'table') {
    const delimiterRange = getTableDelimiterRange(content, node, nodeRange, sourceOffsets);
    return delimiterRange ? [delimiterRange] : [];
  }
  return [];
};

const isRendererHiddenHtmlSyntax = (source: string): boolean =>
  source.startsWith('<!--') || source.startsWith('<!') || source.startsWith('<?');

const isAnnotationUnsafeAutolink = (node: MarkdownAstNode, source: string): boolean =>
  (source.startsWith('<') && source.endsWith('>') && node.url?.startsWith('mailto:')) ||
  /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>]*>$/u.test(source);

const collectPlaceholderRanges = (content: string): MarkdownRange[] =>
  NON_ANCHORABLE_MARKDOWN_PLACEHOLDER_PREFIXES.flatMap(prefix => {
    const ranges: MarkdownRange[] = [];
    let start = content.indexOf(prefix);
    while (start !== -1) {
      const range = readCompleteMarkdownPlaceholderRange(content, start);
      if (range) ranges.push(range);
      start = content.indexOf(prefix, range?.end ?? start + prefix.length);
    }
    return ranges;
  });

export const parseMarkdownAnalysis = (content: string): MarkdownAnalysis => {
  const fencedCodePlan = planMarkdownFencedCode(content);
  const fencedCodeRanges = [...fencedCodePlan.closedRanges, ...fencedCodePlan.unclosedRanges];
  const analysis: MarkdownAnalysis = {
    annotationOnlyRanges: [],
    codeRanges: [],
    escapedFenceOpenerRanges: [],
    htmlSyntaxRanges: [],
    imageRanges: [],
    inlineBoundaryRanges: [],
    linkDestinationRanges: [],
    mathRanges: [],
    referenceDefinitionRanges: [],
    referenceLinkLabelRanges: [],
    rendererNormalizedIndentRanges: getAccidentalPlainTextIndentationRanges(
      content,
      fencedCodeRanges
    ),
    structuralRanges: [],
  };
  const indentationProjection = projectAccidentalPlainTextIndentation(content, fencedCodeRanges);
  const fenceProjection = projectAllUnclosedFenceOpeners(indentationProjection.content);
  analysis.escapedFenceOpenerRanges = fenceProjection.escapedOpenerRanges.map(range => ({
    start: indentationProjection.sourceOffsets[range.start] ?? range.start,
    end: indentationProjection.sourceOffsets[range.end] ?? range.end,
  }));
  const markdownSourceOffsets = fenceProjection.sourceOffsets.map(
    offset => indentationProjection.sourceOffsets[offset] ?? offset
  );
  const htmlProjection = projectDisallowedRawHtml(fenceProjection.content);
  const htmlSourceOffsets = htmlProjection.sourceOffsets.map(
    offset => markdownSourceOffsets[offset] ?? offset
  );
  const escapedHtmlContentRanges: MarkdownRange[] = [];
  const root = markdownParser.runSync(
    markdownParser.parse(fenceProjection.content)
  ) as MarkdownAstNode;
  const visit = (node: MarkdownAstNode): void => {
    const range = getNodeRange(node, markdownSourceOffsets);
    if (range) {
      if (node.type === 'inlineCode') {
        analysis.codeRanges.push(range);
      }
      if (node.type === 'code') {
        const blockRange = expandToLineBounds(content, range);
        analysis.codeRanges.push(blockRange);
      }
      if (node.type === 'math' || node.type === 'inlineMath') analysis.mathRanges.push(range);
      analysis.structuralRanges.push(
        ...getStructuralRangesForNode(content, node, range, markdownSourceOffsets)
      );
      if (node.type === 'footnoteReference') analysis.inlineBoundaryRanges.push(range);
      if (node.type === 'image' || node.type === 'imageReference') {
        const source = content.slice(range.start, range.end);
        if (node.type === 'imageReference' || rendererParsesImageSource(source)) {
          analysis.imageRanges.push(range);
        }
      }
      if (node.type === 'definition') {
        analysis.referenceDefinitionRanges.push(expandToLineBounds(content, range));
      }
      if (node.type === 'html') {
        const source = content.slice(range.start, range.end);
        if (isRendererHiddenHtmlSyntax(source)) {
          analysis.htmlSyntaxRanges.push(range);
        } else {
          analysis.htmlSyntaxRanges.push(...getAllowedRawHtmlTagRanges(source, range.start));
          if (escapeDisallowedRawHtml(source) !== source) {
            escapedHtmlContentRanges.push(range);
          }
        }
      }
      if (node.type === 'link') {
        const source = content.slice(range.start, range.end);
        if (isAnnotationUnsafeAutolink(node, source)) {
          analysis.annotationOnlyRanges.push(range);
        } else if (!(source.startsWith('<') && source.endsWith('>'))) {
          const destinationRange = getInlineLinkDestinationRange(
            content,
            node,
            range,
            markdownSourceOffsets
          );
          if (destinationRange) analysis.linkDestinationRanges.push(destinationRange);
        }
      }
      if (node.type === 'linkReference') {
        const labelRange = getReferenceLabelRange(content, node, range, markdownSourceOffsets);
        if (labelRange) analysis.referenceLinkLabelRanges.push(labelRange);
      }
    }
    node.children?.forEach(visit);
  };
  visit(root);
  const htmlRoot = markdownParser.runSync(
    markdownParser.parse(htmlProjection.content)
  ) as MarkdownAstNode;
  const visitEscapedHtml = (node: MarkdownAstNode): void => {
    const range = getNodeRange(node, htmlSourceOffsets);
    if (range) {
      const isInsideEscapedHtml = escapedHtmlContentRanges.some(
        htmlRange => range.start >= htmlRange.start && range.end <= htmlRange.end
      );
      if (
        isInsideEscapedHtml &&
        node.type === 'html' &&
        isRendererHiddenHtmlSyntax(content.slice(range.start, range.end))
      ) {
        analysis.htmlSyntaxRanges.push(range);
      }
      if (
        node.type === 'inlineCode' &&
        !analysis.codeRanges.some(
          candidate => candidate.start === range.start && candidate.end === range.end
        )
      ) {
        analysis.codeRanges.push(range);
      }
      if (node.type === 'code') {
        const blockRange = expandToLineBounds(content, range);
        if (
          !analysis.codeRanges.some(
            candidate => candidate.start === blockRange.start && candidate.end === blockRange.end
          )
        ) {
          analysis.codeRanges.push(blockRange);
        }
      }
      if (node.type === 'math' || node.type === 'inlineMath') analysis.mathRanges.push(range);
      if (isInsideEscapedHtml) {
        analysis.structuralRanges.push(
          ...getStructuralRangesForNode(content, node, range, htmlSourceOffsets)
        );
        if (node.type === 'footnoteReference') analysis.inlineBoundaryRanges.push(range);
      }
      if (isInsideEscapedHtml && (node.type === 'image' || node.type === 'imageReference')) {
        const source = content.slice(range.start, range.end);
        if (node.type === 'imageReference' || rendererParsesImageSource(source)) {
          analysis.imageRanges.push(range);
        }
      }
      if (isInsideEscapedHtml && node.type === 'link') {
        const source = content.slice(range.start, range.end);
        if (isAnnotationUnsafeAutolink(node, source)) {
          analysis.annotationOnlyRanges.push(range);
        } else if (!(source.startsWith('<') && source.endsWith('>'))) {
          const destinationRange = getInlineLinkDestinationRange(
            content,
            node,
            range,
            htmlSourceOffsets
          );
          if (destinationRange) analysis.linkDestinationRanges.push(destinationRange);
        }
      }
      if (isInsideEscapedHtml && node.type === 'linkReference') {
        const labelRange = getReferenceLabelRange(content, node, range, htmlSourceOffsets);
        if (labelRange) analysis.referenceLinkLabelRanges.push(labelRange);
      }
    }
    node.children?.forEach(visitEscapedHtml);
  };
  visitEscapedHtml(htmlRoot);
  analysis.mathRanges.push(
    ...getRenderedMathSourceRanges(content).filter(
      mathRange =>
        !analysis.codeRanges.some(
          codeRange => codeRange.start < mathRange.end && codeRange.end > mathRange.start
        )
    )
  );
  analysis.codeRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  analysis.mathRanges = mergeOverlappingMarkdownRanges(analysis.mathRanges);
  return analysis;
};

export const findInlineLinkDestinationEnd = (
  content: string,
  openingParenthesisIndex: number
): number => {
  const range = parseMarkdownAnalysis(content).linkDestinationRanges.find(
    candidate => candidate.start === openingParenthesisIndex
  );
  if (range) return range.end - 1;

  const syntheticLabel = '[x]';
  const destinationSource = content.slice(openingParenthesisIndex);
  const syntheticRange = parseMarkdownAnalysis(
    `${syntheticLabel}${destinationSource}`
  ).linkDestinationRanges.at(0);
  return syntheticRange?.start === syntheticLabel.length
    ? openingParenthesisIndex + syntheticRange.end - syntheticLabel.length - 1
    : -1;
};

export const findInlineLabelEnd = (content: string, openingBracketIndex: number): number => {
  let depth = 0;
  for (let index = openingBracketIndex; index < content.length; index += 1) {
    if (content[index] === '\\') index += 1;
    else if (content[index] === '[') depth += 1;
    else if (content[index] === ']' && --depth === 0) return index;
  }
  return -1;
};

export const getMarkdownReferenceDefinitionRanges = (
  content: string,
  analysis = parseMarkdownAnalysis(content)
): MarkdownRange[] => analysis.referenceDefinitionRanges;

export const getMarkdownImageRanges = (
  content: string,
  analysis = parseMarkdownAnalysis(content)
): MarkdownRange[] => analysis.imageRanges;

export const getMarkdownLinkDestinationRanges = (
  content: string,
  analysis = parseMarkdownAnalysis(content)
): MarkdownRange[] => analysis.linkDestinationRanges;

export const getMarkdownReferenceLinkLabelRanges = (
  content: string,
  analysis = parseMarkdownAnalysis(content)
): MarkdownRange[] => analysis.referenceLinkLabelRanges;

export const getMarkdownProtectedRanges = (
  content: string,
  analysis = parseMarkdownAnalysis(content)
): MarkdownRange[] => mergeRanges([...analysis.codeRanges, ...analysis.mathRanges]);

export const getMarkdownAnnotationProtectedRanges = (
  content: string,
  analysis = parseMarkdownAnalysis(content)
): MarkdownRange[] =>
  mergeOverlappingMarkdownRanges([
    ...analysis.annotationOnlyRanges,
    ...analysis.codeRanges,
    ...analysis.imageRanges,
    ...analysis.linkDestinationRanges,
    ...analysis.referenceDefinitionRanges,
    ...analysis.referenceLinkLabelRanges,
    ...analysis.mathRanges,
    ...analysis.structuralRanges,
    ...collectPlaceholderRanges(content),
  ]);

export const stripHighlightTagsInsideMarkdownCode = (content: string): string => {
  const ranges = mergeOverlappingMarkdownRanges(parseMarkdownAnalysis(content).codeRanges);
  if (ranges.length === 0) return content;
  let result = '';
  let cursor = 0;
  for (const range of ranges) {
    result += content.slice(cursor, range.start);
    result += content.slice(range.start, range.end).replaceAll(MARK_TAG_REGEX, '');
    cursor = range.end;
  }
  return result + content.slice(cursor);
};
