import {
  getPdfMappingRepairState,
  needsPdfMappingRepair,
  type PdfMappingRepairState,
} from '@shared/pdfMappingRepairContract';

import type { FileData, LearningPlan, PdfTextIndex } from '../../types';

export type PdfProjectHydrationState = PdfMappingRepairState;

const isPdfFileData = (file: FileData | null): boolean => {
  if (!file) {
    return false;
  }

  return file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
};

export const getPdfProjectHydrationState = (
  file: FileData | null,
  plan: LearningPlan | null,
  documentIndex: PdfTextIndex | null | undefined
): PdfProjectHydrationState =>
  getPdfMappingRepairState({
    documentIndex,
    isPdf: isPdfFileData(file),
    plan,
  });

export const needsPdfProjectHydration = (
  file: FileData | null,
  plan: LearningPlan | null,
  documentIndex: PdfTextIndex | null | undefined
): boolean => {
  const hydrationState = getPdfProjectHydrationState(file, plan, documentIndex);
  return needsPdfMappingRepair(hydrationState);
};
