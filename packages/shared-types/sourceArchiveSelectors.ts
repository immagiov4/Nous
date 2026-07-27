export const SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES = 4_000_000;

const comparePathsByCodeUnit = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

interface SourceArchiveDirectoryEntry {
  kind: 'directory';
  path: string;
}

interface SourceArchiveFileEntry {
  byteSize: number;
  contentKind: 'binary' | 'text';
  kind: 'file';
  path: string;
}

type SourceArchiveEntry = SourceArchiveDirectoryEntry | SourceArchiveFileEntry;

interface SourceArchiveSelector {
  kind: 'directory' | 'file';
  path: string;
}

type SourceArchiveSelectorContractErrorCode =
  | 'context-limit-exceeded'
  | 'duplicate-selector'
  | 'empty-selectors'
  | 'index-invalid'
  | 'invalid-selector'
  | 'selector-not-textual';

export class SourceArchiveSelectorContractError extends Error {
  constructor(
    public readonly code: SourceArchiveSelectorContractErrorCode,
    public readonly path?: string,
    public readonly expandedTextBytes?: number,
    public readonly maxBytes?: number
  ) {
    super(code);
    this.name = 'SourceArchiveSelectorContractError';
  }
}

export const resolveSourceArchiveSelection = (
  entries: readonly SourceArchiveEntry[],
  selectors: readonly SourceArchiveSelector[] | undefined,
  maxBytes = SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES
): {
  expandedTextBytes: number;
  selectors: SourceArchiveSelector[];
  textFilePaths: string[];
} => {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw new SourceArchiveSelectorContractError('empty-selectors');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Source archive context limit must be a non-negative safe integer.');
  }

  const entriesByPath = new Map<string, SourceArchiveEntry>();
  const textFiles: SourceArchiveFileEntry[] = [];
  for (const entry of entries) {
    if (
      !entry.path ||
      entriesByPath.has(entry.path) ||
      (entry.kind !== 'directory' && entry.kind !== 'file') ||
      (entry.kind === 'file' &&
        (!Number.isSafeInteger(entry.byteSize) ||
          entry.byteSize < 0 ||
          (entry.contentKind !== 'binary' && entry.contentKind !== 'text')))
    ) {
      throw new SourceArchiveSelectorContractError('index-invalid', entry.path);
    }
    entriesByPath.set(entry.path, entry);
    if (entry.kind === 'file' && entry.contentKind === 'text') {
      textFiles.push(entry);
    }
  }
  textFiles.sort((left, right) => comparePathsByCodeUnit(left.path, right.path));

  const normalizedSelectors: SourceArchiveSelector[] = [];
  const selectorKeys = new Set<string>();
  const selectedFiles = new Map<string, SourceArchiveFileEntry>();
  let expandedTextBytes = 0;

  for (const selector of selectors) {
    const entry =
      selector &&
      (selector.kind === 'directory' || selector.kind === 'file') &&
      typeof selector.path === 'string'
        ? entriesByPath.get(selector.path)
        : undefined;
    if (!entry || entry.kind !== selector.kind) {
      throw new SourceArchiveSelectorContractError('invalid-selector', selector?.path);
    }

    const selectorKey = `${selector.kind}:${selector.path}`;
    if (selectorKeys.has(selectorKey)) {
      throw new SourceArchiveSelectorContractError('duplicate-selector', selector.path);
    }
    selectorKeys.add(selectorKey);

    const selectedByCurrentSelector =
      entry.kind === 'file'
        ? entry.contentKind === 'text'
          ? [entry]
          : []
        : textFiles.filter(file => file.path.startsWith(`${entry.path}/`));
    if (selectedByCurrentSelector.length === 0) {
      throw new SourceArchiveSelectorContractError('selector-not-textual', selector.path);
    }

    for (const file of selectedByCurrentSelector) {
      if (selectedFiles.has(file.path)) {
        continue;
      }
      expandedTextBytes += file.byteSize;
      if (expandedTextBytes > maxBytes) {
        throw new SourceArchiveSelectorContractError(
          'context-limit-exceeded',
          selector.path,
          expandedTextBytes,
          maxBytes
        );
      }
      selectedFiles.set(file.path, file);
    }
    normalizedSelectors.push({ kind: selector.kind, path: selector.path });
  }

  return {
    expandedTextBytes,
    selectors: normalizedSelectors,
    textFilePaths: [...selectedFiles.keys()].sort(comparePathsByCodeUnit),
  };
};
