export const COURSE_SOURCE_UPLOAD_LIMITS = {
  maxFileBytes: 32_000_000,
  maxTotalBytes: 1_000_000_000,
  maxArchiveEntries: 20_000,
  maxArchiveEntryBytes: 256_000_000,
} as const;

export interface CourseSourceUploadFile {
  id: string;
  name: string;
  mimeType: string;
  byteSize: number;
}

export const SOURCE_UPLOAD_METADATA_TOO_LARGE_MESSAGE =
  'I metadati delle fonti superano il limite di caricamento.';
