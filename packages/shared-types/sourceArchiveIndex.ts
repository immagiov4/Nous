export const ASSESSMENT_SOURCE_ARCHIVE_PREVIEW_BUDGET_CHARS = 20_000;
export const SOURCE_ARCHIVE_TOOL_STEP_LIMIT = 12;
export const SOURCE_ARCHIVE_TOOL_CONTEXT_MAX_BYTES = 8 * 1024 * 1024;

interface SourceArchiveIndexEntry {
  byteSize?: number;
  contentKind?: 'binary' | 'text';
  kind: 'directory' | 'file';
  path: string;
  preview?: string;
}

interface SourceArchiveIndex {
  entries: readonly SourceArchiveIndexEntry[];
}

const compareArchivePaths = (
  left: SourceArchiveIndexEntry,
  right: SourceArchiveIndexEntry
): number => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

export const formatSourceArchiveIndex = (
  index: SourceArchiveIndex,
  { previewBudgetChars }: { previewBudgetChars?: number } = {}
): string => {
  const entries = [...index.entries].sort(compareArchivePaths);
  const textFileCount = entries.filter(
    entry => entry.kind === 'file' && entry.contentKind === 'text'
  ).length;
  const budget = previewBudgetChars ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new RangeError('Source archive preview budget must be a non-negative safe integer.');
  }
  if (budget < textFileCount) {
    throw new RangeError('Source archive preview budget must allow one character per text file.');
  }
  const baseQuota = textFileCount === 0 ? 0 : Math.floor(budget / textFileCount);
  const extraQuotaCount = textFileCount === 0 ? 0 : budget % textFileCount;
  let textFileIndex = 0;

  return entries
    .flatMap(entry => {
      if (entry.kind === 'directory') return [`DIRECTORY ${entry.path}`];
      const description = `FILE ${entry.path} | ${entry.contentKind} | ${entry.byteSize} bytes`;
      if (entry.contentKind !== 'text') return [description];
      const previewQuota = baseQuota + (textFileIndex < extraQuotaCount ? 1 : 0);
      textFileIndex += 1;
      return entry.preview === undefined
        ? [description]
        : [description, `PREVIEW ${entry.path}`, entry.preview.slice(0, previewQuota)];
    })
    .join('\n');
};
