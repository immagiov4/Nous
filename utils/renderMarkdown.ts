import { stripHighlightTagsInsideMarkdownCode } from './markdownCodeRanges.ts';

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

const FENCED_CODE_BLOCK_REGEX = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g;
const MATH_DELIMITER_REGEX = /(\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\n]+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g;
const SINGLE_LINE_CODE_BLOCK_REGEX = /^([A-Za-z0-9+#.-]+)\s+(.+)$/;
const CODE_LIKE_INLINE_REGEX =
  /(#include\b|std::|->|=>|::|[{}[\];]|<=|>=|==|!=|\b(?:while|for|if|else|return|const|let|var|int|float|double|bool|char|void|class|struct|template|auto)\b)/;
const STANDALONE_CODE_LINE_REGEX =
  /^(#include\b.+|using\s+namespace\b.+|template\s*<.+|(?:const|let|var|int|float|double|bool|char|void|auto|std::\w+|\w+(?:::\w+)*)[\s<].*[;{]|\w+\s*\([^)]*\)\s*\{?|}\s*;?)$/;
const CODE_CONTINUATION_LINE_REGEX =
  /^(\s*[{}]\s*;?\s*|\s*}\s*else\b.*|\s*(?:if|else|for|while|switch|case|default|return|break|continue)\b.*|\s*\w[\w.:<>-]*\s*\([^)]*\)\s*;?\s*|\s*.*(?:[;{}]|->|=>|::).*)$/;

const isMarkdownStructuralLine = (trimmed: string): boolean =>
  /^(#{1,6}\s|>|\||[-*+]\s|\d+\.\s)/.test(trimmed);

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (isMarkdownStructuralLine(trimmed)) {
    return false;
  }

  return STANDALONE_CODE_LINE_REGEX.test(trimmed);
};

const isCodeContinuationLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (isMarkdownStructuralLine(trimmed)) {
    return false;
  }

  return CODE_CONTINUATION_LINE_REGEX.test(trimmed);
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

  return ['```' + normalizedLanguage, code, '```'];
};

const getCodeLanguageLabel = (line: string): string | null => {
  const trimmed = line.trim().toLowerCase();
  return SINGLE_LINE_CODE_LANGUAGES.get(trimmed) || null;
};

const parseInlineCodeLead = (
  line: string
): { code: string; language: string } | null => {
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

const collectCodeContinuationLines = (
  lines: string[],
  startIndex: number
): { codeLines: string[]; lastIndex: number } => {
  const codeLines: string[] = [];
  let cursor = startIndex;

  while (cursor < lines.length && isCodeContinuationLine(lines[cursor])) {
    codeLines.push(trimCodeLine(lines[cursor]));
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

const repairMathExpressionForKatex = (value: string): string =>
  value.replace(/\\(?:text|mathrm|mathtt|operatorname)\{([^{}]*)\}/g, match => {
    const innerMatch = match.match(/^\\([A-Za-z]+)\{([^{}]*)\}$/);
    if (!innerMatch) {
      return match;
    }

    const [, command, inner] = innerMatch;
    return `\\${command}{${escapeLatexTextContent(inner)}}`;
  });

const repairMathMarkdown = (segment: string): string =>
  segment.replace(MATH_DELIMITER_REGEX, expression => repairMathExpressionForKatex(expression));

const processMarkdownSegment = (segment: string): string => {
  const lines = repairMathMarkdown(segment).replace(/\r/g, '').split('\n');
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const languageOnlyLine = getCodeLanguageLabel(line);
    if (languageOnlyLine && index + 1 < lines.length) {
      const { codeLines, lastIndex } = collectCodeContinuationLines(lines, index + 1);
      if (codeLines.length > 0) {
        output.push(
          ...normalizeCodeFenceSpacing(['```' + languageOnlyLine, ...codeLines, '```'])
        );
        index = lastIndex;
        continue;
      }
    }

    const inlineCodeLead = parseInlineCodeLead(line);
    if (inlineCodeLead && index + 1 < lines.length) {
      const { codeLines, lastIndex } = collectCodeContinuationLines(lines, index + 1);
      if (codeLines.length > 0) {
        output.push(
          ...normalizeCodeFenceSpacing([
            '```' + inlineCodeLead.language,
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
        index + 1
      );
      codeLines.push(...continuationLines);

      output.push(
        ...normalizeCodeFenceSpacing([
          '```' + inferStandaloneCodeLanguage(codeLines),
          ...codeLines,
          '```',
        ])
      );
      index = lastIndex;
      continue;
    }

    output.push(escapeDisallowedRawHtml(line));
  }

  return output.join('\n');
};

export const normalizeMarkdownForRendering = (content: string): string => {
  const normalizedContent = stripHighlightTagsInsideMarkdownCode(content.replace(/\r/g, ''));
  const parts: string[] = [];
  let lastIndex = 0;
  let match = FENCED_CODE_BLOCK_REGEX.exec(normalizedContent);

  while (match) {
    const fenceStartIndex = match.index + (match[1]?.length || 0);
    const fenceEndIndex = match.index + match[0].length;

    if (fenceStartIndex > lastIndex) {
      parts.push(processMarkdownSegment(normalizedContent.slice(lastIndex, fenceStartIndex)));
    }

    parts.push(normalizedContent.slice(fenceStartIndex, fenceEndIndex));
    lastIndex = fenceEndIndex;
    match = FENCED_CODE_BLOCK_REGEX.exec(normalizedContent);
  }

  if (lastIndex < normalizedContent.length) {
    parts.push(processMarkdownSegment(normalizedContent.slice(lastIndex)));
  }

  return parts.join('');
};
