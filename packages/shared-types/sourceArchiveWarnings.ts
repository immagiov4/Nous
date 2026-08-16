const SOURCE_ARCHIVE_PDF_WARNING_REASONS = [
  'no-usable-text',
  'parser-failed',
  'safety-limit',
  'timeout',
] as const;

export type SourceArchivePdfWarningReason = (typeof SOURCE_ARCHIVE_PDF_WARNING_REASONS)[number];

export interface SourceArchivePdfWarningDetail {
  path: string;
  reason: SourceArchivePdfWarningReason;
}

const sourceArchivePdfWarningReasons = new Set<string>(SOURCE_ARCHIVE_PDF_WARNING_REASONS);

export const isSourceArchivePdfWarningReason = (
  value: unknown
): value is SourceArchivePdfWarningReason =>
  typeof value === 'string' && sourceArchivePdfWarningReasons.has(value);
