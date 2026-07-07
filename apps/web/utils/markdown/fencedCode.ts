import {
  isCodeContinuationLine,
  isMarkdownStructuralLine,
  isOrphanedCodeContinuationLine,
  isStandaloneCodeLine,
  normalizeCodeFenceSpacing,
  stripInlineCodeSpans,
  trimCodeLine,
} from './codeHeuristics.ts';
import { escapeRegExp } from './html.ts';
import { processMarkdownSegment } from './segment.ts';

type FenceToken = '```' | '~~~';

interface FencedBlock {
  openingLine: string;
  bodyLines: string[];
  closingLine: string;
  lastIndex: number;
  token: FenceToken;
}

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

export const mergeOrphanedContinuationLinesIntoPreviousFence = (content: string): string => {
  const lines = content.split('\n');
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const block = parseFencedBlockAt(lines, index);
    if (!block) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    let continuationCursor = block.lastIndex + 1;
    const continuationLines: string[] = [];
    while (
      continuationCursor < lines.length &&
      /^[ \t]/u.test(lines[continuationCursor] || '') &&
      lines[continuationCursor] !== ''
    ) {
      continuationLines.push(lines[continuationCursor]);
      continuationCursor += 1;
    }

    const shouldMerge =
      continuationLines.length > 0 && continuationLines.every(isOrphanedCodeContinuationLine);

    output.push(block.openingLine);
    output.push(...block.bodyLines);
    if (shouldMerge) {
      output.push(...continuationLines);
      output.push(block.closingLine);
      index = continuationCursor;
      continue;
    }

    output.push(block.closingLine);
    index = block.lastIndex + 1;
  }

  return output.join('\n');
};

export const getFenceToken = (line: string): FenceToken | null => {
  const match = line.match(/^(```|~~~)[^\n]*$/);
  return match ? (match[1] as FenceToken) : null;
};

export const parseFencedBlockAt = (lines: string[], startIndex: number): FencedBlock | null => {
  const token = getFenceToken(lines[startIndex]);
  if (!token) {
    return null;
  }

  const closingFenceRegex = new RegExp(`^${escapeRegExp(token)}[^\n]*$`);
  for (let cursor = startIndex + 1; cursor < lines.length; cursor += 1) {
    if (closingFenceRegex.test(lines[cursor])) {
      return {
        openingLine: lines[startIndex],
        bodyLines: lines.slice(startIndex + 1, cursor),
        closingLine: lines[cursor],
        lastIndex: cursor,
        token,
      };
    }
  }

  return null;
};

const getLastNonEmptyLine = (lines: string[]): string =>
  [...lines].reverse().find(line => line.trim().length > 0) || '';

const splitLeadingClosingBraceLines = (
  lines: string[]
): { braceLines: string[]; remainderLines: string[] } | null => {
  const braceLines: string[] = [];
  let cursor = 0;

  while (cursor < lines.length && lines[cursor].trim() === '') {
    cursor += 1;
  }

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!['}', '};'].includes(stripInlineCodeSpans(line).trim())) {
      break;
    }

    braceLines.push(trimCodeLine(line));
    cursor += 1;
  }

  if (braceLines.length === 0) {
    return null;
  }

  const remainderLines = lines.slice(cursor);
  while (remainderLines[0]?.trim() === '') {
    remainderLines.shift();
  }

  return { braceLines, remainderLines };
};

const isMergeableSplitBraceCodeLine = (line: string): boolean => {
  const trimmed = stripInlineCodeSpans(line).trim();
  if (!trimmed || isMarkdownStructuralLine(trimmed)) {
    return false;
  }

  return trimmed.length <= 100 && !/[.!?]$/.test(trimmed);
};

const isTextPseudocodeFence = (block: FencedBlock): boolean =>
  /^(```|~~~)text\s*$/i.test(block.openingLine.trim());

const isClosingElsePseudocodeLine = (trimmed: string): boolean => {
  if (!trimmed.startsWith('}')) {
    return false;
  }

  let cursor = 1;
  while (cursor < trimmed.length && trimmed[cursor] === ' ') {
    cursor += 1;
  }

  if (cursor === trimmed.length) {
    return true;
  }

  const elseKeyword = 'ELSE';
  if (!trimmed.slice(cursor).toUpperCase().startsWith(elseKeyword)) {
    return false;
  }

  cursor += elseKeyword.length;
  while (cursor < trimmed.length && trimmed[cursor] === ' ') {
    cursor += 1;
  }

  return trimmed.slice(cursor) === '{';
};

const isPseudocodeLine = (line: string): boolean => {
  const trimmed = stripInlineCodeSpans(line).trim();
  if (!trimmed || isMarkdownStructuralLine(trimmed)) {
    return false;
  }

  return (
    /^\s+\S/.test(line) ||
    isClosingElsePseudocodeLine(trimmed) ||
    /^(?:IF|ELSE|FOR|WHILE|RETURN)\b/i.test(trimmed) ||
    /^[A-Za-z_][\w]*\s*=/.test(trimmed) ||
    /^[A-Za-z_][\w]*\([^)]*\)\s*$/.test(trimmed)
  );
};

const isPseudocodeFenceBlock = (block: FencedBlock): boolean => {
  if (!isTextPseudocodeFence(block)) {
    return false;
  }

  const nonEmptyBodyLines = block.bodyLines.filter(line => line.trim().length > 0);
  return nonEmptyBodyLines.length > 0 && nonEmptyBodyLines.every(isPseudocodeLine);
};

const appendPseudocodeLines = (target: string[], lines: string[]) => {
  const normalizedLines = lines.filter(line => line.trim().length > 0).map(trimCodeLine);
  target.push(...normalizedLines);
};

export const mergeSplitTextPseudocodeBlocks = (content: string): string => {
  const lines = content.split('\n');
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const block = parseFencedBlockAt(lines, index);
    if (!block || !isPseudocodeFenceBlock(block)) {
      output.push(lines[index]);
      continue;
    }

    const mergedBody = [...block.bodyLines];
    let cursor = block.lastIndex + 1;
    let didMerge = false;
    let pendingLines: string[] = [];

    while (cursor < lines.length) {
      const currentLine = lines[cursor];
      if (currentLine.trim() === '') {
        pendingLines.push(currentLine);
        cursor += 1;
        continue;
      }

      const nextBlock = parseFencedBlockAt(lines, cursor);
      if (nextBlock) {
        if (!isPseudocodeFenceBlock(nextBlock)) {
          break;
        }

        const pendingCodeLines = pendingLines.filter(line => line.trim().length > 0);
        if (!pendingCodeLines.every(isPseudocodeLine)) {
          break;
        }

        appendPseudocodeLines(mergedBody, pendingLines);
        mergedBody.push(...nextBlock.bodyLines);
        didMerge = true;
        pendingLines = [];
        cursor = nextBlock.lastIndex + 1;
        continue;
      }

      if (!isPseudocodeLine(currentLine)) {
        break;
      }

      pendingLines.push(currentLine);
      cursor += 1;
    }

    const trailingCodeLines = pendingLines.filter(line => line.trim().length > 0);
    const shouldPreserveTrailingSeparator =
      pendingLines.some(line => line.trim() === '') &&
      cursor < lines.length &&
      lines[cursor]?.trim().length > 0;
    if (trailingCodeLines.length > 0 && trailingCodeLines.every(isPseudocodeLine)) {
      appendPseudocodeLines(mergedBody, pendingLines);
      didMerge = true;
    }

    if (!didMerge) {
      output.push(...lines.slice(index, block.lastIndex + 1));
      index = block.lastIndex;
      continue;
    }

    output.push(
      block.openingLine,
      ...normalizeCodeFenceSpacing(mergedBody),
      block.closingLine,
      ...(shouldPreserveTrailingSeparator ? [''] : [])
    );
    index = cursor - 1;
  }

  return output.join('\n');
};

export const mergeSplitBraceFencedBlocks = (content: string): string => {
  const lines = content.split('\n');
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const block = parseFencedBlockAt(lines, index);
    const lastBodyLine = block ? getLastNonEmptyLine(block.bodyLines) : '';
    if (!block || !lastBodyLine.trimEnd().endsWith('{')) {
      output.push(lines[index]);
      continue;
    }

    let cursor = block.lastIndex + 1;
    const middleLines: string[] = [];

    while (cursor < lines.length) {
      const candidateLine = lines[cursor];
      if (candidateLine.trim() === '') {
        cursor += 1;
        continue;
      }

      const closingBraceBlock = parseFencedBlockAt(lines, cursor);
      if (closingBraceBlock) {
        const closingBraceParts = splitLeadingClosingBraceLines(closingBraceBlock.bodyLines);
        if (middleLines.length > 0 && closingBraceParts) {
          output.push(
            block.openingLine,
            ...block.bodyLines,
            ...middleLines,
            ...closingBraceParts.braceLines,
            block.closingLine
          );
          if (closingBraceParts.remainderLines.length > 0) {
            output.push('', processMarkdownSegment(closingBraceParts.remainderLines.join('\n')));
          }
          index = closingBraceBlock.lastIndex;
        } else {
          output.push(lines[index]);
        }
        break;
      }

      if (middleLines.length >= 6 || !isMergeableSplitBraceCodeLine(candidateLine)) {
        output.push(lines[index]);
        break;
      }

      middleLines.push(trimCodeLine(candidateLine));
      cursor += 1;
    }

    if (cursor >= lines.length) {
      output.push(lines[index]);
    }
  }

  return output.join('\n');
};

export const sanitizeExistingFencedCodeBlock = (block: string): string => {
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
