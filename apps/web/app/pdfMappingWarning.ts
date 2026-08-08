import { PDF_MAPPING_RECOVERY_EXHAUSTED_WARNING } from '@shared/pdfDocumentPolicy';
import type { PdfTextIndex, ProjectSource } from '../types.ts';

export const resolvePdfMappingWarning = (
  source: ProjectSource | null,
  documentIndex: PdfTextIndex | null
): string | null => {
  if (source?.kind !== 'pdf') {
    return null;
  }

  if (!documentIndex || documentIndex.chunks.length === 0) {
    return null;
  }

  const warnings =
    documentIndex.mappingWarnings?.filter(
      warning => Boolean(warning) && warning !== PDF_MAPPING_RECOVERY_EXHAUSTED_WARNING
    ) || [];
  if (warnings.length > 0) {
    return `Mappatura PDF da controllare: ${warnings[0]}`;
  }

  return null;
};
