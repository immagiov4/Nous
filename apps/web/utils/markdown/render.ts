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

const applyPostFenceRepairs = (content: string): string =>
  mergeSplitTextPseudocodeBlocks(
    mergeSplitBraceFencedBlocks(mergeOrphanedContinuationLinesIntoPreviousFence(content))
  );

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
    if (!getFenceToken(line)) {
      markdownBuffer.push(line);
      continue;
    }

    flushMarkdownBuffer();

    const block = parseFencedBlockAt(lines, index);
    if (!block) {
      markdownBuffer.push(line.replace(/^(`{3,}|~{3,})/, '\\$1'));
      continue;
    }

    const fencedBlockContent = lines.slice(index, block.lastIndex + 1).join('\n');
    parts.push(sanitizeExistingFencedCodeBlock(fencedBlockContent));
    index = block.lastIndex;
  }

  flushMarkdownBuffer();

  return applyPostFenceRepairs(parts.join('\n'));
};
