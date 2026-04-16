import type { FileData, LearningPlan, PdfTextIndex } from '../../types';

export type PdfProjectHydrationState =
  | 'idle'
  | 'missing-document-index'
  | 'missing-primary-chunk-mappings'
  | 'ready';

const MIN_SUSPICIOUS_MAPPING_SECTIONS = 4;
const MIN_SUSPICIOUS_MAPPING_CHUNKS = 6;

const isPdfFileData = (file: FileData | null): boolean => {
  if (!file) {
    return false;
  }

  return file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
};

const getHydrationRelevantSections = (plan: LearningPlan) => {
  const contentSections = plan.sections.filter(section => section.type !== 'summary');
  return contentSections.length > 0 ? contentSections : plan.sections;
};

const sameChunkIds = (left: string[] | undefined, right: string[]): boolean =>
  Array.isArray(left) &&
  left.length === right.length &&
  left.every((chunkId, index) => chunkId === right[index]);

const hasExplicitFallbackChunkMappings = (plan: LearningPlan): boolean =>
  getHydrationRelevantSections(plan).some(
    section => section.primaryChunkMappingSource === 'fallback'
  );

const hasSuspiciousFallbackChunkMappings = (
  plan: LearningPlan,
  documentIndex: PdfTextIndex
): boolean => {
  const relevantSections = getHydrationRelevantSections(plan);
  if (
    relevantSections.length < MIN_SUSPICIOUS_MAPPING_SECTIONS ||
    documentIndex.chunks.length < MIN_SUSPICIOUS_MAPPING_CHUNKS
  ) {
    return false;
  }

  const fallbackChunkIds = documentIndex.chunks.slice(0, 2).map(chunk => chunk.id);
  if (fallbackChunkIds.length < 2) {
    return false;
  }

  const suspiciousSectionCount = relevantSections.filter(section =>
    sameChunkIds(section.primaryChunkIds, fallbackChunkIds)
  ).length;

  return suspiciousSectionCount >= Math.max(3, Math.ceil(relevantSections.length * 0.6));
};

export const getPdfProjectHydrationState = (
  file: FileData | null,
  plan: LearningPlan | null,
  documentIndex: PdfTextIndex | null | undefined
): PdfProjectHydrationState => {
  if (!isPdfFileData(file) || !plan || plan.sections.length === 0) {
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

  if (hasExplicitFallbackChunkMappings(plan)) {
    return 'missing-primary-chunk-mappings';
  }

  if (hasSuspiciousFallbackChunkMappings(plan, documentIndex)) {
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
