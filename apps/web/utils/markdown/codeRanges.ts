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
  const previousLineFeed = content.lastIndexOf('\n', range.start - 1);
  const previousCarriageReturn = content.lastIndexOf('\r', range.start - 1);
  const lineStart = Math.max(previousLineFeed, previousCarriageReturn) + 1;
  if (range.end > range.start) {
    const finalCharacter = content[range.end - 1];
    if (finalCharacter === '\n') return { start: lineStart, end: range.end };
    if (finalCharacter === '\r') {
      const lineBreakEnd = content[range.end] === '\n' ? range.end + 1 : range.end;
      return { start: lineStart, end: lineBreakEnd };
    }
  }
  const nextLineFeed = content.indexOf('\n', range.end);
  const nextCarriageReturn = content.indexOf('\r', range.end);
  let lineBreak = nextLineFeed;
  if (lineBreak === -1 || (nextCarriageReturn !== -1 && nextCarriageReturn < lineBreak)) {
    lineBreak = nextCarriageReturn;
  }
  return { start: lineStart, end: lineBreak === -1 ? content.length : lineBreak };
};

export interface MarkdownFencedCodePlan {
  closedRanges: MarkdownRange[];
  unclosedRanges: MarkdownRange[];
}

const CLOSED_FENCE_BOUNDARY_LINE_COUNT = 2;
export const MIN_MARKDOWN_FENCE_LENGTH = 3;
const MAX_MARKDOWN_BLOCK_INDENTATION = 3;
const MARKDOWN_FENCE_OPENER_PATTERN = new RegExp(
  `^(\`{${MIN_MARKDOWN_FENCE_LENGTH},}|~{${MIN_MARKDOWN_FENCE_LENGTH},})`,
  'u'
);
const MARKDOWN_LINE_BREAK_PATTERN = /\r\n?|\n/u;

const hasClosingFence = (source: string, parsedCode: string): boolean => {
  const lines = source.split(MARKDOWN_LINE_BREAK_PATTERN);
  const openingMatch = lines[0]?.match(MARKDOWN_FENCE_OPENER_PATTERN);
  if (!openingMatch || lines.length < 2) {
    return false;
  }

  const openingFence = openingMatch[1];
  const closingFence = new RegExp(
    `^[\\t >]*${openingFence[0]}{${openingFence.length},}[\\t ]*$`,
    'u'
  );
  const parsedCodeLineCount =
    parsedCode.length === 0 ? 0 : parsedCode.split(MARKDOWN_LINE_BREAK_PATTERN).length;
  return (
    closingFence.test(lines.at(-1) ?? '') &&
    lines.length >= parsedCodeLineCount + CLOSED_FENCE_BOUNDARY_LINE_COUNT
  );
};

interface ParsedMarkdownCode {
  codeRanges: MarkdownRange[];
  fencedCodePlan: MarkdownFencedCodePlan;
}

const parseMarkdownCode = (content: string): ParsedMarkdownCode => {
  const root = markdownParser.runSync(markdownParser.parse(content)) as MarkdownAstNode;
  const codeRanges: MarkdownRange[] = [];
  const fencedCodePlan: MarkdownFencedCodePlan = { closedRanges: [], unclosedRanges: [] };
  const visit = (node: MarkdownAstNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === 'inlineCode' && start !== undefined && end !== undefined) {
      codeRanges.push({ start, end });
    }
    if (node.type === 'code' && start !== undefined && end !== undefined) {
      const range = expandToLineBounds(content, { start, end });
      const source = content.slice(start, end);
      if (MARKDOWN_FENCE_OPENER_PATTERN.test(source)) {
        const isClosed = hasClosingFence(source, node.value ?? '');
        const target = isClosed ? fencedCodePlan.closedRanges : fencedCodePlan.unclosedRanges;
        target.push(range);
        if (isClosed) codeRanges.push(range);
      } else {
        codeRanges.push(range);
      }
    }
    node.children?.forEach(visit);
  };
  visit(root);
  codeRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  return { codeRanges, fencedCodePlan };
};

export const planMarkdownFencedCode = (content: string): MarkdownFencedCodePlan =>
  parseMarkdownCode(content).fencedCodePlan;

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

const CONTAINER_FENCE_LINE_PATTERN = new RegExp(
  `^([\\t >+*().\\d-]*)(\`{${MIN_MARKDOWN_FENCE_LENGTH},}|~{${MIN_MARKDOWN_FENCE_LENGTH},})(.*)$`,
  'u'
);
const CONTAINER_FENCE_INDENTATION_PATTERN = new RegExp(
  `^ {0,${MAX_MARKDOWN_BLOCK_INDENTATION}}$`,
  'u'
);

interface ProjectionFenceCandidate extends MarkdownRange {
  fenceCharacter: string;
  isMarkerOnly: boolean;
}

interface MarkdownLine {
  content: string;
  start: number;
}

const getMarkdownLines = (content: string, sourceStart: number): MarkdownLine[] => {
  const lines: MarkdownLine[] = [];
  let lineStart = 0;

  for (let cursor = 0; cursor < content.length; cursor += 1) {
    const character = content[cursor];
    if (character !== '\r' && character !== '\n') continue;

    lines.push({ content: content.slice(lineStart, cursor), start: sourceStart + lineStart });
    if (character === '\r' && content[cursor + 1] === '\n') cursor += 1;
    lineStart = cursor + 1;
  }
  lines.push({ content: content.slice(lineStart), start: sourceStart + lineStart });

  return lines;
};

const getProjectionOpeningRanges = (
  content: string,
  unclosedRanges: readonly MarkdownRange[]
): MarkdownRange[] =>
  unclosedRanges.flatMap(unclosedRange => {
    const firstOpeningRange = getFenceOpeningRange(content, unclosedRange);
    const rangeContent = content.slice(unclosedRange.start, unclosedRange.end);
    const candidates: ProjectionFenceCandidate[] = [];
    for (const line of getMarkdownLines(rangeContent, unclosedRange.start)) {
      const match = line.content.match(CONTAINER_FENCE_LINE_PATTERN);
      if (match) {
        const [, containerPrefix, fence, info] = match;
        const normalizedInfo = info.trim();
        const start = line.start + containerPrefix.length;
        const hasValidInfo = fence[0] === '~' || !normalizedInfo.includes('`');
        const hasValidIndentation = CONTAINER_FENCE_INDENTATION_PATTERN.test(containerPrefix);
        if (start !== firstOpeningRange.start && hasValidInfo && hasValidIndentation) {
          candidates.push({
            start,
            end: start + fence.length,
            fenceCharacter: fence[0],
            isMarkerOnly: normalizedInfo.length === 0,
          });
        }
      }
    }

    const openingRanges = [firstOpeningRange];
    let candidateIndex = 0;
    while (candidateIndex < candidates.length) {
      const opener = candidates[candidateIndex];
      let closerIndex = candidateIndex + 1;
      while (closerIndex < candidates.length) {
        const closer = candidates[closerIndex];
        if (
          closer.isMarkerOnly &&
          closer.fenceCharacter === opener.fenceCharacter &&
          closer.end - closer.start >= opener.end - opener.start
        ) {
          break;
        }
        closerIndex += 1;
      }
      if (closerIndex === candidates.length) {
        openingRanges.push({ start: opener.start, end: opener.end });
        candidateIndex += 1;
      } else {
        candidateIndex = closerIndex + 1;
      }
    }
    return openingRanges;
  });

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
    for (let index = range.start; index < range.end; index += 1) {
      characters.push('\\', content[index]);
      sourceOffsets.push(index, index);
    }
    cursor = range.end;
  }
  appendSource(cursor, content.length);
  sourceOffsets.push(content.length);
  return { content: characters.join(''), sourceOffsets };
};

export interface UnclosedFenceProjection {
  codeRanges: MarkdownRange[];
  content: string;
  escapedOpenerRanges: MarkdownRange[];
  sourceOffsets: number[];
}

export const projectUnclosedMarkdownFenceOpeners = (content: string): UnclosedFenceProjection => {
  let projectedContent = content;
  let sourceOffsets = Array.from({ length: content.length + 1 }, (_, index) => index);
  const escapedOpenerRanges: MarkdownRange[] = [];

  while (true) {
    const parsedMarkdownCode = parseMarkdownCode(projectedContent);
    if (parsedMarkdownCode.fencedCodePlan.unclosedRanges.length === 0) {
      const htmlProjection = projectDisallowedRawHtml(projectedContent);
      let codeRanges = parsedMarkdownCode.codeRanges;
      if (htmlProjection.content !== projectedContent) {
        const htmlFenceProjection = projectUnclosedMarkdownFenceOpeners(htmlProjection.content);
        const htmlSourceOffsets = htmlFenceProjection.sourceOffsets.map(
          offset => htmlProjection.sourceOffsets[offset] ?? offset
        );
        codeRanges = mergeOverlappingMarkdownRanges([
          ...codeRanges,
          ...htmlFenceProjection.codeRanges.map(range => ({
            start: htmlSourceOffsets[range.start] ?? range.start,
            end: htmlSourceOffsets[range.end] ?? range.end,
          })),
        ]);
      }
      return {
        codeRanges,
        content: projectedContent,
        escapedOpenerRanges,
        sourceOffsets,
      };
    }

    const projectedOpeningRanges = getProjectionOpeningRanges(
      projectedContent,
      parsedMarkdownCode.fencedCodePlan.unclosedRanges
    );
    escapedOpenerRanges.push(
      ...projectedOpeningRanges.map(range => ({
        start: sourceOffsets[range.start] ?? range.start,
        end: sourceOffsets[range.end] ?? range.end,
      }))
    );
    const projection = projectFenceOpeners(projectedContent, projectedOpeningRanges);
    projectedContent = projection.content;
    sourceOffsets = projection.sourceOffsets.map(offset => sourceOffsets[offset] ?? offset);
  }
};

export const escapeUnclosedMarkdownFenceOpeners = (content: string): string =>
  projectUnclosedMarkdownFenceOpeners(content).content;

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

const getTaskListMarkerRange = (
  content: string,
  node: MarkdownAstNode,
  nodeRange: MarkdownRange
): MarkdownRange | null => {
  if (node.type !== 'listItem' || node.checked === null || node.checked === undefined) return null;

  const lineEnd = content.indexOf('\n', nodeRange.start);
  const firstLineEnd = lineEnd === -1 ? nodeRange.end : Math.min(lineEnd, nodeRange.end);
  const taskMarker = /\[[ xX]\]/u.exec(content.slice(nodeRange.start, firstLineEnd));
  if (!taskMarker) return null;

  const markerStart = nodeRange.start + taskMarker.index;
  return { start: markerStart, end: markerStart + taskMarker[0].length };
};

const getStructuralRangesForNode = (
  content: string,
  node: MarkdownAstNode,
  nodeRange: MarkdownRange,
  sourceOffsets: number[]
): MarkdownRange[] => {
  if (node.type === 'thematicBreak' || node.type === 'footnoteReference') return [nodeRange];
  const taskMarkerRange = getTaskListMarkerRange(content, node, nodeRange);
  if (taskMarkerRange) return [taskMarkerRange];
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

interface MarkdownCollectionContext {
  analysis: MarkdownAnalysis;
  content: string;
  sourceOffsets: number[];
}

const visitMarkdownTree = (
  node: MarkdownAstNode,
  visitNode: (node: MarkdownAstNode) => void
): void => {
  visitNode(node);
  node.children?.forEach(child => {
    visitMarkdownTree(child, visitNode);
  });
};

const hasExactRange = (ranges: MarkdownRange[], range: MarkdownRange): boolean =>
  ranges.some(candidate => candidate.start === range.start && candidate.end === range.end);

type CodeRangeCollectionMode = 'append' | 'deduplicate';

const collectCodeAndMathRanges = (
  node: MarkdownAstNode,
  range: MarkdownRange,
  context: MarkdownCollectionContext,
  codeRangeMode: CodeRangeCollectionMode
): void => {
  const { analysis, content } = context;
  const shouldAddCodeRange = (codeRange: MarkdownRange): boolean =>
    codeRangeMode === 'append' || !hasExactRange(analysis.codeRanges, codeRange);

  if (node.type === 'inlineCode' && shouldAddCodeRange(range)) {
    analysis.codeRanges.push(range);
  }
  if (node.type === 'code') {
    const blockRange = expandToLineBounds(content, range);
    if (shouldAddCodeRange(blockRange)) analysis.codeRanges.push(blockRange);
  }
  if (node.type === 'math' || node.type === 'inlineMath') analysis.mathRanges.push(range);
};

const collectImageRange = (
  node: MarkdownAstNode,
  range: MarkdownRange,
  context: MarkdownCollectionContext
): void => {
  if (node.type !== 'image' && node.type !== 'imageReference') return;
  const source = context.content.slice(range.start, range.end);
  if (node.type === 'imageReference' || rendererParsesImageSource(source)) {
    context.analysis.imageRanges.push(range);
  }
};

const collectLinkRanges = (
  node: MarkdownAstNode,
  range: MarkdownRange,
  context: MarkdownCollectionContext
): void => {
  const { analysis, content, sourceOffsets } = context;
  if (node.type === 'link') {
    const source = content.slice(range.start, range.end);
    if (isAnnotationUnsafeAutolink(node, source)) {
      analysis.annotationOnlyRanges.push(range);
    } else if (!(source.startsWith('<') && source.endsWith('>'))) {
      const destinationRange = getInlineLinkDestinationRange(content, node, range, sourceOffsets);
      if (destinationRange) analysis.linkDestinationRanges.push(destinationRange);
    }
  }
  if (node.type === 'linkReference') {
    const labelRange = getReferenceLabelRange(content, node, range, sourceOffsets);
    if (labelRange) analysis.referenceLinkLabelRanges.push(labelRange);
  }
};

const collectHtmlRanges = (
  node: MarkdownAstNode,
  range: MarkdownRange,
  context: MarkdownCollectionContext,
  escapedHtmlContentRanges: MarkdownRange[]
): void => {
  if (node.type !== 'html') return;
  const source = context.content.slice(range.start, range.end);
  if (isRendererHiddenHtmlSyntax(source)) {
    context.analysis.htmlSyntaxRanges.push(range);
    return;
  }
  context.analysis.htmlSyntaxRanges.push(...getAllowedRawHtmlTagRanges(source, range.start));
  if (escapeDisallowedRawHtml(source) !== source) escapedHtmlContentRanges.push(range);
};

const collectPrimaryNodeRanges = (
  node: MarkdownAstNode,
  range: MarkdownRange,
  context: MarkdownCollectionContext,
  escapedHtmlContentRanges: MarkdownRange[]
): void => {
  const { analysis, content, sourceOffsets } = context;
  collectCodeAndMathRanges(node, range, context, 'append');
  analysis.structuralRanges.push(
    ...getStructuralRangesForNode(content, node, range, sourceOffsets)
  );
  if (node.type === 'footnoteReference') analysis.inlineBoundaryRanges.push(range);
  collectImageRange(node, range, context);
  if (node.type === 'definition') {
    analysis.referenceDefinitionRanges.push(expandToLineBounds(content, range));
  }
  collectHtmlRanges(node, range, context, escapedHtmlContentRanges);
  collectLinkRanges(node, range, context);
};

const isRangeInsideAny = (range: MarkdownRange, containers: MarkdownRange[]): boolean =>
  containers.some(container => range.start >= container.start && range.end <= container.end);

const collectEscapedHtmlNodeRanges = (
  node: MarkdownAstNode,
  range: MarkdownRange,
  context: MarkdownCollectionContext,
  escapedHtmlContentRanges: MarkdownRange[]
): void => {
  collectCodeAndMathRanges(node, range, context, 'deduplicate');
  if (!isRangeInsideAny(range, escapedHtmlContentRanges)) return;

  const { analysis, content, sourceOffsets } = context;
  if (node.type === 'html' && isRendererHiddenHtmlSyntax(content.slice(range.start, range.end))) {
    analysis.htmlSyntaxRanges.push(range);
  }
  analysis.structuralRanges.push(
    ...getStructuralRangesForNode(content, node, range, sourceOffsets)
  );
  if (node.type === 'footnoteReference') analysis.inlineBoundaryRanges.push(range);
  collectImageRange(node, range, context);
  collectLinkRanges(node, range, context);
};

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
  const fenceProjection = projectUnclosedMarkdownFenceOpeners(indentationProjection.content);
  analysis.escapedFenceOpenerRanges = fenceProjection.escapedOpenerRanges.map(range => ({
    start: indentationProjection.sourceOffsets[range.start] ?? range.start,
    end: indentationProjection.sourceOffsets[range.end] ?? range.end,
  }));
  const markdownSourceOffsets = fenceProjection.sourceOffsets.map(
    offset => indentationProjection.sourceOffsets[offset] ?? offset
  );
  const htmlProjection = projectDisallowedRawHtml(fenceProjection.content);
  const htmlProjectionSourceOffsets = htmlProjection.sourceOffsets.map(
    offset => markdownSourceOffsets[offset] ?? offset
  );
  const htmlFenceProjection = projectUnclosedMarkdownFenceOpeners(htmlProjection.content);
  analysis.escapedFenceOpenerRanges.push(
    ...htmlFenceProjection.escapedOpenerRanges.map(range => ({
      start: htmlProjectionSourceOffsets[range.start] ?? range.start,
      end: htmlProjectionSourceOffsets[range.end] ?? range.end,
    }))
  );
  const htmlSourceOffsets = htmlFenceProjection.sourceOffsets.map(
    offset => htmlProjectionSourceOffsets[offset] ?? offset
  );
  const escapedHtmlContentRanges: MarkdownRange[] = [];
  const root = markdownParser.runSync(
    markdownParser.parse(fenceProjection.content)
  ) as MarkdownAstNode;
  const primaryContext: MarkdownCollectionContext = {
    analysis,
    content,
    sourceOffsets: markdownSourceOffsets,
  };
  visitMarkdownTree(root, node => {
    const range = getNodeRange(node, markdownSourceOffsets);
    if (range) collectPrimaryNodeRanges(node, range, primaryContext, escapedHtmlContentRanges);
  });
  const htmlRoot = markdownParser.runSync(
    markdownParser.parse(htmlFenceProjection.content)
  ) as MarkdownAstNode;
  const escapedHtmlContext: MarkdownCollectionContext = {
    analysis,
    content,
    sourceOffsets: htmlSourceOffsets,
  };
  visitMarkdownTree(htmlRoot, node => {
    const range = getNodeRange(node, htmlSourceOffsets);
    if (range) {
      collectEscapedHtmlNodeRanges(node, range, escapedHtmlContext, escapedHtmlContentRanges);
    }
  });
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
  if (!content.includes('<mark') && !content.includes('</mark')) return content;
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
