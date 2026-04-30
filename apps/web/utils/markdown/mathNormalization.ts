const MATH_DELIMITER_REGEX =
  /(\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\n]+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g;
const BARE_PAREN_INLINE_MATH_REGEX = /\(([^()\n]*\\[A-Za-z]+[^()\n]*)\)/g;
const WORD_LIKE_MATH_SCRIPT_LABEL_REGEX = /^[A-Za-z][A-Za-z0-9-]{2,}(?:\s+[A-Za-z0-9-]+)*$/;
const LIKELY_DISPLAY_MATH_CONTENT_REGEX =
  /(\\[A-Za-z]+|[_^=]|\\frac|\\sum|\\int|\\approx|\\cdot|\\omega|\\theta|\\alpha|\\beta|\\gamma|\\lambda)/;

const escapeLatexTextContent = (value: string): string =>
  value
    .replace(/(?<!\\)_/g, '\\_')
    .replace(/(?<!\\)%/g, '\\%')
    .replace(/(?<!\\)#/g, '\\#')
    .replace(/(?<!\\)&/g, '\\&');

const wrapWordLikeMathScriptLabel = (value: string): string | null => {
  const trimmedValue = value.trim();
  if (!WORD_LIKE_MATH_SCRIPT_LABEL_REGEX.test(trimmedValue)) {
    return null;
  }

  return `\\text{${escapeLatexTextContent(trimmedValue)}}`;
};

const normalizeWordLikeMathScripts = (value: string): string => {
  const withBracedLabelsNormalized = value.replace(
    /(?<!\\)([_^])\{([A-Za-z][A-Za-z0-9-\s]*)\}/g,
    (match, operator: string, label: string) => {
      const wrappedLabel = wrapWordLikeMathScriptLabel(label);
      return wrappedLabel ? `${operator}{${wrappedLabel}}` : match;
    }
  );

  return withBracedLabelsNormalized.replace(
    /(?<!\\)([_^])(?!\{)([A-Za-z][A-Za-z0-9-]{2,})\b/g,
    (_match, operator: string, label: string) =>
      `${operator}{\\text{${escapeLatexTextContent(label)}}}`
  );
};

const repairMathExpressionForKatex = (value: string): string =>
  normalizeWordLikeMathScripts(
    value.replace(/\\(?:text|mathrm|mathtt|operatorname)\{([^{}]*)\}/g, match => {
      const innerMatch = match.match(/^\\([A-Za-z]+)\{([^{}]*)\}$/);
      if (!innerMatch) {
        return match;
      }

      const [, command, inner] = innerMatch;
      return `\\${command}{${escapeLatexTextContent(inner)}}`;
    })
  );

const repairMathMarkdown = (segment: string): string =>
  segment.replace(MATH_DELIMITER_REGEX, expression => repairMathExpressionForKatex(expression));

const normalizeBareParenInlineMath = (segment: string): string =>
  segment
    .split(MATH_DELIMITER_REGEX)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(BARE_PAREN_INLINE_MATH_REGEX, (_, body) => `$${body}$`)
    )
    .join('');

const normalizeBackslashDelimitedMath = (segment: string): string =>
  segment
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$${body}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body}$`);

const normalizeBracketDelimitedDisplayMath = (
  segment: string,
  regex: RegExp,
  formatter: (prefix: string, body: string) => string
): string =>
  segment.replace(regex, (match, prefix: string, body: string) => {
    const trimmedBody = body.trim();
    if (!trimmedBody || !LIKELY_DISPLAY_MATH_CONTENT_REGEX.test(trimmedBody)) {
      return match;
    }

    return formatter(prefix, trimmedBody);
  });

const normalizeOrphanedBracketDisplayMath = (segment: string): string => {
  const multilineNormalized = normalizeBracketDelimitedDisplayMath(
    segment,
    /(^|\n)\[\s*\n([\s\S]*?)\n\]\s*(?=\n|$)/g,
    (prefix, body) => `${prefix}$$\n${body}\n$$`
  );

  return normalizeBracketDelimitedDisplayMath(
    multilineNormalized,
    /(^|\n)\[\s*([^\n\]]*?)\s*\]\s*(?=\n|$)/g,
    (prefix, body) => `${prefix}$$\n${body}\n$$`
  );
};

export const getDisplayMathClosingDelimiter = (line: string): '$$' | '\\]' | null => {
  const trimmed = line.trim();
  if (trimmed === '$$') {
    return '$$';
  }

  if (trimmed === '\\[') {
    return '\\]';
  }

  return null;
};

export const normalizeMathMarkdownSegment = (segment: string): string =>
  repairMathMarkdown(
    normalizeBareParenInlineMath(
      normalizeBackslashDelimitedMath(normalizeOrphanedBracketDisplayMath(segment))
    )
  );
