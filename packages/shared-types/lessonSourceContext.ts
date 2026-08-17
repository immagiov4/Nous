export const MAX_LESSON_SOURCE_CONTEXT_CHARS = 16_000;
export const MAX_LESSON_COMBINED_SOURCE_CONTEXT_CHARS = 36_000;
export const MAX_LESSON_CONTEXT_CHUNKS = 6;
export const DEFAULT_LESSON_CONTEXT_CHUNKS = 2;
export const MAX_CONTEXT_CHAT_FIELD_CHARS = 24_000;
export const CONTEXT_RETAINED_ARCHIVE_SOURCE_KIND = 'archive';
export const CONTEXT_SOURCE_ARCHIVE_TOOL_NAME = 'retrieveSourceArchive' as const;
export const SOURCE_ARCHIVE_VERSION_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export interface ContextSourceArchiveSelector {
  kind: 'directory' | 'file';
  path: string;
}

export interface ContextSourceArchiveVersion {
  representationHash: string;
  sourceHash: string;
  sourceId: string;
}

export interface ContextSourceReference {
  archiveSelectors?: ContextSourceArchiveSelector[];
  archiveVersion?: ContextSourceArchiveVersion;
  chunkIds: string[];
  name: string;
  pageEnd?: number;
  pageStart?: number;
  sourceId: string;
}

const UNSAFE_CONTEXT_SOURCE_TOKEN_CHARACTERS = /[^\p{L}\p{N}._:()[\]-]+/gu;
const CONTEXT_SOURCE_NAME_CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]+/gu;

export const sanitizeContextSourceDisplayName = (value: string): string =>
  value.replace(CONTEXT_SOURCE_NAME_CONTROL_CHARACTERS, '_').trim() || 'source';

export const sanitizeContextSourceArchivePath = (value: string): string =>
  value.replace(CONTEXT_SOURCE_NAME_CONTROL_CHARACTERS, '_').trim() || 'path';

export const sanitizeContextSourcePromptToken = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(UNSAFE_CONTEXT_SOURCE_TOKEN_CHARACTERS, '_')
    .replace(/^_+|_+$/g, '') || 'source';
