const stripBracketedSegment = (
  source: string,
  startIndex: number,
  openCharacter: string,
  closeCharacter: string
): number | null => {
  let depth = 0;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === openCharacter) {
      depth += 1;
      continue;
    }
    if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return null;
};

const stripHtmlTag = (source: string, startIndex: number): number | null => {
  const endIndex = source.indexOf('>', startIndex + 1);
  return endIndex >= 0 ? endIndex + 1 : null;
};

const stripPdfImageToken = (source: string, startIndex: number): number | null => {
  const endIndex = source.indexOf('}}', startIndex + 2);
  return endIndex >= 0 ? endIndex + 2 : null;
};

const appendCollapsedWhitespace = (parts: string[], character: string) => {
  if (character === '\n' || character === '\r' || character === '\t' || character === ' ') {
    if (parts[parts.length - 1] !== ' ') {
      parts.push(' ');
    }
    return;
  }

  parts.push(character);
};

const MARKDOWN_FORMATTING_MARKERS = '*_#>|[]()`~';

interface MarkdownSimilarityToken {
  nextIndex: number;
  replacement: string;
}

const readImageToken = (value: string, index: number): MarkdownSimilarityToken | null => {
  if (value[index] !== '!') {
    return null;
  }

  const imageAltEnd = stripBracketedSegment(value, index + 1, '[', ']');
  if (imageAltEnd === null || value[imageAltEnd] !== '(') {
    return null;
  }

  const imageUrlEnd = stripBracketedSegment(value, imageAltEnd, '(', ')');
  return imageUrlEnd === null ? null : { nextIndex: imageUrlEnd, replacement: ' ' };
};

const readLinkToken = (value: string, index: number): MarkdownSimilarityToken | null => {
  if (value[index] !== '[') {
    return null;
  }

  const linkTextEnd = stripBracketedSegment(value, index, '[', ']');
  if (linkTextEnd === null || value[linkTextEnd] !== '(') {
    return null;
  }

  const linkUrlEnd = stripBracketedSegment(value, linkTextEnd, '(', ')');
  return linkUrlEnd === null ? null : { nextIndex: linkUrlEnd, replacement: ' ' };
};

const readSkippableMarkdownToken = (
  value: string,
  index: number
): MarkdownSimilarityToken | null => {
  if (value.startsWith('{{PDF_IMAGE:', index)) {
    const nextIndex = stripPdfImageToken(value, index);
    return nextIndex === null ? null : { nextIndex, replacement: ' ' };
  }

  if (value[index] === '<') {
    const nextIndex = stripHtmlTag(value, index);
    return nextIndex === null ? null : { nextIndex, replacement: ' ' };
  }

  return readImageToken(value, index) ?? readLinkToken(value, index);
};

export const stripMarkdownForSimilarity = (value: string): string => {
  const parts: string[] = [];

  for (let index = 0; index < value.length; ) {
    const token = readSkippableMarkdownToken(value, index);
    if (token) {
      appendCollapsedWhitespace(parts, token.replacement);
      index = token.nextIndex;
      continue;
    }

    const character = value[index];
    if (MARKDOWN_FORMATTING_MARKERS.includes(character)) {
      appendCollapsedWhitespace(parts, ' ');
      index += 1;
      continue;
    }

    appendCollapsedWhitespace(parts, character);
    index += 1;
  }

  return parts.join('').replace(/\s+/g, ' ').trim();
};

export const hasBrokenDisplayMathBracketBlock = (value: string): boolean => {
  const lines = value.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== '[') {
      continue;
    }

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor]?.trim() === ']') {
        return true;
      }
    }
  }

  return false;
};

export const hasBrokenKatexDelimiterLine = (value: string): boolean =>
  value.split('\n').some(line => {
    const trimmed = line.trim();
    return trimmed === '[' || trimmed === ']';
  });

const PSEUDOCODE_KEYWORD_PREFIXES = ['ELSE', 'FOR', 'IF', 'RETURN', 'WHILE'];

const looksLikePseudocodeLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed === '}') {
    return true;
  }

  if (PSEUDOCODE_KEYWORD_PREFIXES.some(keyword => trimmed.startsWith(keyword))) {
    return true;
  }

  return /^[A-Za-z_]\w*\(/u.test(trimmed) || /^[A-Za-z_]\w*\s*=/u.test(trimmed);
};

const findTextFenceEnd = (
  lines: string[],
  startIndex: number
): {
  hasPseudocode: boolean;
  index: number;
} => {
  let cursor = startIndex + 1;
  let hasPseudocode = false;

  while (cursor < lines.length && lines[cursor]?.trim() !== '```') {
    hasPseudocode ||= looksLikePseudocodeLine(lines[cursor] || '');
    cursor += 1;
  }

  return { hasPseudocode, index: cursor };
};

const hasPseudocodeBeforeNextTextFence = (
  lines: string[],
  startIndex: number,
  maxLineCount: number
): boolean => {
  let lookahead = startIndex;
  let interstitialLineCount = 0;
  let foundPseudocodeOutsideFence = false;

  while (lookahead < lines.length && interstitialLineCount <= maxLineCount) {
    const line = lines[lookahead] || '';
    const trimmed = line.trim();
    if (trimmed === '```text') {
      return foundPseudocodeOutsideFence;
    }

    if (looksLikePseudocodeLine(trimmed) || (trimmed.length > 0 && /^\s+\S/u.test(line))) {
      foundPseudocodeOutsideFence = true;
    }

    interstitialLineCount += 1;
    lookahead += 1;
  }

  return false;
};

export const hasSplitTextPseudocodeFence = (value: string): boolean => {
  const lines = value.split('\n');
  let index = 0;

  while (index < lines.length) {
    if (lines[index]?.trim() !== '```text') {
      index += 1;
      continue;
    }

    const currentFence = findTextFenceEnd(lines, index);

    if (!currentFence.hasPseudocode || currentFence.index >= lines.length) {
      index = currentFence.index + 1;
      continue;
    }

    if (hasPseudocodeBeforeNextTextFence(lines, currentFence.index + 1, 40)) {
      return true;
    }

    index = currentFence.index + 1;
  }

  return false;
};
