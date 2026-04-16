import { stripHighlightTagsInsideMarkdownCode } from './codeRanges.ts';

const ALLOWED_RAW_HTML_TAGS = new Set(['mark']);
const SINGLE_LINE_CODE_LANGUAGES = new Map<string, string>([
  ['bash', 'bash'],
  ['c', 'c'],
  ['cpp', 'cpp'],
  ['c++', 'cpp'],
  ['css', 'css'],
  ['html', 'html'],
  ['java', 'java'],
  ['js', 'javascript'],
  ['javascript', 'javascript'],
  ['json', 'json'],
  ['lua', 'lua'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['py', 'python'],
  ['python', 'python'],
  ['sh', 'bash'],
  ['sql', 'sql'],
  ['text', 'text'],
  ['ts', 'typescript'],
  ['tsx', 'tsx'],
  ['typescript', 'typescript'],
  ['xml', 'xml'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
]);

const FENCED_BLOCK_WITH_ORPHANED_CONTINUATION_REGEX =
  /((```|~~~)[^\n]*\n[\s\S]*?\n)(\2[^\n]*\n)((?:[ \t].*\n)+)/g;
const MATH_DELIMITER_REGEX =
  /(\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\n]+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g;
const BARE_PAREN_INLINE_MATH_REGEX = /\(([^()\n]*\\[A-Za-z]+[^()\n]*)\)/g;
const SINGLE_LINE_CODE_BLOCK_REGEX = /^([A-Za-z0-9+#.-]+)\s+(.+)$/;
const CODE_LIKE_INLINE_REGEX =
  /(#include\b|std::|->|=>|::|[{}[\];]|<=|>=|==|!=|\b(?:while|for|if|else|return|const|let|var|int|float|double|bool|char|void|class|struct|template|auto)\b)/;
const CODE_DECLARATION_LINE_REGEX =
  /^(#include\b.+|using\s+namespace\b.+|template\s*<.+|(?:const|let|var|int|float|double|bool|char|void|auto|std::\w+|\w+(?:::\w+)*)[\s<].*[;{,]|}\s*;?)$/;
const CODE_CALL_OR_SIGNATURE_LINE_REGEX = /^\s*[\w:<>~*&,-][\w\s.:<>~*&,-]*\(.+\)\s*[,;:]?\s*$/;
const CODE_PARTIAL_SIGNATURE_START_REGEX = /^\s*[\w:<>~*&,-][\w\s.:<>~*&,-]*\([^)]*[,}]?\s*$/;
const CODE_PARTIAL_SIGNATURE_END_REGEX = /^\s*[\w:<>~*&,-][\w\s.:<>~*&,-]*\)\s*:\s*$/;
const CODE_CONTROL_FLOW_LINE_REGEX =
  /^\s*[{}]\s*;?\s*$|^\s*}\s*else\b.*$|^\s*(?:if|else|for|while|switch|case|default|return|break|continue)\b.*$/;

const isMarkdownStructuralLine = (trimmed: string): boolean =>
  /^(#{1,6}\s|>|\||[-*+]\s|\d+\.\s)/.test(trimmed);

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const escapeDisallowedRawHtml = (value: string): string =>
  value.replace(/<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/g, match => {
    const tagNameMatch = match.match(/^<\/?\s*([A-Za-z][A-Za-z0-9-]*)/);
    const tagName = tagNameMatch?.[1]?.toLowerCase() || '';
    return ALLOWED_RAW_HTML_TAGS.has(tagName) ? match : escapeHtml(match);
  });

const normalizeCodeFenceSpacing = (lines: string[]): string[] => {
  const normalizedLines = [...lines];

  while (normalizedLines[0] === '') {
    normalizedLines.shift();
  }

  while (normalizedLines[normalizedLines.length - 1] === '') {
    normalizedLines.pop();
  }

  return normalizedLines;
};

const isStandaloneCodeLine = (line: string): boolean => {
  const trimmed = stripInlineCodeSpans(line).trim();
  if (!trimmed) {
    return false;
  }

  if (isMarkdownStructuralLine(trimmed)) {
    return false;
  }

  return (
    CODE_DECLARATION_LINE_REGEX.test(trimmed) ||
    CODE_CALL_OR_SIGNATURE_LINE_REGEX.test(trimmed) ||
    CODE_PARTIAL_SIGNATURE_START_REGEX.test(trimmed) ||
    CODE_PARTIAL_SIGNATURE_END_REGEX.test(trimmed)
  );
};

const isCodeContinuationLine = (line: string): boolean => {
  const trimmed = stripInlineCodeSpans(line).trim();
  if (!trimmed) {
    return false;
  }

  if (isMarkdownStructuralLine(trimmed)) {
    return false;
  }

  return (
    CODE_CONTROL_FLOW_LINE_REGEX.test(trimmed) ||
    CODE_CALL_OR_SIGNATURE_LINE_REGEX.test(trimmed) ||
    CODE_PARTIAL_SIGNATURE_START_REGEX.test(trimmed) ||
    CODE_PARTIAL_SIGNATURE_END_REGEX.test(trimmed) ||
    /(?:[;{}]|->|=>|::)/.test(trimmed)
  );
};

const inferStandaloneCodeLanguage = (lines: string[]): string => {
  const joined = lines.join('\n');

  if (/#include\b|std::|using\s+namespace\b|template\s*</.test(joined)) {
    return 'cpp';
  }

  if (/\bconst\b|\blet\b|\bfunction\b|=>/.test(joined)) {
    return 'javascript';
  }

  if (/\bdef\b|\bimport\b.+:/.test(joined)) {
    return 'python';
  }

  return 'text';
};

const transformSingleLineCodeBlock = (line: string): string[] | null => {
  const trimmed = line.trim();
  const match = trimmed.match(SINGLE_LINE_CODE_BLOCK_REGEX);
  if (!match) {
    return null;
  }

  const normalizedLanguage = SINGLE_LINE_CODE_LANGUAGES.get(match[1].toLowerCase());
  const code = match[2].trim();
  if (!normalizedLanguage || !code || !CODE_LIKE_INLINE_REGEX.test(code)) {
    return null;
  }

  return [`\`\`\`${normalizedLanguage}`, code, '```'];
};

const getCodeLanguageLabel = (line: string): string | null => {
  const trimmed = line.trim().toLowerCase();
  return SINGLE_LINE_CODE_LANGUAGES.get(trimmed) || null;
};

const parseInlineCodeLead = (line: string): { code: string; language: string } | null => {
  const trimmed = line.trim();
  const match = trimmed.match(SINGLE_LINE_CODE_BLOCK_REGEX);
  if (!match) {
    return null;
  }

  const language = SINGLE_LINE_CODE_LANGUAGES.get(match[1].toLowerCase());
  const code = match[2].trim();
  if (!language || !code || !CODE_LIKE_INLINE_REGEX.test(code)) {
    return null;
  }

  return { language, code };
};

const trimCodeLine = (line: string): string => line.replace(/\s+$/u, '');

const stripInlineCodeSpans = (line: string): string => line.replace(/`[^`]+`/g, '');

const countParenBalance = (line: string): number => {
  let depth = 0;
  for (const ch of line) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return depth;
};

const collectCodeContinuationLines = (
  lines: string[],
  startIndex: number,
  initialParenDepth: number = 0
): { codeLines: string[]; lastIndex: number } => {
  const codeLines: string[] = [];
  let cursor = startIndex;
  let parenDepth = initialParenDepth;

  while (cursor < lines.length) {
    const currentLine = lines[cursor];

    if (currentLine.trim() === '') {
      const nextLine = lines[cursor + 1];
      if (parenDepth > 0 || (nextLine && isCodeContinuationLine(nextLine))) {
        codeLines.push('');
        cursor += 1;
        continue;
      }
      break;
    }

    if (parenDepth <= 0 && !isCodeContinuationLine(currentLine)) {
      break;
    }

    codeLines.push(trimCodeLine(currentLine));
    parenDepth += countParenBalance(currentLine);
    cursor += 1;
  }

  return { codeLines, lastIndex: cursor - 1 };
};

const escapeLatexTextContent = (value: string): string =>
  value
    .replace(/(?<!\\)_/g, '\\_')
    .replace(/(?<!\\)%/g, '\\%')
    .replace(/(?<!\\)#/g, '\\#')
    .replace(/(?<!\\)&/g, '\\&');

const WORD_LIKE_MATH_SCRIPT_LABEL_REGEX = /^[A-Za-z][A-Za-z0-9-]{2,}(?:\s+[A-Za-z0-9-]+)*$/;

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

const LIKELY_DISPLAY_MATH_CONTENT_REGEX =
  /(\\[A-Za-z]+|[_^=]|\\frac|\\sum|\\int|\\approx|\\cdot|\\omega|\\theta|\\alpha|\\beta|\\gamma|\\lambda)/;

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

const getDisplayMathClosingDelimiter = (line: string): '$$' | '\\]' | null => {
  const trimmed = line.trim();
  if (trimmed === '$$') {
    return '$$';
  }

  if (trimmed === '\\[') {
    return '\\]';
  }

  return null;
};

const processMarkdownSegment = (segment: string): string => {
  const lines = repairMathMarkdown(
    normalizeBareParenInlineMath(
      normalizeBackslashDelimitedMath(normalizeOrphanedBracketDisplayMath(segment))
    )
  )
    .replace(/\r/g, '')
    .split('\n');
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const displayMathClosingDelimiter = getDisplayMathClosingDelimiter(line);
    if (displayMathClosingDelimiter) {
      const mathLines = [line];
      let cursor = index + 1;

      while (cursor < lines.length) {
        const candidateLine = lines[cursor];
        mathLines.push(candidateLine);
        if (candidateLine.trim() === displayMathClosingDelimiter) {
          break;
        }
        cursor += 1;
      }

      output.push(...mathLines);
      index = cursor;
      continue;
    }

    const languageOnlyLine = getCodeLanguageLabel(line);
    if (languageOnlyLine && index + 1 < lines.length) {
      const { codeLines, lastIndex } = collectCodeContinuationLines(lines, index + 1);
      if (codeLines.length > 0) {
        output.push(
          ...normalizeCodeFenceSpacing([`\`\`\`${languageOnlyLine}`, ...codeLines, '```'])
        );
        index = lastIndex;
        continue;
      }
    }

    const inlineCodeLead = parseInlineCodeLead(line);
    if (inlineCodeLead && index + 1 < lines.length) {
      const { codeLines, lastIndex } = collectCodeContinuationLines(
        lines,
        index + 1,
        countParenBalance(inlineCodeLead.code)
      );
      if (codeLines.length > 0) {
        output.push(
          ...normalizeCodeFenceSpacing([
            `\`\`\`${inlineCodeLead.language}`,
            inlineCodeLead.code,
            ...codeLines,
            '```',
          ])
        );
        index = lastIndex;
        continue;
      }
    }

    const transformedSingleLineCode = transformSingleLineCodeBlock(line);
    if (transformedSingleLineCode) {
      output.push(...normalizeCodeFenceSpacing(transformedSingleLineCode));
      continue;
    }

    if (isStandaloneCodeLine(line)) {
      const codeLines = [trimCodeLine(line)];
      const { codeLines: continuationLines, lastIndex } = collectCodeContinuationLines(
        lines,
        index + 1,
        countParenBalance(line)
      );
      codeLines.push(...continuationLines);

      output.push(
        ...normalizeCodeFenceSpacing([
          `\`\`\`${inferStandaloneCodeLanguage(codeLines)}`,
          ...codeLines,
          '```',
        ])
      );
      index = lastIndex;
      continue;
    }

    const parts = line.split(/(`[^`]+`)/);
    output.push(
      parts.map((part, i) => (i % 2 === 1 ? part : escapeDisallowedRawHtml(part))).join('')
    );
  }

  return output.join('\n');
};

const ORPHANED_CODE_CONTINUATION_LINE_REGEX =
  /^\s*\),?\s*$|^\s*\}?\s*[A-Za-z_][\w:<>.*&-]*(?:\s*,\s*[A-Za-z_][\w:<>.*&-]*)*\s*,?\s*$/;

const isOrphanedCodeContinuationLine = (line: string): boolean => {
  const trimmed = stripInlineCodeSpans(line).trim();
  if (!trimmed || isMarkdownStructuralLine(trimmed)) {
    return false;
  }

  return ORPHANED_CODE_CONTINUATION_LINE_REGEX.test(trimmed);
};

const splitParagraphs = (lines: string[]): string[][] => {
  const paragraphs: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(current);
        current = [];
      }
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    paragraphs.push(current);
  }

  return paragraphs;
};

const isLikelyCodeParagraph = (paragraph: string[]): boolean => {
  if (paragraph.some(line => isStandaloneCodeLine(line) || isCodeContinuationLine(line))) {
    return true;
  }

  if (paragraph.some(line => isOrphanedCodeContinuationLine(line))) {
    return true;
  }

  return false;
};

const sanitizeMixedFencedCodeBlock = (
  openingFence: string,
  closingFence: string,
  bodyLines: string[]
): string => {
  const paragraphs = splitParagraphs(bodyLines);
  if (paragraphs.length === 0) {
    return [openingFence, closingFence].join('\n');
  }

  const output: string[] = [];
  let pendingCodeParagraphs: string[][] = [];

  const flushPendingCodeParagraphs = () => {
    if (pendingCodeParagraphs.length === 0) {
      return;
    }

    const codeLines = pendingCodeParagraphs.flatMap((paragraph, index) =>
      index === 0 ? paragraph : ['', ...paragraph]
    );
    output.push([openingFence, ...codeLines, closingFence].join('\n'));
    pendingCodeParagraphs = [];
  };

  for (const paragraph of paragraphs) {
    if (isLikelyCodeParagraph(paragraph)) {
      pendingCodeParagraphs.push(paragraph);
      continue;
    }

    flushPendingCodeParagraphs();
    output.push(processMarkdownSegment(paragraph.join('\n')));
  }

  flushPendingCodeParagraphs();

  return output.join('\n\n');
};

const mergeOrphanedContinuationLinesIntoPreviousFence = (content: string): string =>
  content.replace(
    FENCED_BLOCK_WITH_ORPHANED_CONTINUATION_REGEX,
    (
      match,
      codePrefix: string,
      _fenceToken: string,
      closingFenceLine: string,
      continuationBlock: string
    ) => {
      const continuationLines = continuationBlock.split('\n').filter(line => line.length > 0);
      if (
        continuationLines.length === 0 ||
        !continuationLines.every(isOrphanedCodeContinuationLine)
      ) {
        return match;
      }

      return `${codePrefix}${continuationBlock}${closingFenceLine}`;
    }
  );

const sanitizeExistingFencedCodeBlock = (block: string): string => {
  const lines = block.split('\n');
  if (lines.length < 3) {
    return block;
  }

  const openingFence = lines[0];
  const closingFence = lines[lines.length - 1];
  const bodyLines = lines.slice(1, -1);
  if (!bodyLines.some(line => isStandaloneCodeLine(line) || isCodeContinuationLine(line))) {
    return block;
  }

  return sanitizeMixedFencedCodeBlock(openingFence, closingFence, bodyLines);
};

export const normalizeMarkdownForRendering = (content: string): string => {
  const normalizedContent = stripHighlightTagsInsideMarkdownCode(content.replace(/\r/g, ''));
  const lines = normalizedContent.split('\n');
  const parts: string[] = [];
  const markdownBuffer: string[] = [];

  const flushMarkdownBuffer = () => {
    if (markdownBuffer.length === 0) {
      return;
    }

    parts.push(processMarkdownSegment(markdownBuffer.join('\n')));
    markdownBuffer.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^(```|~~~)[^\n]*$/);
    if (!fenceMatch) {
      markdownBuffer.push(line);
      continue;
    }

    flushMarkdownBuffer();

    const fenceToken = fenceMatch[1];
    const closingFenceRegex = new RegExp(`^${escapeRegExp(fenceToken)}[^\\n]*$`);
    const fencedLines = [line];
    let cursor = index + 1;
    let foundClosingFence = false;

    while (cursor < lines.length) {
      const candidateLine = lines[cursor];
      fencedLines.push(candidateLine);

      if (closingFenceRegex.test(candidateLine)) {
        foundClosingFence = true;
        break;
      }

      cursor += 1;
    }

    if (!foundClosingFence) {
      markdownBuffer.push(...fencedLines);
      index = cursor;
      continue;
    }

    parts.push(sanitizeExistingFencedCodeBlock(fencedLines.join('\n')));
    index = cursor;
  }

  flushMarkdownBuffer();

  return mergeOrphanedContinuationLinesIntoPreviousFence(parts.join('\n'));
};
