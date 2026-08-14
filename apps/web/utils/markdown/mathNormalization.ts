import { getMarkdownMathRangeAt } from './codeRanges.ts';

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

const normalizeBareParenInlineMathInPlainText = (plainText: string): string => {
  let normalizedText = '';
  let cursor = 0;

  while (cursor < plainText.length) {
    if (plainText[cursor] !== '(') {
      normalizedText += plainText[cursor];
      cursor += 1;
      continue;
    }

    let closingIndex = cursor + 1;
    let isValidCandidate = true;

    while (closingIndex < plainText.length && plainText[closingIndex] !== ')') {
      if (plainText[closingIndex] === '\n' || plainText[closingIndex] === '(') {
        isValidCandidate = false;
        break;
      }

      closingIndex += 1;
    }

    if (!isValidCandidate || closingIndex >= plainText.length || plainText[closingIndex] !== ')') {
      normalizedText += plainText[cursor];
      cursor += 1;
      continue;
    }

    const body = plainText.slice(cursor + 1, closingIndex);
    if (!hasLatexCommand(body)) {
      normalizedText += plainText.slice(cursor, closingIndex + 1);
      cursor = closingIndex + 1;
      continue;
    }

    normalizedText += `$${body}$`;
    cursor = closingIndex + 1;
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
