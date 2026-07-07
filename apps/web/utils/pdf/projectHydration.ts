import type { FileData, LearningPlan, LessonNode, PdfTextIndex } from '../../types';
import { flattenLessons } from '../learning/pathNodes.ts';

export type PdfProjectHydrationState =
  | 'idle'
  | 'missing-document-index'
  | 'missing-primary-chunk-mappings'
  | 'ready';

const isPdfFileData = (file: FileData | null): boolean => {
  if (!file) {
    return false;
  }

  return file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
};

const getHydrationRelevantSections = (plan: LearningPlan): LessonNode[] => {
  const allLessons = flattenLessons(plan.modules);
  const contentLessons = allLessons.filter(lesson => lesson.type !== 'summary');
  return contentLessons.length > 0 ? contentLessons : allLessons;
};

const hasExplicitFallbackChunkMappings = (plan: LearningPlan): boolean =>
  getHydrationRelevantSections(plan).some(
    section => section.primaryChunkMappingSource === 'fallback'
  );

const hasLegacyRepeatedChunkMappings = (
  plan: LearningPlan,
  documentIndex: PdfTextIndex
): boolean => {
  const mappedSections = getHydrationRelevantSections(plan).filter(
    section => section.primaryChunkIds && section.primaryChunkIds.length > 0
  );
  if (mappedSections.length < 3 || documentIndex.chunks.length <= mappedSections.length) {
    return false;
  }

  const firstMapping = mappedSections[0]?.primaryChunkIds?.join('\u0000');
  return Boolean(
    firstMapping &&
      mappedSections.every(section => section.primaryChunkIds?.join('\u0000') === firstMapping)
  );
};

export const getPdfProjectHydrationState = (
  file: FileData | null,
  plan: LearningPlan | null,
  documentIndex: PdfTextIndex | null | undefined
): PdfProjectHydrationState => {
  if (!isPdfFileData(file) || !plan || flattenLessons(plan.modules).length === 0) {
    return 'idle';
  }

  if (!documentIndex || documentIndex.chunks.length === 0) {
    return 'missing-document-index';
  }

  if (
    getHydrationRelevantSections(plan).some(
      section => !section.primaryChunkIds || section.primaryChunkIds.length === 0
    )
  ) {
    return 'missing-primary-chunk-mappings';
  }

  if (
    hasExplicitFallbackChunkMappings(plan) ||
    hasLegacyRepeatedChunkMappings(plan, documentIndex)
  ) {
    return 'missing-primary-chunk-mappings';
  }

  return 'ready';
};

export const needsPdfProjectHydration = (
  file: FileData | null,
  plan: LearningPlan | null,
  documentIndex: PdfTextIndex | null | undefined
): boolean => {
  const hydrationState = getPdfProjectHydrationState(file, plan, documentIndex);
  return (
    hydrationState === 'missing-document-index' ||
    hydrationState === 'missing-primary-chunk-mappings'
  );
};
