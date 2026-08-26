import { stripHighlightTagsInsideMarkdownCode } from './codeRanges.ts';
import {
  getFenceToken,
  mergeOrphanedContinuationLinesIntoPreviousFence,
  mergeSplitBraceFencedBlocks,
  mergeSplitTextPseudocodeBlocks,
  parseFencedBlockAt,
  sanitizeExistingFencedCodeBlock,
} from './fencedCode.ts';
import { planMissingJsonOpeningFenceRepairs } from './jsonFenceRepair.ts';
import { processMarkdownSegment } from './segment.ts';

const DELETE_CONTROL_CHARACTER = '\u007f';
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

const applyPostFenceRepairs = (content: string): string =>
  mergeSplitTextPseudocodeBlocks(
    mergeSplitBraceFencedBlocks(mergeOrphanedContinuationLinesIntoPreviousFence(content))
  );

export const normalizeMarkdownForRendering = (content: string): string => {
  const normalizedContent = planMissingJsonOpeningFenceRepairs(
    stripHighlightTagsInsideMarkdownCode(
      content
        .replaceAll(ANSI_ESCAPE_SEQUENCE, '')
        .replaceAll(DELETE_CONTROL_CHARACTER, '')
        .replaceAll(/\r/g, '')
    )
  ).content;
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
