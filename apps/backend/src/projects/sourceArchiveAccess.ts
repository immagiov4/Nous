import {
  resolveSourceArchiveSelection,
  SourceArchiveSelectorContractError,
} from '@shared/sourceArchiveSelectors';

import type { ProjectSourceArchiveIndex, ProjectStore } from './types.js';

export interface SourceArchiveIndexedDirectory {
  kind: 'directory';
  path: string;
}

export interface SourceArchiveIndexedFile {
  byteSize: number;
  contentKind: 'binary' | 'text';
  kind: 'file';
  path: string;
}

export type SourceArchiveIndexedEntry = SourceArchiveIndexedDirectory | SourceArchiveIndexedFile;

export interface SourceArchivePersistedIndex {
  entries: readonly SourceArchiveIndexedEntry[];
}

export type SourceArchiveByteReader = (path: string) => Promise<Uint8Array>;
export type SourceArchiveByteRangeReader = (
  path: string,
  start: number,
  endExclusive: number
) => Promise<Uint8Array>;

export interface SourceArchiveAccessConfig {
  index: SourceArchivePersistedIndex;
  maxContextBytes: number;
  readByteRange: SourceArchiveByteRangeReader;
  readBytes: SourceArchiveByteReader;
}

export type SourceArchiveSelector = {
  kind: 'directory' | 'file';
  path: string;
};

export interface SourceArchiveResolvedFile {
  path: string;
  text: string;
}

export interface SourceArchiveTextPage {
  cursorBytes: number;
  endByteExclusive: number;
  nextCursorBytes: number | null;
  path: string;
  text: string;
  totalBytes: number;
}

export interface SourceArchiveSearchMatch {
  column: number;
  line: number;
  lineText: string;
  path: string;
}

export interface SourceArchiveTreeDirectory extends SourceArchiveIndexedDirectory {
  children: SourceArchiveTreeNode[];
}

export type SourceArchiveTreeNode = SourceArchiveIndexedFile | SourceArchiveTreeDirectory;

export type SourceArchiveAccessErrorCode =
  | 'binary-file'
  | 'context-limit-exceeded'
  | 'cursor-invalid'
  | 'index-invalid'
  | 'path-kind-mismatch'
  | 'path-not-found'
  | 'query-invalid'
  | 'read-failed';

const ERROR_MESSAGES: Record<SourceArchiveAccessErrorCode, string> = {
  'binary-file': 'Source archive path is not textual.',
  'context-limit-exceeded': 'Source archive context exceeds the configured limit.',
  'cursor-invalid': 'Source archive read cursor is invalid.',
  'index-invalid': 'Source archive index is invalid.',
  'path-kind-mismatch': 'Source archive path does not match the requested kind.',
  'path-not-found': 'Source archive path does not exist.',
  'query-invalid': 'Source archive literal query is invalid.',
  'read-failed': 'Source archive content could not be read.',
};

export class SourceArchiveAccessError extends Error {
  constructor(
    public readonly code: SourceArchiveAccessErrorCode,
    public readonly path?: string,
    options?: ErrorOptions
  ) {
    super(ERROR_MESSAGES[code], options);
    this.name = 'SourceArchiveAccessError';
  }
}

const compareEntryPaths = (left: SourceArchiveIndexedEntry, right: SourceArchiveIndexedEntry) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

export const SOURCE_ARCHIVE_READ_PAGE_MAX_BYTES = 256 * 1024;
const UTF8_MAX_TRAILING_BYTES = 3;
const isUtf8ContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;

const getParentPath = (path: string): string => {
  const separatorIndex = path.lastIndexOf('/');
  return separatorIndex === -1 ? '' : path.slice(0, separatorIndex);
};

const isValidPath = (path: string): boolean => {
  const segments = path.split('/');
  return (
    Boolean(path) &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    segments.every(segment => Boolean(segment) && segment !== '.' && segment !== '..')
  );
};

const copyEntry = (entry: SourceArchiveIndexedEntry): SourceArchiveIndexedEntry => ({ ...entry });

export class SourceArchiveAccess {
  private readonly childrenByDirectory = new Map<string, SourceArchiveIndexedEntry[]>();
  private readonly entries: SourceArchiveIndexedEntry[];
  private readonly entriesByPath = new Map<string, SourceArchiveIndexedEntry>();
  private readonly files: SourceArchiveIndexedFile[];
  private readonly maxContextBytes: number;
  private readonly readByteRange: SourceArchiveByteRangeReader;
  private readonly readBytes: SourceArchiveByteReader;

  constructor({ index, maxContextBytes, readByteRange, readBytes }: SourceArchiveAccessConfig) {
    if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes < 0) {
      throw new RangeError('Source archive maxContextBytes must be a non-negative safe integer.');
    }

    this.entries = index.entries.map(copyEntry).sort(compareEntryPaths);
    for (const entry of this.entries) {
      if (
        !isValidPath(entry.path) ||
        this.entriesByPath.has(entry.path) ||
        (entry.kind !== 'directory' && entry.kind !== 'file')
      ) {
        throw new SourceArchiveAccessError('index-invalid', entry.path);
      }
      if (
        entry.kind === 'file' &&
        (!Number.isSafeInteger(entry.byteSize) ||
          entry.byteSize < 0 ||
          !['binary', 'text'].includes(entry.contentKind))
      ) {
        throw new SourceArchiveAccessError('index-invalid', entry.path);
      }
      this.entriesByPath.set(entry.path, entry);
    }

    for (const entry of this.entries) {
      const parentPath = getParentPath(entry.path);
      const parent = parentPath ? this.entriesByPath.get(parentPath) : undefined;
      if (parentPath && parent?.kind !== 'directory') {
        throw new SourceArchiveAccessError('index-invalid', entry.path);
      }
      const siblings = this.childrenByDirectory.get(parentPath) || [];
      siblings.push(entry);
      this.childrenByDirectory.set(parentPath, siblings);
    }

    this.files = this.entries.filter(
      (entry): entry is SourceArchiveIndexedFile => entry.kind === 'file'
    );
    this.maxContextBytes = maxContextBytes;
    this.readByteRange = readByteRange;
    this.readBytes = readBytes;
  }

  getTree(): SourceArchiveTreeNode[] {
    return this.buildTree('');
  }

  listDirectory(path = ''): SourceArchiveIndexedEntry[] {
    if (path) {
      this.requireEntry(path, 'directory');
    }
    return (this.childrenByDirectory.get(path) || []).map(copyEntry);
  }

  async readTextPage(path: string, cursorBytes = 0): Promise<SourceArchiveTextPage> {
    const entry = this.requireEntry(path, 'file');
    if (entry.contentKind === 'binary') {
      throw new SourceArchiveAccessError('binary-file', entry.path);
    }
    if (!Number.isSafeInteger(cursorBytes) || cursorBytes < 0 || cursorBytes > entry.byteSize) {
      throw new SourceArchiveAccessError('cursor-invalid', entry.path);
    }
    if (cursorBytes === entry.byteSize) {
      return {
        cursorBytes,
        endByteExclusive: cursorBytes,
        nextCursorBytes: null,
        path: entry.path,
        text: '',
        totalBytes: entry.byteSize,
      };
    }

    const requestedEnd = Math.min(entry.byteSize, cursorBytes + SOURCE_ARCHIVE_READ_PAGE_MAX_BYTES);
    let bytes: Uint8Array;
    try {
      bytes = await this.readByteRange(entry.path, cursorBytes, requestedEnd);
    } catch (cause) {
      throw new SourceArchiveAccessError('read-failed', entry.path, { cause });
    }
    if (bytes.byteLength !== requestedEnd - cursorBytes) {
      throw new SourceArchiveAccessError('read-failed', entry.path);
    }
    const firstByte = bytes[0];
    if (cursorBytes > 0 && firstByte !== undefined && isUtf8ContinuationByte(firstByte)) {
      throw new SourceArchiveAccessError('cursor-invalid', entry.path);
    }

    const decoded = this.decodeTextPage(bytes, entry.path);
    const endByteExclusive = cursorBytes + decoded.byteLength;
    return {
      cursorBytes,
      endByteExclusive,
      nextCursorBytes: endByteExclusive === entry.byteSize ? null : endByteExclusive,
      path: entry.path,
      text: decoded.text,
      totalBytes: entry.byteSize,
    };
  }

  async searchLiteral(query: string): Promise<SourceArchiveSearchMatch[]> {
    if (!query || query.includes('\n') || query.includes('\r')) {
      throw new SourceArchiveAccessError('query-invalid');
    }

    const matches: SourceArchiveSearchMatch[] = [];
    const textEncoder = new TextEncoder();
    let contextBytes = 0;

    for (const entry of this.files) {
      if (entry.contentKind === 'binary') {
        continue;
      }
      const { text } = await this.loadText(entry);
      const lines = text.split(/\r\n|\n|\r/u);
      for (const [lineIndex, lineText] of lines.entries()) {
        const lineByteSize = textEncoder.encode(lineText).byteLength;
        let matchIndex = lineText.indexOf(query);
        while (matchIndex !== -1) {
          contextBytes += lineByteSize;
          this.assertContextSize(contextBytes, entry.path);
          matches.push({
            column: matchIndex + 1,
            line: lineIndex + 1,
            lineText,
            path: entry.path,
          });
          matchIndex = lineText.indexOf(query, matchIndex + 1);
        }
      }
    }

    return matches;
  }

  async resolveSelector(selector: SourceArchiveSelector): Promise<SourceArchiveResolvedFile[]> {
    return this.resolveSelectors([selector]);
  }

  async resolveSelectors(
    selectors: readonly SourceArchiveSelector[]
  ): Promise<SourceArchiveResolvedFile[]> {
    for (const selector of selectors) {
      this.requireEntry(selector.path, selector.kind);
    }

    let selection: ReturnType<typeof resolveSourceArchiveSelection>;
    try {
      selection = resolveSourceArchiveSelection(this.entries, selectors, this.maxContextBytes);
    } catch (error) {
      if (error instanceof SourceArchiveSelectorContractError) {
        if (error.code === 'context-limit-exceeded') {
          throw new SourceArchiveAccessError('context-limit-exceeded', error.path);
        }
        if (error.code === 'selector-not-textual') {
          throw new SourceArchiveAccessError('binary-file', error.path);
        }
      }
      throw error;
    }

    const resolved: SourceArchiveResolvedFile[] = [];
    let actualBytes = 0;
    for (const path of selection.textFilePaths) {
      const entry = this.requireEntry(path, 'file');
      const loaded = await this.loadText(entry);
      actualBytes += loaded.byteSize;
      this.assertContextSize(actualBytes, path);
      resolved.push({ path: entry.path, text: loaded.text });
    }
    return resolved;
  }

  private assertContextSize(byteSize: number, path?: string): void {
    if (!Number.isSafeInteger(byteSize) || byteSize > this.maxContextBytes) {
      throw new SourceArchiveAccessError('context-limit-exceeded', path);
    }
  }

  private buildTree(directoryPath: string): SourceArchiveTreeNode[] {
    return (this.childrenByDirectory.get(directoryPath) || []).map(entry =>
      entry.kind === 'file'
        ? { ...entry }
        : {
            ...entry,
            children: this.buildTree(entry.path),
          }
    );
  }

  private async loadText(
    entry: SourceArchiveIndexedFile
  ): Promise<{ byteSize: number; text: string }> {
    if (entry.contentKind === 'binary') {
      throw new SourceArchiveAccessError('binary-file', entry.path);
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.readBytes(entry.path);
    } catch (cause) {
      throw new SourceArchiveAccessError('read-failed', entry.path, { cause });
    }

    try {
      return {
        byteSize: bytes.byteLength,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      };
    } catch (cause) {
      throw new SourceArchiveAccessError('binary-file', entry.path, { cause });
    }
  }

  private decodeTextPage(bytes: Uint8Array, path: string): { byteLength: number; text: string } {
    const maximumTrim = Math.min(UTF8_MAX_TRAILING_BYTES, bytes.byteLength - 1);
    for (let trailingBytes = 0; trailingBytes <= maximumTrim; trailingBytes += 1) {
      const byteLength = bytes.byteLength - trailingBytes;
      try {
        return {
          byteLength,
          text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, byteLength)),
        };
      } catch {
        // A valid UTF-8 code point may straddle only the final four bytes of a page.
      }
    }
    throw new SourceArchiveAccessError('binary-file', path);
  }

  private requireEntry<TKind extends SourceArchiveIndexedEntry['kind']>(
    path: string,
    kind: TKind
  ): Extract<SourceArchiveIndexedEntry, { kind: TKind }> {
    const entry = this.entriesByPath.get(path);
    if (!entry) {
      throw new SourceArchiveAccessError('path-not-found', path);
    }
    if (entry.kind !== kind) {
      throw new SourceArchiveAccessError('path-kind-mismatch', path);
    }
    return entry as Extract<SourceArchiveIndexedEntry, { kind: TKind }>;
  }
}

export const createProjectSourceArchiveAccess = (input: {
  index: ProjectSourceArchiveIndex;
  maxContextBytes: number;
  projectId: string;
  signal: AbortSignal;
  sourceUnavailableError: () => Error;
  store: Pick<ProjectStore, 'loadProjectSourceArchiveEntry' | 'loadProjectSourceArchiveEntryRange'>;
  userId: string;
}): SourceArchiveAccess => {
  const requireEntry = async (read: () => Promise<Uint8Array | null>): Promise<Uint8Array> => {
    input.signal.throwIfAborted();
    const bytes = await read();
    input.signal.throwIfAborted();
    if (!bytes) throw input.sourceUnavailableError();
    return bytes;
  };

  return new SourceArchiveAccess({
    index: input.index,
    maxContextBytes: input.maxContextBytes,
    readByteRange: (path, start, endExclusive) =>
      requireEntry(() =>
        input.store.loadProjectSourceArchiveEntryRange(
          input.userId,
          input.projectId,
          path,
          input.index.version,
          start,
          endExclusive
        )
      ),
    readBytes: path =>
      requireEntry(() =>
        input.store.loadProjectSourceArchiveEntry(
          input.userId,
          input.projectId,
          path,
          input.index.version
        )
      ),
  });
};
