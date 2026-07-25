import { stripHighlightTagsInsideMarkdownCode } from './codeRanges.ts';
import {
  getFenceToken,
  mergeOrphanedContinuationLinesIntoPreviousFence,
  mergeSplitBraceFencedBlocks,
  mergeSplitTextPseudocodeBlocks,
  parseFencedBlockAt,
  sanitizeExistingFencedCodeBlock,
} from './fencedCode.ts';
import { processMarkdownSegment } from './segment.ts';

const DELETE_CONTROL_CHARACTER = '\u007f';
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

const applyPostFenceRepairs = (content: string): string =>
  mergeSplitTextPseudocodeBlocks(
    mergeSplitBraceFencedBlocks(mergeOrphanedContinuationLinesIntoPreviousFence(content))
  );

const isJsonContainer = (value: unknown): boolean =>
  Array.isArray(value) || (typeof value === 'object' && value !== null);

const findJsonStartBeforeOrphanedFence = (lines: string[], fenceIndex: number): number | null => {
  let jsonEndIndex = fenceIndex - 1;
  while (jsonEndIndex >= 0 && lines[jsonEndIndex].trim() === '') {
    jsonEndIndex -= 1;
  }

  if (jsonEndIndex < 0 || !/[}\]]\s*$/u.test(lines[jsonEndIndex])) {
    return null;
  }

  for (let startIndex = jsonEndIndex; startIndex >= 0; startIndex -= 1) {
    const firstCharacter = lines[startIndex].trimStart()[0];
    if (firstCharacter !== '{' && firstCharacter !== '[') {
      continue;
    }

    try {
      const parsed = JSON.parse(lines.slice(startIndex, jsonEndIndex + 1).join('\n'));
      if (isJsonContainer(parsed)) {
        return startIndex;
      }
    } catch {
      // Keep searching: the closest opening brace may belong to a nested value.
    }
  }

  return null;
};

const restoreMissingJsonOpeningFences = (content: string): string => {
  const lines = content.split('\n');

  for (let fenceIndex = 0; fenceIndex < lines.length; fenceIndex += 1) {
    if (!/^```[\t ]*$/u.test(lines[fenceIndex])) {
      continue;
    }

    const jsonStartIndex = findJsonStartBeforeOrphanedFence(lines, fenceIndex);
    if (jsonStartIndex !== null) {
      lines.splice(jsonStartIndex, 0, '```json');
      fenceIndex += 1;
      continue;
    }

    const parsedBlock = parseFencedBlockAt(lines, fenceIndex);
    if (parsedBlock) {
      fenceIndex = parsedBlock.lastIndex;
    }
  }

  return lines.join('\n');
};

export const normalizeMarkdownForRendering = (content: string): string => {
  const normalizedContent = restoreMissingJsonOpeningFences(
    stripHighlightTagsInsideMarkdownCode(
      content
        .replaceAll(ANSI_ESCAPE_SEQUENCE, '')
        .replaceAll(DELETE_CONTROL_CHARACTER, '')
        .replaceAll(/\r/g, '')
    )
  );
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
    if (!getFenceToken(line)) {
      markdownBuffer.push(line);
      continue;
    }

    flushMarkdownBuffer();

    const block = parseFencedBlockAt(lines, index);
    if (!block) {
      markdownBuffer.push(line.replace(/^(`{3,}|~{3,})/, String.raw`\$1`));
      continue;
    }

    const fencedBlockContent = lines.slice(index, block.lastIndex + 1).join('\n');
    parts.push(sanitizeExistingFencedCodeBlock(fencedBlockContent));
    index = block.lastIndex;
  }

  flushMarkdownBuffer();

  return applyPostFenceRepairs(parts.join('\n'));
};
