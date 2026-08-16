export type PdfMappingRepairState =
  | 'idle'
  | 'mapping-recovery-exhausted'
  | 'missing-document-index'
  | 'missing-primary-chunk-mappings'
  | 'ready';

export type PdfMappingRepairStatus = 'completed' | 'failed' | 'queued' | 'running';
export type PdfMappingRepairStage = 'preparing' | 'mapping' | 'saving' | 'ready';

export interface PdfMappingRepairResult {
  projectId: string;
  projectRevision: number;
  repaired: boolean;
}

export interface PdfMappingRepairSnapshot {
  correlationId?: string;
  createdAt: string;
  errorCode?: string;
  id: string;
  projectId: string;
  result?: PdfMappingRepairResult;
  stage: PdfMappingRepairStage;
  status: PdfMappingRepairStatus;
  updatedAt: string;
}

export interface PdfMappingRepairResponse {
  created?: boolean;
  error?: string;
  job?: PdfMappingRepairSnapshot;
  result?: PdfMappingRepairResult;
  success: boolean;
}

interface PdfMappingLesson {
  readonly kind?: unknown;
  readonly primaryChunkIds?: unknown;
  readonly primaryChunkMappingSource?: unknown;
  readonly type?: unknown;
}

interface PdfMappingPlan {
  readonly modules?: readonly {
    readonly children?: readonly PdfMappingLesson[];
  }[];
  readonly sections?: readonly PdfMappingLesson[];
}

interface PdfMappingDocumentIndex {
  readonly chunks?: readonly unknown[];
  readonly mappingRecovery?: { readonly status?: unknown };
}

const getRelevantLessons = (plan: PdfMappingPlan): readonly PdfMappingLesson[] => {
  const moduleLessons = (plan.modules ?? []).flatMap(module =>
    (module.children ?? []).filter(child => child.kind !== 'exercise')
  );
  const lessons =
    moduleLessons.length > 0
      ? moduleLessons
      : (plan.sections ?? []).filter(child => child.kind !== 'exercise');
  const contentLessons = lessons.filter(lesson => lesson.type !== 'summary');
  return contentLessons.length > 0 ? contentLessons : lessons;
};

const hasLegacyRepeatedMappings = (
  lessons: readonly PdfMappingLesson[],
  chunkCount: number
): boolean => {
  const mappedLessons = lessons.filter(
    lesson => Array.isArray(lesson.primaryChunkIds) && lesson.primaryChunkIds.length > 0
  );
  if (mappedLessons.length < 3 || chunkCount <= mappedLessons.length) return false;
  const firstMapping = JSON.stringify(mappedLessons[0]?.primaryChunkIds);
  return Boolean(
    firstMapping &&
      mappedLessons.every(lesson => JSON.stringify(lesson.primaryChunkIds) === firstMapping)
  );
};

export const getPdfMappingRepairState = ({
  documentIndex,
  isPdf,
  plan,
}: {
  readonly documentIndex: PdfMappingDocumentIndex | null | undefined;
  readonly isPdf: boolean;
  readonly plan: PdfMappingPlan | null | undefined;
}): PdfMappingRepairState => {
  const lessons = plan ? getRelevantLessons(plan) : [];
  if (!isPdf || lessons.length === 0) return 'idle';

  const chunks = documentIndex?.chunks;
  if (!chunks?.length) return 'missing-document-index';
  if (documentIndex?.mappingRecovery?.status === 'exhausted') {
    return 'mapping-recovery-exhausted';
  }
  if (
    lessons.some(
      lesson => !Array.isArray(lesson.primaryChunkIds) || lesson.primaryChunkIds.length === 0
    )
  ) {
    return 'missing-primary-chunk-mappings';
  }
  if (
    lessons.some(lesson => lesson.primaryChunkMappingSource === 'fallback') ||
    hasLegacyRepeatedMappings(lessons, chunks.length)
  ) {
    return 'missing-primary-chunk-mappings';
  }
  return 'ready';
};

export const needsPdfMappingRepair = (
  state: PdfMappingRepairState
): state is 'missing-document-index' | 'missing-primary-chunk-mappings' =>
  state === 'missing-document-index' || state === 'missing-primary-chunk-mappings';
