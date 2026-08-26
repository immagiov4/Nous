import { parseFencedBlockAt } from './fencedCode.ts';

export interface MissingJsonFenceRepairPlan {
  content: string;
  sourceCodeRanges: Array<{ start: number; end: number }>;
}

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
      // The closest opening brace may belong to a nested value.
    }
  }

  return null;
};

export const planMissingJsonOpeningFenceRepairs = (content: string): MissingJsonFenceRepairPlan => {
  const sourceLines = content.split('\n');
  const lines = sourceLines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const originalLineStarts: number[] = [];
  let nextLineStart = 0;
  for (const line of sourceLines) {
    originalLineStarts.push(nextLineStart);
    nextLineStart += line.length + 1;
  }

  const sourceCodeRanges: MissingJsonFenceRepairPlan['sourceCodeRanges'] = [];
  let insertedLineCount = 0;

  for (let fenceIndex = 0; fenceIndex < lines.length; fenceIndex += 1) {
    if (!/^```[\t ]*$/u.test(lines[fenceIndex])) {
      continue;
    }

    const jsonStartIndex = findJsonStartBeforeOrphanedFence(lines, fenceIndex);
    if (jsonStartIndex !== null) {
      const originalStartIndex = jsonStartIndex - insertedLineCount;
      const originalFenceIndex = fenceIndex - insertedLineCount;
      sourceCodeRanges.push({
        start: originalLineStarts[originalStartIndex] ?? 0,
        end:
          (originalLineStarts[originalFenceIndex] ?? content.length) +
          (lines[fenceIndex]?.length ?? 0),
      });
      lines.splice(jsonStartIndex, 0, '```json');
      insertedLineCount += 1;
      fenceIndex += 1;
      continue;
    }

    const parsedBlock = parseFencedBlockAt(lines, fenceIndex);
    if (parsedBlock) {
      fenceIndex = parsedBlock.lastIndex;
    }
  }

  return { content: lines.join('\n'), sourceCodeRanges };
};
