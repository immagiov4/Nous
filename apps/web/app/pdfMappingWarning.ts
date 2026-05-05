// fallow-ignore-file unused-files
import type { PdfTextIndex, ProjectSource } from '../types.ts';

// fallow-ignore-next-line unused-exports — used by App.tsx
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

  const warnings = documentIndex.mappingWarnings?.filter(Boolean) || [];
  if (warnings.length > 0) {
    return `Mappatura PDF da controllare: ${warnings[0]}`;
  }

  return null;
};
