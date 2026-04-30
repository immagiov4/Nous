export const SINGLE_LINE_CODE_LANGUAGES = new Map<string, string>([
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
const ORPHANED_CODE_CONTINUATION_LINE_REGEX =
  /^\s*\),?\s*$|^\s*\}?\s*[A-Za-z_][\w:<>.*&-]*(?:\s*,\s*[A-Za-z_][\w:<>.*&-]*)*\s*,?\s*$/;

export const isMarkdownStructuralLine = (trimmed: string): boolean =>
  /^(#{1,6}\s|>|\||[-*+]\s|\d+\.\s)/.test(trimmed);

export const trimCodeLine = (line: string): string => line.replace(/\s+$/u, '');

export const stripInlineCodeSpans = (line: string): string => line.replace(/`[^`]+`/g, '');

export const normalizeCodeFenceSpacing = (lines: string[]): string[] => {
  const normalizedLines = [...lines];

  while (normalizedLines[0] === '') {
    normalizedLines.shift();
  }

  while (normalizedLines[normalizedLines.length - 1] === '') {
    normalizedLines.pop();
  }

  return normalizedLines;
};

export const isStandaloneCodeLine = (line: string): boolean => {
  const trimmed = stripInlineCodeSpans(line).trim();
  if (!trimmed || isMarkdownStructuralLine(trimmed)) {
    return false;
  }

  return (
    CODE_DECLARATION_LINE_REGEX.test(trimmed) ||
    CODE_CALL_OR_SIGNATURE_LINE_REGEX.test(trimmed) ||
    CODE_PARTIAL_SIGNATURE_START_REGEX.test(trimmed) ||
    CODE_PARTIAL_SIGNATURE_END_REGEX.test(trimmed)
  );
};

export const isCodeContinuationLine = (line: string): boolean => {
  const trimmed = stripInlineCodeSpans(line).trim();
  if (!trimmed || isMarkdownStructuralLine(trimmed)) {
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

export const inferStandaloneCodeLanguage = (lines: string[]): string => {
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

export const transformSingleLineCodeBlock = (line: string): string[] | null => {
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

export const getCodeLanguageLabel = (line: string): string | null => {
  const trimmed = line.trim().toLowerCase();
  return SINGLE_LINE_CODE_LANGUAGES.get(trimmed) || null;
};

export const parseInlineCodeLead = (line: string): { code: string; language: string } | null => {
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

export const countParenBalance = (line: string): number => {
  let depth = 0;
  for (const ch of line) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return depth;
};

export const collectCodeContinuationLines = (
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

export const isOrphanedCodeContinuationLine = (line: string): boolean => {
  const trimmed = stripInlineCodeSpans(line).trim();
  if (!trimmed || isMarkdownStructuralLine(trimmed)) {
    return false;
  }

  return ORPHANED_CODE_CONTINUATION_LINE_REGEX.test(trimmed);
};
