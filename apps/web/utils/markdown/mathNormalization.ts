import { getMarkdownMathRangeAt, type MarkdownMathRange } from './mathSyntax.ts';

const WORD_LIKE_MATH_SCRIPT_LABEL_REGEX = /^[A-Za-z][A-Za-z0-9-]{2,}(?:\s+[A-Za-z0-9-]+)*$/;
const LIKELY_DISPLAY_MATH_CONTENT_REGEX =
  /(\\[A-Za-z]+|[_^=]|\\frac|\\sum|\\int|\\approx|\\cdot|\\omega|\\theta|\\alpha|\\beta|\\gamma|\\lambda)/;
const BARE_DISPLAY_MATH_START_REGEX =
  /^(?:\\[A-Za-z]+|[A-Za-z](?:[_^](?:\{[^}]+\}|[A-Za-z0-9]))?\s*=)/u;

const mapMathDelimitedSegments = (
  segment: string,
  transformMathSegment: (value: string) => string,
  transformPlainText: (value: string) => string = value => value
): string => {
  let normalizedSegment = '';
  let cursor = 0;
  let plainTextStart = 0;

  while (cursor < segment.length) {
    const mathRange = getMarkdownMathRangeAt(segment, cursor);
    if (!mathRange) {
      cursor += 1;
      continue;
    }

    normalizedSegment += transformPlainText(segment.slice(plainTextStart, mathRange.start));
    normalizedSegment += transformMathSegment(segment.slice(mathRange.start, mathRange.end));
    cursor = mathRange.end;
    plainTextStart = cursor;
  }

  normalizedSegment += transformPlainText(segment.slice(plainTextStart));
  return normalizedSegment;
};

const hasLatexCommand = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') {
      continue;
    }

    const nextCharacter = value[index + 1];
    if (!nextCharacter || !/[A-Za-z]/u.test(nextCharacter)) {
      continue;
    }

    return true;
  }

  return false;
};

interface BareParenMathCandidate {
  body: string;
  end: number;
}

const readBareParenMathCandidate = (
  plainText: string,
  start: number
): BareParenMathCandidate | null => {
  if (plainText[start] !== '(') return null;

  let closingIndex = start + 1;
  while (closingIndex < plainText.length && plainText[closingIndex] !== ')') {
    if (plainText[closingIndex] === '\n' || plainText[closingIndex] === '(') return null;
    closingIndex += 1;
  }

  if (closingIndex >= plainText.length || plainText[closingIndex] !== ')') return null;
  const body = plainText.slice(start + 1, closingIndex);
  return hasLatexCommand(body) ? { body, end: closingIndex + 1 } : null;
};

const normalizeBareParenInlineMathInPlainText = (plainText: string): string => {
  let normalizedText = '';
  let cursor = 0;

  while (cursor < plainText.length) {
    const candidate = readBareParenMathCandidate(plainText, cursor);
    if (!candidate) {
      normalizedText += plainText[cursor];
      cursor += 1;
      continue;
    }
    normalizedText += `$${candidate.body}$`;
    cursor = candidate.end;
  }

  return normalizedText;
};

const escapeLatexTextContent = (value: string): string =>
  value
    .replaceAll(/(?<!\\)_/g, String.raw`\_`)
    .replaceAll(/(?<!\\)%/g, String.raw`\%`)
    .replaceAll(/(?<!\\)#/g, String.raw`\#`)
    .replaceAll(/(?<!\\)&/g, String.raw`\&`);

const collapseDoubleEscapedLatexCommands = (value: string): string =>
  value.replaceAll(/\\\\(?=[A-Za-z])/g, '\\');

const LATEX_ENVIRONMENT_TOKEN_REGEX = /\\(begin|end)\{([A-Za-z][A-Za-z0-9*]*)\}/g;

const hasUnbalancedLatexEnvironment = (value: string): boolean => {
  const environments: string[] = [];
  for (const match of value.matchAll(LATEX_ENVIRONMENT_TOKEN_REGEX)) {
    const [, operation, environment] = match;
    if (operation === 'begin') {
      environments.push(environment as string);
      continue;
    }
    if (environments.pop() !== environment) {
      return true;
    }
  }
  return environments.length > 0;
};

const literalizeUnbalancedInlineLatexEnvironment = (expression: string): string | null => {
  if (!expression.startsWith('$') || expression.startsWith('$$') || !expression.endsWith('$')) {
    return null;
  }
  const body = collapseDoubleEscapedLatexCommands(expression.slice(1, -1));
  return hasUnbalancedLatexEnvironment(body) ? `\`${body}\`` : null;
};

const wrapWordLikeMathScriptLabel = (value: string): string | null => {
  const trimmedValue = value.trim();
  if (!WORD_LIKE_MATH_SCRIPT_LABEL_REGEX.test(trimmedValue)) {
    return null;
  }

  return String.raw`\text{${escapeLatexTextContent(trimmedValue)}}`;
};

const normalizeWordLikeMathScripts = (value: string): string => {
  const withBracedLabelsNormalized = value.replaceAll(
    /(?<!\\)([_^])\{([A-Za-z][A-Za-z0-9-\s]*)\}/g,
    (match, operator: string, label: string) => {
      const wrappedLabel = wrapWordLikeMathScriptLabel(label);
      return wrappedLabel ? `${operator}{${wrappedLabel}}` : match;
    }
  );

  return withBracedLabelsNormalized.replaceAll(
    /(?<!\\)([_^])(?!\{)([A-Za-z][A-Za-z0-9-]{2,})\b/g,
    (_match, operator: string, label: string) =>
      String.raw`${operator}{\text{${escapeLatexTextContent(label)}}}`
  );
};

const repairMathExpressionForKatex = (value: string): string =>
  normalizeWordLikeMathScripts(
    collapseDoubleEscapedLatexCommands(value).replaceAll(
      /\\(?:text|mathrm|mathtt|operatorname)\{([^{}]*)\}/g,
      match => {
        const innerMatch = match.match(/^\\([A-Za-z]+)\{([^{}]*)\}$/);
        if (!innerMatch) {
          return match;
        }

        const [, command, inner] = innerMatch;
        return `\\${command}{${escapeLatexTextContent(inner)}}`;
      }
    )
  );

const repairMathMarkdown = (segment: string): string =>
  mapMathDelimitedSegments(
    segment,
    expression =>
      literalizeUnbalancedInlineLatexEnvironment(expression) ??
      repairMathExpressionForKatex(expression)
  );

const normalizeBareParenInlineMath = (segment: string): string =>
  mapMathDelimitedSegments(
    segment,
    expression => expression,
    plainText => normalizeBareParenInlineMathInPlainText(plainText)
  );

const normalizeBackslashDelimitedMath = (segment: string): string =>
  mapMathDelimitedSegments(segment, expression => {
    if (expression.startsWith(String.raw`\[`) && expression.endsWith(String.raw`\]`)) {
      return `$$${expression.slice(2, -2)}$$`;
    }

    if (expression.startsWith(String.raw`\(`) && expression.endsWith(String.raw`\)`)) {
      return `$${expression.slice(2, -2)}$`;
    }

    return expression;
  });

const hasLikelyDisplayMathContent = (value: string): boolean =>
  LIKELY_DISPLAY_MATH_CONTENT_REGEX.test(value);

const normalizeBareDisplayMathLine = (line: string): string[] | null => {
  const trimmedLine = line.trim();
  if (!trimmedLine) {
    return null;
  }

  const normalizedLine = collapseDoubleEscapedLatexCommands(trimmedLine);
  if (
    !BARE_DISPLAY_MATH_START_REGEX.test(normalizedLine) ||
    !hasLatexCommand(normalizedLine) ||
    !hasLikelyDisplayMathContent(normalizedLine)
  ) {
    return null;
  }

  return ['$$', normalizedLine, '$$'];
};

const normalizeBareDisplayMath = (segment: string): string =>
  mapMathDelimitedSegments(
    segment,
    expression => expression,
    plainText =>
      plainText
        .split('\n')
        .flatMap(line => normalizeBareDisplayMathLine(line) ?? [line])
        .join('\n')
  );

interface OrphanedBracketMathCandidate {
  body: string;
  lastIndex: number;
  nextIndex: number;
}

const buildDisplayMathReplacement = (body: string): string[] | null => {
  const trimmedBody = body.trim();
  return trimmedBody && hasLikelyDisplayMathContent(trimmedBody) ? ['$$', trimmedBody, '$$'] : null;
};

const getNextLineIndex = (lines: string[], index: number): number =>
  index + (lines[index + 1] === '' ? 2 : 1);

const readMultilineBracketMathCandidate = (
  lines: string[],
  startIndex: number
): OrphanedBracketMathCandidate | null => {
  if (lines[startIndex] !== '[') {
    return null;
  }

  const bodyLines: string[] = [];
  let closingIndex = startIndex + 1;

  while (closingIndex < lines.length && lines[closingIndex] !== ']') {
    bodyLines.push(lines[closingIndex]);
    closingIndex += 1;
  }

  if (closingIndex >= lines.length) {
    return null;
  }

  return {
    body: bodyLines.join('\n'),
    lastIndex: closingIndex,
    nextIndex: getNextLineIndex(lines, closingIndex),
  };
};

const readSingleLineBracketMathCandidate = (
  lines: string[],
  startIndex: number
): OrphanedBracketMathCandidate | null => {
  const line = lines[startIndex];
  if (!line.startsWith('[') || !line.endsWith(']')) {
    return null;
  }

  return {
    body: line.slice(1, -1),
    lastIndex: startIndex,
    nextIndex: getNextLineIndex(lines, startIndex),
  };
};

const readOrphanedBracketMathCandidate = (
  lines: string[],
  startIndex: number
): OrphanedBracketMathCandidate | null =>
  readMultilineBracketMathCandidate(lines, startIndex) ??
  readSingleLineBracketMathCandidate(lines, startIndex);

const normalizeOrphanedBracketDisplayMath = (segment: string): string => {
  const lines = segment.split('\n');
  const normalizedLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const candidate = readOrphanedBracketMathCandidate(lines, index);
    const replacement = candidate ? buildDisplayMathReplacement(candidate.body) : null;
    if (candidate && replacement) {
      normalizedLines.push(...replacement);
      index = candidate.nextIndex;
      continue;
    }

    normalizedLines.push(lines[index]);
    index += 1;
  }

  return normalizedLines.join('\n');
};

const getLineStartOffsets = (lines: string[]): number[] => {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
};

const collectDelimitedMathRanges = (segment: string): MarkdownMathRange[] => {
  const ranges: MarkdownMathRange[] = [];
  let cursor = 0;
  while (cursor < segment.length) {
    const range = getMarkdownMathRangeAt(segment, cursor);
    if (range) {
      ranges.push(range);
      cursor = range.end;
    } else {
      cursor += 1;
    }
  }
  return ranges;
};

const collectBareParenMathRanges = (
  segment: string,
  delimitedRanges: MarkdownMathRange[]
): MarkdownMathRange[] => {
  const ranges: MarkdownMathRange[] = [];
  let cursor = 0;
  let delimitedIndex = 0;

  while (cursor < segment.length) {
    const delimitedRange = delimitedRanges[delimitedIndex];
    if (delimitedRange && cursor >= delimitedRange.start) {
      cursor = delimitedRange.end;
      delimitedIndex += 1;
      continue;
    }
    const candidate = readBareParenMathCandidate(segment, cursor);
    if (candidate && (!delimitedRange || candidate.end <= delimitedRange.start)) {
      ranges.push({ start: cursor, end: candidate.end });
      cursor = candidate.end;
      continue;
    }
    cursor += 1;
  }
  return ranges;
};

const collectLineNormalizedMathRanges = (
  segment: string,
  delimitedRanges: MarkdownMathRange[]
): MarkdownMathRange[] => {
  const lines = segment.split('\n');
  const lineStarts = getLineStartOffsets(lines);
  const ranges: MarkdownMathRange[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const orphanedCandidate = readOrphanedBracketMathCandidate(lines, index);
    if (orphanedCandidate && buildDisplayMathReplacement(orphanedCandidate.body)) {
      ranges.push({
        start: lineStarts[index],
        end: lineStarts[orphanedCandidate.lastIndex] + lines[orphanedCandidate.lastIndex].length,
      });
      index = orphanedCandidate.nextIndex - 1;
      continue;
    }

    const lineStart = lineStarts[index];
    const lineEnd = lineStart + lines[index].length;
    let plainStart = lineStart;
    const lineDelimitedRanges = delimitedRanges.filter(
      range => range.start < lineEnd && range.end > lineStart
    );
    for (const delimitedRange of lineDelimitedRanges) {
      const plainEnd = Math.min(delimitedRange.start, lineEnd);
      const plainText = segment.slice(plainStart, plainEnd);
      if (normalizeBareDisplayMathLine(plainText)) {
        ranges.push({
          start: plainStart + plainText.length - plainText.trimStart().length,
          end: plainEnd - (plainText.length - plainText.trimEnd().length),
        });
      }
      plainStart = Math.max(plainStart, delimitedRange.end);
    }
    const trailingPlainText = segment.slice(plainStart, lineEnd);
    if (normalizeBareDisplayMathLine(trailingPlainText)) {
      ranges.push({
        start: plainStart + trailingPlainText.length - trailingPlainText.trimStart().length,
        end: lineEnd - (trailingPlainText.length - trailingPlainText.trimEnd().length),
      });
    }
  }
  return ranges;
};

const mergeMathRanges = (ranges: MarkdownMathRange[]): MarkdownMathRange[] => {
  const merged: MarkdownMathRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
};

export const getRenderedMathSourceRanges = (segment: string): MarkdownMathRange[] => {
  const delimitedRanges = collectDelimitedMathRanges(segment);
  return mergeMathRanges([
    ...delimitedRanges,
    ...collectBareParenMathRanges(segment, delimitedRanges),
    ...collectLineNormalizedMathRanges(segment, delimitedRanges),
  ]);
};

export const getDisplayMathClosingDelimiter = (line: string): '$$' | '\\]' | null => {
  const trimmed = line.trim();
  if (trimmed === '$$') {
    return '$$';
  }

  if (trimmed === String.raw`\[`) {
    return String.raw`\]` as '\\]';
  }

  return null;
};

export const normalizeMathMarkdownSegment = (segment: string): string =>
  repairMathMarkdown(
    normalizeBareParenInlineMath(
      normalizeBareDisplayMath(
        normalizeBackslashDelimitedMath(normalizeOrphanedBracketDisplayMath(segment))
      )
    )
  );
