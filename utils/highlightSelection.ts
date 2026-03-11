export interface HighlightSelectionOptions {
  content: string;
  contextAfter?: string;
  contextBefore?: string;
  selectedText: string;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const buildContextRegex = (value: string) => escapeRegex(normalizeWhitespace(value)).replace(/\s+/g, '\\s+');

const replaceAtIndex = (source: string, start: number, length: number, replacement: string) =>
  `${source.slice(0, start)}${replacement}${source.slice(start + length)}`;

const resolveExactMatch = (
  content: string,
  selectedText: string,
  contextBefore?: string,
  contextAfter?: string
): RegExpMatchArray | undefined => {
  const normalizedSelectionPattern = buildContextRegex(selectedText);
  const exactSelectionRegex = new RegExp(normalizedSelectionPattern, 'gu');
  const normalizedBefore = normalizeWhitespace(contextBefore || '');
  const normalizedAfter = normalizeWhitespace(contextAfter || '');
  const selectionMatches = [...content.matchAll(exactSelectionRegex)];

  return (
    selectionMatches.find((candidate) => {
      const candidateIndex = candidate.index ?? 0;
      const beforeSlice = normalizeWhitespace(content.slice(Math.max(0, candidateIndex - 64), candidateIndex));
      const afterSlice = normalizeWhitespace(
        content.slice(candidateIndex + candidate[0].length, candidateIndex + candidate[0].length + 64)
      );

      const beforeOk = !normalizedBefore || beforeSlice.endsWith(normalizedBefore) || normalizedBefore.endsWith(beforeSlice);
      const afterOk = !normalizedAfter || afterSlice.startsWith(normalizedAfter) || normalizedAfter.startsWith(afterSlice);
      return beforeOk && afterOk;
    }) || selectionMatches[0]
  );
};

export const toggleHighlightInContent = ({
  content,
  contextAfter,
  contextBefore,
  selectedText,
}: HighlightSelectionOptions): string | null => {
  const trimmedTargetText = selectedText.trim();
  if (!trimmedTargetText) {
    return null;
  }

  const exactMatch = resolveExactMatch(content, trimmedTargetText, contextBefore, contextAfter);
  const words = trimmedTargetText.match(/[\p{L}\p{N}]+/gu) || [];

  if (words.length === 0) {
    if (!exactMatch) {
      return null;
    }

    const matchedText = exactMatch[0];
    const startIdx = exactMatch.index ?? 0;
    return replaceAtIndex(content, startIdx, matchedText.length, `<mark>${matchedText}</mark>`);
  }

  const escapedWords = words.map(word => escapeRegex(word));
  const junkPattern = '[^\\p{L}\\p{N}]+';
  const pattern = escapedWords.join(junkPattern);
  const wordChar = '[\\p{L}\\p{N}]';
  const expandedPattern = `${wordChar}*${pattern}${wordChar}*`;
  const fuzzyRegex = new RegExp(expandedPattern, 'iu');
  const shouldPreferExact = /[^\p{L}\p{N}]/u.test(trimmedTargetText);
  const match = shouldPreferExact ? exactMatch || content.match(fuzzyRegex) : content.match(fuzzyRegex) || exactMatch;

  if (match) {
    const startIdx = match.index ?? 0;
    const endIdx = startIdx + match[0].length;
    const matchedText = match[0];
    const escapedMatch = escapeRegex(matchedText);
    const exactHighlightedRegex = new RegExp(`<mark>${escapedMatch}</mark>`, 'i');

    if (exactHighlightedRegex.test(content)) {
      return content.replace(exactHighlightedRegex, matchedText);
    }

    return `${content.substring(0, startIdx)}<mark>${matchedText}</mark>${content.substring(endIdx)}`;
  }

  if (content.includes(selectedText)) {
    return content.replace(selectedText, `<mark>${selectedText}</mark>`);
  }

  return null;
};
