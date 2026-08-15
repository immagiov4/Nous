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

const CODE_LIKE_INLINE_REGEX =
  /(#include\b|std::|->|=>|::|[;[\]{}]|<=|>=|==|!=|\b(?:while|for|if|else|return|const|let|var|int|float|double|bool|char|void|class|struct|template|auto)\b)/;
const CODE_DECLARATION_LINE_REGEXES = [
  /^#include\b.+$/,
  /^using\s+namespace\b.+$/,
  /^template\s*<.+$/,
  /^(?:const|let|var|int|float|double|bool|char|void|auto|std::\w+)[\s<].*[,{;]$/,
  /^[A-Za-z_]\w*(?:::\w+)*[\s<].*[{;]$/,
  /^}\s*;?$/,
] as const;
const LIKELY_MATH_FUNCTION_ASSIGNMENT_REGEX =
  /^[A-Za-z](?:_[A-Za-z0-9]+)?\s*=\s*[A-Za-z](?:_[A-Za-z0-9]+)?\s*\([^;{}]*\)$/u;

const CODE_CONTROL_FLOW_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'default',
  'return',
  'break',
  'continue',
]);

const trimInlineCodeFence = (line: string, startIndex: number): number => {
  let fenceLength = 0;
  while (line[startIndex + fenceLength] === '`') {
    fenceLength += 1;
  }

  const closingFence = '`'.repeat(fenceLength);
  const closingIndex = line.indexOf(closingFence, startIndex + fenceLength);
  return closingIndex < 0 ? line.length : closingIndex + fenceLength;
};

const isIdentifierCharacter = (character: string): boolean => /[\w:<>.*&-]/u.test(character);

const startsWithWordCharacter = (value: string): boolean => /^[\w:<>~*&,-]/u.test(value);

const hasBalancedCallableShape = (trimmed: string): boolean => {
  const openParenIndex = trimmed.indexOf('(');
  const closeParenIndex = trimmed.lastIndexOf(')');
  return openParenIndex > 0 && closeParenIndex > openParenIndex;
};

const hasTrailingSignatureSuffix = (trimmed: string): boolean => {
  const suffix = trimmed.slice(trimmed.lastIndexOf(')') + 1).trim();
  return suffix === '' || suffix === ',' || suffix === ';' || suffix === ':';
};

const isCallableLikeLine = (trimmed: string): boolean =>
  startsWithWordCharacter(trimmed) &&
  hasBalancedCallableShape(trimmed) &&
  hasTrailingSignatureSuffix(trimmed);

const isPartialSignatureStartLine = (trimmed: string): boolean => {
  if (!startsWithWordCharacter(trimmed)) {
    return false;
  }

  const openParenIndex = trimmed.indexOf('(');
  if (openParenIndex <= 0 || trimmed.includes(')')) {
    return false;
  }

  const suffix = trimmed.slice(openParenIndex + 1).trimEnd();
  return suffix === '' || suffix.endsWith(',') || suffix.endsWith('}');
};

const isPartialSignatureEndLine = (trimmed: string): boolean => {
  if (!startsWithWordCharacter(trimmed)) {
    return false;
  }

  const closeParenIndex = trimmed.lastIndexOf(')');
  if (closeParenIndex <= 0) {
    return false;
  }

  return trimmed.slice(closeParenIndex).trim() === '):';
};

const isBraceOnlyLine = (trimmed: string): boolean =>
  trimmed === '{' || trimmed === '}' || trimmed === '};';

const isControlFlowLine = (trimmed: string): boolean => {
  if (isBraceOnlyLine(trimmed)) {
    return true;
  }

  if (/^\}\s*else\b/u.test(trimmed)) {
    return true;
  }

  const firstToken = trimmed.split(/\s+/u)[0]?.replace(/:$/u, '');
  return firstToken ? CODE_CONTROL_FLOW_KEYWORDS.has(firstToken) : false;
};

const isOrphanedIdentifierList = (trimmed: string): boolean => {
  let startIndex = 0;
  if (trimmed[startIndex] === '}') {
    startIndex += 1;
  }

  while (trimmed[startIndex] === ' ' || trimmed[startIndex] === '\t') {
    startIndex += 1;
  }

  let endIndex = trimmed.length;
  while (
    endIndex > startIndex &&
    (trimmed[endIndex - 1] === ' ' || trimmed[endIndex - 1] === '\t')
  ) {
    endIndex -= 1;
  }

  if (trimmed[endIndex - 1] === ',') {
    endIndex -= 1;
    while (
      endIndex > startIndex &&
      (trimmed[endIndex - 1] === ' ' || trimmed[endIndex - 1] === '\t')
    ) {
      endIndex -= 1;
    }
  }

  const normalized = trimmed.slice(startIndex, endIndex);
  if (!normalized) {
    return false;
  }

  const parts: string[] = [];
  let currentPart = '';

  for (const character of normalized) {
    if (character === ',') {
      parts.push(currentPart.trim());
      currentPart = '';
      continue;
    }

    currentPart += character;
  }

  parts.push(currentPart.trim());

  return parts.every(part => {
    if (!part || !/[A-Za-z_]/u.test(part[0])) {
      return false;
    }

    for (let index = 1; index < part.length; index += 1) {
      if (!isIdentifierCharacter(part[index])) {
        return false;
      }
    }

    return true;
  });
};

const parseSingleLineCodeLead = (line: string): { code: string; language: string } | null => {
  const trimmed = line.trim();
  const firstWhitespaceIndex = trimmed.search(/\s/u);
  if (firstWhitespaceIndex <= 0) {
    return null;
  }

  const rawLanguage = trimmed.slice(0, firstWhitespaceIndex).toLowerCase();
  const code = trimmed.slice(firstWhitespaceIndex).trim();
  const language = SINGLE_LINE_CODE_LANGUAGES.get(rawLanguage);
  if (!language || !code || !CODE_LIKE_INLINE_REGEX.test(code)) {
    return null;
  }

  return { language, code };
};

export const isMarkdownStructuralLine = (trimmed: string): boolean =>
  /^(#{1,6}\s|>|\||[-*+]\s|\d+\.\s)/.test(trimmed);

export const trimCodeLine = (line: string): string => {
  let endIndex = line.length;

  while (endIndex > 0) {
    const character = line[endIndex - 1];
    if (character !== ' ' && character !== '\t') {
      break;
    }

    endIndex -= 1;
  }

  return endIndex === line.length ? line : line.slice(0, endIndex);
};

export const stripInlineCodeSpans = (line: string): string => {
  let result = '';

  for (let index = 0; index < line.length; ) {
    if (line[index] !== '`') {
      result += line[index];
      index += 1;
      continue;
    }

    const nextIndex = trimInlineCodeFence(line, index);
    if (nextIndex === line.length) {
      result += line.slice(index);
      break;
    }

    index = nextIndex;
  }

  return result;
};

export const normalizeCodeFenceSpacing = (lines: string[]): string[] => {
  const normalizedLines = [...lines];

  while (normalizedLines[0] === '') {
    normalizedLines.shift();
  }

  while (normalizedLines.at(-1) === '') {
    normalizedLines.pop();
  }

  return normalizedLines;
};

export const isStandaloneCodeLine = (line: string): boolean => {
  const trimmed = stripInlineCodeSpans(line).trim();
  if (
    !trimmed ||
    isMarkdownStructuralLine(trimmed) ||
    LIKELY_MATH_FUNCTION_ASSIGNMENT_REGEX.test(trimmed)
  ) {
    return false;
  }

  return (
    CODE_DECLARATION_LINE_REGEXES.some(pattern => pattern.test(trimmed)) ||
    isCallableLikeLine(trimmed) ||
    isPartialSignatureStartLine(trimmed) ||
    isPartialSignatureEndLine(trimmed)
  );
};

export const isCodeContinuationLine = (line: string): boolean => {
  const trimmed = stripInlineCodeSpans(line).trim();
  if (
    !trimmed ||
    isMarkdownStructuralLine(trimmed) ||
    LIKELY_MATH_FUNCTION_ASSIGNMENT_REGEX.test(trimmed)
  ) {
    return false;
  }

  return (
    isControlFlowLine(trimmed) ||
    isCallableLikeLine(trimmed) ||
    isPartialSignatureStartLine(trimmed) ||
    isPartialSignatureEndLine(trimmed) ||
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
  const parsedLead = parseSingleLineCodeLead(line);
  if (!parsedLead) {
    return null;
  }

  return [`\`\`\`${parsedLead.language}`, parsedLead.code, '```'];
};

export const getCodeLanguageLabel = (line: string): string | null => {
  const trimmed = line.trim().toLowerCase();
  return SINGLE_LINE_CODE_LANGUAGES.get(trimmed) || null;
};

export const parseInlineCodeLead = (line: string): { code: string; language: string } | null => {
  return parseSingleLineCodeLead(line);
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

  return trimmed === ')' || trimmed === '),' || isOrphanedIdentifierList(trimmed);
};
