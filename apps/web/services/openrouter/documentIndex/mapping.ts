import type { FileData, LearningPlan, PdfTextChunk, PdfTextIndex } from '../../../types.ts';
import { getPdfProjectHydrationState } from '../../../utils/pdf/projectHydration.ts';
import { pushNousDebugTrace } from '../../core/debugTrace.ts';
import { getPdfTextSession } from '../pdfAssets.ts';
import {
  callOpenRouter,
  isPdfFile,
  MODEL_FLASH,
  MODEL_REASONING,
  parseCleanJson,
  retryWithBackoff,
} from '../shared.ts';
import {
  buildCompactSnippet,
  buildPdfTextIndex,
  clamp,
  logPdfPlanDebug,
  resolvePdfPlanSubstantiveRange,
} from './chunking.ts';
import {
  DEEP_REPAIR_MAX_MAPPING_LESSONS_PER_REQUEST,
  MAPPING_CHUNK_WINDOW_PADDING,
  MAPPING_OUTPUT_TOKENS_PER_LESSON,
  MAPPING_REQUEST_TEMPERATURE,
  MAX_MAPPING_CHUNK_CANDIDATES,
  MAX_MAPPING_CHUNK_PREVIEW_CHARS,
  MAX_MAPPING_LESSON_JSON_CHARS,
  MAX_MAPPING_LESSONS_PER_REQUEST,
  MAX_MAPPING_OUTPUT_TOKENS,
  MAX_MAPPING_RAW_RESPONSE_DEBUG_CHARS,
  MAX_PRIMARY_CHUNKS_PER_LESSON,
  MAX_REPAIR_MAPPING_CHUNK_CANDIDATES,
  MIN_MAPPING_CHUNK_CANDIDATES,
  MIN_MAPPING_CHUNK_PREVIEW_CHARS,
  MIN_MAPPING_OUTPUT_TOKENS,
  MIN_REPAIR_MAPPING_CHUNK_CANDIDATES,
  MIN_REPAIR_MAPPING_OUTPUT_TOKENS,
  PDF_PLAN_MIN_PAGES_FOR_EDGE_EXCLUSION,
  REPAIR_MAPPING_CHUNK_WINDOW_PADDING,
  REPAIR_MAPPING_OUTPUT_TOKENS_PER_LESSON,
  TARGET_MAPPING_PROMPT_CHARS,
} from './constants.ts';
import { applyPdfMappingQuality, emitPdfPlanCoverageDiagnostics } from './coverage.ts';
import { resolvePdfChunkPageSpan } from './layout.ts';

// ── Types ──────────────────────────────────────────────────────────────

interface ChunkMappingResponse {
  mappings?: Array<{
    lessonId?: string;
    chunkIds?: string[];
  }>;
}

interface ParsedChunkMappingsResult {
  acceptedLessonIds: string[];
  acceptedMappingCount: number;
  emptyChunkIdsCount: number;
  invalidChunkIdCount: number;
  invalidShapeCount: number;
  mappings: Map<string, string[]>;
  missingLessonIdCount: number;
  rawMappingCount: number;
  rejectedChunkIds: string[];
  rejectedLessonIds: string[];
}

interface LessonMappingDescriptor {
  lessonId: string;
  title: string;
  description: string;
  moduleTitle: string;
  documentOrder: number;
  totalLessons: number;
}

interface ChunkMappingDescriptor {
  id: string;
  sequence: number;
  headingPath: string[];
  textPreview: string;
  textLength: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

const getMappablePlanSections = (plan: LearningPlan): LearningPlan['sections'] =>
  plan.sections.filter(section => section.type !== 'summary');

const buildLessonDescriptor = (
  section: LearningPlan['sections'][number],
  documentOrder: number,
  totalLessons: number
): LessonMappingDescriptor => ({
  lessonId: section.id,
  title: section.title,
  description: section.description,
  moduleTitle: section.moduleTitle || '',
  documentOrder,
  totalLessons,
});

const getTargetLessonDescriptorsForMapping = (
  plan: LearningPlan,
  sectionIds?: string[]
): LessonMappingDescriptor[] =>
  getMappablePlanSections(plan)
    .map((section, documentOrder, sections) => ({
      section,
      descriptor: buildLessonDescriptor(section, documentOrder, sections.length),
    }))
    .filter(({ section }) => !sectionIds || sectionIds.includes(section.id))
    .map(({ descriptor }) => descriptor);

const buildChunkDescriptor = (
  chunk: PdfTextChunk,
  previewChars: number
): ChunkMappingDescriptor => ({
  id: chunk.id,
  sequence: chunk.sequence,
  headingPath: chunk.headingPath,
  textPreview: buildCompactSnippet(chunk.text, previewChars),
  textLength: chunk.text.length,
});

const buildSectionMappingBatches = (
  sections: LessonMappingDescriptor[],
  options: { maxLessonsPerRequest?: number } = {}
): LessonMappingDescriptor[][] => {
  const maxLessonsPerRequest =
    options.maxLessonsPerRequest && options.maxLessonsPerRequest > 0
      ? options.maxLessonsPerRequest
      : MAX_MAPPING_LESSONS_PER_REQUEST;
  const batches: LessonMappingDescriptor[][] = [];
  let currentBatch: LessonMappingDescriptor[] = [];
  let currentJsonChars = 0;

  sections.forEach(section => {
    const sectionJsonChars = JSON.stringify(section).length;
    const shouldFlush =
      currentBatch.length > 0 &&
      (currentBatch.length >= maxLessonsPerRequest ||
        currentJsonChars + sectionJsonChars > MAX_MAPPING_LESSON_JSON_CHARS);

    if (shouldFlush) {
      batches.push(currentBatch);
      currentBatch = [];
      currentJsonChars = 0;
    }

    currentBatch.push(section);
    currentJsonChars += sectionJsonChars;
  });

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
};

const buildChunkMappingPrompt = (
  lessons: LessonMappingDescriptor[],
  chunks: ChunkMappingDescriptor[]
): string => `Sei un mapper semantico per Nous Reader.

Devi associare a ciascuna lezione i chunk del documento sorgente piu pertinenti.

REGOLE:
1. Lavora semanticamente anche se la lezione e in una lingua diversa dal documento.
2. Per ogni lezione scegli da 1 a ${MAX_PRIMARY_CHUNKS_PER_LESSON} chunk principali.
3. Scegli il numero minimo di chunk necessari.
4. Se un concetto e chiaramente a cavallo tra due chunk, puoi selezionarli entrambi.
5. Usa solo i chunk presenti nella lista.
6. I chunk sono riassunti compatti: basati su headingPath, preview e lunghezza.
7. Le lezioni sono gia in ordine didattico: quando possibile, assegna chunk in un ordine coerente con la sequenza del documento.
8. Evita di concentrare troppe lezioni sugli stessi primi chunk se il documento continua con contenuto nuovo rilevante.
9. Se il documento e progressivo, le lezioni successive dovrebbero in genere puntare a chunk con sequence uguale o maggiore rispetto alle lezioni precedenti, salvo richiami indispensabili.
10. Se una lezione rappresenta un blocco distinto del libro, preferisci chunk contigui della stessa zona invece di saltare avanti e indietro senza motivo.
11. Ogni lessonId presente in input deve comparire esattamente una volta nell output.
12. Non lasciare mai chunkIds vuoto: se il match e ambiguo scegli comunque i candidati migliori disponibili.
13. Restituisci SOLO JSON valido.

LEZIONI:
${JSON.stringify(lessons, null, 2)}

CHUNK DOCUMENTO:
${JSON.stringify(chunks, null, 2)}

Rispondi con:
{
  "mappings": [
    { "lessonId": "section-1", "chunkIds": ["chunk-001", "chunk-002"] }
  ]
}`;

const buildStrictChunkMappingPrompt = (
  lessons: LessonMappingDescriptor[],
  chunks: ChunkMappingDescriptor[]
): string => {
  const allowedLessonIds = lessons.map(lesson => lesson.lessonId);
  const allowedChunkIds = chunks.map(chunk => chunk.id);

  return `${buildChunkMappingPrompt(lessons, chunks)}

VINCOLI TASSATIVI DI OUTPUT:
- Devi restituire esattamente ${lessons.length} oggetto/i dentro mappings.
- Gli unici lessonId ammessi sono: ${JSON.stringify(allowedLessonIds)}.
- Gli unici chunkIds ammessi sono: ${JSON.stringify(allowedChunkIds)}.
- Ogni lessonId deve comparire una sola volta.
- Ogni mapping deve contenere da 1 a ${MAX_PRIMARY_CHUNKS_PER_LESSON} chunkIds validi.
- Se il match e ambiguo, scegli comunque i chunk piu probabili tra quelli ammessi.
- Non restituire testo fuori dal JSON.`;
};

const resolveCandidateChunksForMappingBatch = (
  documentIndex: PdfTextIndex,
  lessons: LessonMappingDescriptor[],
  options: {
    maxChunkCandidates?: number;
    minChunkCandidates?: number;
    windowPadding?: number;
  } = {}
): PdfTextChunk[] => {
  const maxChunkCandidates =
    options.maxChunkCandidates && options.maxChunkCandidates > 0
      ? options.maxChunkCandidates
      : MAX_MAPPING_CHUNK_CANDIDATES;
  const minChunkCandidates = clamp(
    options.minChunkCandidates && options.minChunkCandidates > 0
      ? options.minChunkCandidates
      : MIN_MAPPING_CHUNK_CANDIDATES,
    1,
    maxChunkCandidates
  );
  const windowPadding =
    options.windowPadding && options.windowPadding >= 0
      ? options.windowPadding
      : MAPPING_CHUNK_WINDOW_PADDING;

  if (documentIndex.chunks.length <= maxChunkCandidates || lessons.length === 0) {
    return documentIndex.chunks;
  }

  const totalChunks = documentIndex.chunks.length;
  const maxChunkIndex = totalChunks - 1;
  const lessonPositions = lessons.map(lesson => {
    const denominator = Math.max(1, lesson.totalLessons - 1);
    return lesson.totalLessons <= 1 ? 0.5 : lesson.documentOrder / denominator;
  });
  const startRatio = Math.min(...lessonPositions);
  const endRatio = Math.max(...lessonPositions);
  const estimatedStartIndex = Math.floor(startRatio * maxChunkIndex);
  const estimatedEndIndex = Math.ceil(endRatio * maxChunkIndex);
  const estimatedSpan = estimatedEndIndex - estimatedStartIndex + 1;
  const targetWindowSize = clamp(
    estimatedSpan + windowPadding * 2,
    minChunkCandidates,
    maxChunkCandidates
  );
  const windowCenter = (estimatedStartIndex + estimatedEndIndex) / 2;
  const windowStart =
    startRatio <= 0.02
      ? 0
      : endRatio >= 0.98
        ? Math.max(0, totalChunks - targetWindowSize)
        : clamp(Math.round(windowCenter - targetWindowSize / 2), 0, maxChunkIndex);
  const windowEnd = Math.min(maxChunkIndex, windowStart + targetWindowSize - 1);
  const adjustedWindowStart = Math.max(0, windowEnd - targetWindowSize + 1);

  return documentIndex.chunks.slice(adjustedWindowStart, windowEnd + 1);
};

const resolveChunkDescriptorsForBatch = (
  documentIndex: PdfTextIndex,
  lessons: LessonMappingDescriptor[],
  options: {
    maxChunkCandidates?: number;
    minChunkCandidates?: number;
    windowPadding?: number;
  } = {}
): ChunkMappingDescriptor[] => {
  let previewChars = MAX_MAPPING_CHUNK_PREVIEW_CHARS;
  const candidateChunks = resolveCandidateChunksForMappingBatch(documentIndex, lessons, options);
  let descriptors = candidateChunks.map(chunk => buildChunkDescriptor(chunk, previewChars));
  let promptLength = buildChunkMappingPrompt(lessons, descriptors).length;

  while (
    promptLength > TARGET_MAPPING_PROMPT_CHARS &&
    previewChars > MIN_MAPPING_CHUNK_PREVIEW_CHARS
  ) {
    const scaledPreview =
      Math.floor((previewChars * TARGET_MAPPING_PROMPT_CHARS) / promptLength) - 8;
    const nextPreviewChars = clamp(
      scaledPreview,
      MIN_MAPPING_CHUNK_PREVIEW_CHARS,
      previewChars - 8
    );

    if (nextPreviewChars >= previewChars) {
      break;
    }

    previewChars = nextPreviewChars;
    descriptors = candidateChunks.map(chunk => buildChunkDescriptor(chunk, previewChars));
    promptLength = buildChunkMappingPrompt(lessons, descriptors).length;
  }

  return descriptors;
};

const parseChunkMappings = (
  response: string,
  availableChunkIds: Set<string>
): ParsedChunkMappingsResult => {
  const parsed = parseCleanJson<ChunkMappingResponse>(response || '{}');
  const mappings = new Map<string, string[]>();
  const rejectedChunkIds = new Set<string>();
  const rejectedLessonIds = new Set<string>();
  let emptyChunkIdsCount = 0;
  let invalidChunkIdCount = 0;
  let invalidShapeCount = 0;
  let missingLessonIdCount = 0;

  if (!Array.isArray(parsed.mappings)) {
    return {
      acceptedLessonIds: [],
      acceptedMappingCount: 0,
      emptyChunkIdsCount,
      invalidChunkIdCount,
      invalidShapeCount: 1,
      mappings,
      missingLessonIdCount,
      rawMappingCount: 0,
      rejectedChunkIds: [],
      rejectedLessonIds: [],
    };
  }

  parsed.mappings.forEach(mapping => {
    if (!mapping || typeof mapping !== 'object') {
      invalidShapeCount += 1;
      return;
    }

    if (!mapping.lessonId) {
      missingLessonIdCount += 1;
    }

    if (!Array.isArray(mapping.chunkIds)) {
      invalidShapeCount += 1;
      if (mapping.lessonId) {
        rejectedLessonIds.add(mapping.lessonId);
      }
      return;
    }

    const chunkIds = mapping.chunkIds.filter((chunkId): chunkId is string => {
      if (typeof chunkId !== 'string') {
        invalidShapeCount += 1;
        return false;
      }

      if (!availableChunkIds.has(chunkId)) {
        invalidChunkIdCount += 1;
        rejectedChunkIds.add(chunkId);
        return false;
      }

      return true;
    });

    if (chunkIds.length === 0) {
      emptyChunkIdsCount += 1;
      if (mapping.lessonId) {
        rejectedLessonIds.add(mapping.lessonId);
      }
      return;
    }

    if (mapping.lessonId) {
      mappings.set(mapping.lessonId, chunkIds.slice(0, MAX_PRIMARY_CHUNKS_PER_LESSON));
    }
  });

  return {
    acceptedLessonIds: Array.from(mappings.keys()),
    acceptedMappingCount: mappings.size,
    emptyChunkIdsCount,
    invalidChunkIdCount,
    invalidShapeCount,
    mappings,
    missingLessonIdCount,
    rawMappingCount: parsed.mappings.length,
    rejectedChunkIds: Array.from(rejectedChunkIds).slice(0, 24),
    rejectedLessonIds: Array.from(rejectedLessonIds).slice(0, 24),
  };
};

const resolveMappingMaxTokens = (
  lessonCount: number,
  options: { focusedRepair?: boolean } = {}
): number => {
  const minTokens = options.focusedRepair
    ? MIN_REPAIR_MAPPING_OUTPUT_TOKENS
    : MIN_MAPPING_OUTPUT_TOKENS;
  const tokensPerLesson = options.focusedRepair
    ? REPAIR_MAPPING_OUTPUT_TOKENS_PER_LESSON
    : MAPPING_OUTPUT_TOKENS_PER_LESSON;

  return Math.min(MAX_MAPPING_OUTPUT_TOKENS, Math.max(minTokens, lessonCount * tokensPerLesson));
};

const getTargetSectionsForMapping = (
  plan: LearningPlan,
  sectionIds?: string[]
): LearningPlan['sections'] =>
  getMappablePlanSections(plan).filter(section => !sectionIds || sectionIds.includes(section.id));

const resolveFallbackCandidateChunks = (documentIndex: PdfTextIndex): PdfTextChunk[] => {
  if (documentIndex.chunks.length === 0) {
    return [];
  }

  const pageCount = documentIndex.pageCount;
  if (!pageCount || pageCount < PDF_PLAN_MIN_PAGES_FOR_EDGE_EXCLUSION) {
    return documentIndex.chunks;
  }

  const substantiveRange = resolvePdfPlanSubstantiveRange(pageCount);
  const substantiveChunks = documentIndex.chunks.filter(chunk => {
    const span = resolvePdfChunkPageSpan(documentIndex, chunk, pageCount);

    if (!span) {
      return true;
    }

    return span.endPage >= substantiveRange.startPage && span.startPage <= substantiveRange.endPage;
  });

  return substantiveChunks.length > 0 ? substantiveChunks : documentIndex.chunks;
};

const buildFallbackChunkAssignments = (
  plan: LearningPlan,
  documentIndex: PdfTextIndex
): Map<string, string[]> => {
  const candidateChunks = resolveFallbackCandidateChunks(documentIndex);
  const targetSections = plan.sections.filter(section => section.type !== 'summary');
  const sectionCount = targetSections.length;

  if (candidateChunks.length === 0 || sectionCount === 0) {
    return new Map();
  }

  const windowSize =
    candidateChunks.length >= sectionCount * 2
      ? Math.min(2, MAX_PRIMARY_CHUNKS_PER_LESSON, candidateChunks.length)
      : 1;
  const maxStartIndex = Math.max(0, candidateChunks.length - windowSize);

  return new Map(
    targetSections
      .map((section, index) => {
        const ratio = sectionCount === 1 ? 0.5 : index / Math.max(1, sectionCount - 1);
        const startIndex = Math.round(ratio * maxStartIndex);
        const chunkIds = candidateChunks
          .slice(startIndex, startIndex + windowSize)
          .map(chunk => chunk.id);

        return [section.id, chunkIds] as const;
      })
      .filter(([, chunkIds]) => chunkIds.length > 0)
  );
};

const buildMappingBatchDebugPayload = (
  traceLabel: string,
  model: string,
  lessonBatch: LessonMappingDescriptor[],
  chunkDescriptors: ChunkMappingDescriptor[],
  prompt: string,
  maxTokens: number
) => ({
  traceLabel,
  model,
  lessonCount: lessonBatch.length,
  lessonIds: lessonBatch.map(lesson => lesson.lessonId),
  lessonTitles: lessonBatch.map(lesson => lesson.title),
  chunkCount: chunkDescriptors.length,
  firstChunkId: chunkDescriptors[0]?.id || null,
  lastChunkId: chunkDescriptors[chunkDescriptors.length - 1]?.id || null,
  promptChars: prompt.length,
  maxTokens,
});

const buildMappingParseDebugPayload = (
  basePayload: ReturnType<typeof buildMappingBatchDebugPayload>,
  response: string,
  parsed: ParsedChunkMappingsResult
) => ({
  ...basePayload,
  responseChars: response.length,
  rawMappingCount: parsed.rawMappingCount,
  acceptedMappingCount: parsed.acceptedMappingCount,
  acceptedLessonIds: parsed.acceptedLessonIds,
  rejectedLessonIds: parsed.rejectedLessonIds,
  invalidShapeCount: parsed.invalidShapeCount,
  missingLessonIdCount: parsed.missingLessonIdCount,
  invalidChunkIdCount: parsed.invalidChunkIdCount,
  emptyChunkIdsCount: parsed.emptyChunkIdsCount,
  rejectedChunkIds: parsed.rejectedChunkIds,
});

const hasSuspiciousChunkMappings = (
  parsedMappings: ParsedChunkMappingsResult,
  expectedLessonCount: number
): boolean =>
  parsedMappings.acceptedMappingCount < expectedLessonCount ||
  parsedMappings.invalidShapeCount > 0 ||
  parsedMappings.invalidChunkIdCount > 0 ||
  parsedMappings.emptyChunkIdsCount > 0 ||
  parsedMappings.missingLessonIdCount > 0;

const requestChunkMappings = async ({
  maxTokens,
  model,
  prompt,
  useJsonResponseFormat,
}: {
  maxTokens: number;
  model: string;
  prompt: string;
  useJsonResponseFormat: boolean;
}): Promise<string> =>
  retryWithBackoff(
    () =>
      callOpenRouter({
        disableModelOverride: true,
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: useJsonResponseFormat ? { type: 'json_object' } : undefined,
        max_tokens: maxTokens,
        temperature: MAPPING_REQUEST_TEMPERATURE,
      }),
    2,
    500
  );

const parseChunkMappingsOrThrow = (
  response: string,
  availableChunkIds: Set<string>,
  parseFailurePayload: Record<string, unknown>,
  traceLabel: string
): ParsedChunkMappingsResult => {
  try {
    return parseChunkMappings(response || '{}', availableChunkIds);
  } catch (parseError) {
    console.warn(
      `[Nous][DocumentIndex] ${traceLabel} response could not be parsed as chunk mappings.`,
      parseFailurePayload,
      parseError
    );
    pushNousDebugTrace('pdf-plan:mapping-parse-failed', {
      ...parseFailurePayload,
      errorMessage: parseError instanceof Error ? parseError.message : String(parseError),
    });
    throw parseError;
  }
};

// ── Core mapping ───────────────────────────────────────────────────────

const mapLessonsToChunkIds = async (
  plan: LearningPlan,
  documentIndex: PdfTextIndex,
  options: {
    maxLessonsPerRequest?: number;
    model?: string;
    sectionIds?: string[];
    traceLabel?: string;
  } = {}
): Promise<Map<string, string[]>> => {
  const targetSections = getTargetLessonDescriptorsForMapping(plan, options.sectionIds);

  if (targetSections.length === 0 || documentIndex.chunks.length === 0) {
    return new Map();
  }

  const mappings = new Map<string, string[]>();
  const sectionBatches = buildSectionMappingBatches(targetSections, {
    maxLessonsPerRequest: options.maxLessonsPerRequest,
  });
  let firstBatchError: unknown = null;
  let successfulBatchCount = 0;
  const traceLabel = options.traceLabel || 'Mapping';
  const model = options.model || MODEL_FLASH;
  const isFocusedRepair =
    (options.maxLessonsPerRequest ?? MAX_MAPPING_LESSONS_PER_REQUEST) ===
    DEEP_REPAIR_MAX_MAPPING_LESSONS_PER_REQUEST;
  const chunkWindowOptions = isFocusedRepair
    ? {
        maxChunkCandidates: MAX_REPAIR_MAPPING_CHUNK_CANDIDATES,
        minChunkCandidates: MIN_REPAIR_MAPPING_CHUNK_CANDIDATES,
        windowPadding: REPAIR_MAPPING_CHUNK_WINDOW_PADDING,
      }
    : {};

  for (const lessonBatch of sectionBatches) {
    const chunkDescriptors = resolveChunkDescriptorsForBatch(
      documentIndex,
      lessonBatch,
      chunkWindowOptions
    );
    const candidateChunkIds = new Set(chunkDescriptors.map(chunk => chunk.id));
    const prompt = buildChunkMappingPrompt(lessonBatch, chunkDescriptors);
    const maxTokens = resolveMappingMaxTokens(lessonBatch.length, {
      focusedRepair: isFocusedRepair,
    });
    const batchDebugPayload = buildMappingBatchDebugPayload(
      traceLabel,
      model,
      lessonBatch,
      chunkDescriptors,
      prompt,
      maxTokens
    );

    logPdfPlanDebug('Mapping batch request', batchDebugPayload);
    pushNousDebugTrace('pdf-plan:mapping-batch-start', batchDebugPayload);

    try {
      let rawResponse = await requestChunkMappings({
        maxTokens,
        model,
        prompt,
        useJsonResponseFormat: true,
      });
      let parseFailurePayload = {
        ...batchDebugPayload,
        responseChars: rawResponse.length,
        rawResponsePreview: buildCompactSnippet(rawResponse, MAX_MAPPING_RAW_RESPONSE_DEBUG_CHARS),
      };
      let parsedMappings = parseChunkMappingsOrThrow(
        rawResponse,
        candidateChunkIds,
        parseFailurePayload,
        traceLabel
      );

      if (isFocusedRepair && hasSuspiciousChunkMappings(parsedMappings, lessonBatch.length)) {
        const retryPrompt = buildStrictChunkMappingPrompt(lessonBatch, chunkDescriptors);
        const retryPayload = {
          ...batchDebugPayload,
          retryKind: 'strict-single-lesson',
          retryPromptChars: retryPrompt.length,
        };

        logPdfPlanDebug('Mapping batch retry request', retryPayload);
        pushNousDebugTrace('pdf-plan:mapping-batch-retry-start', retryPayload);

        try {
          const retryResponse = await requestChunkMappings({
            maxTokens,
            model,
            prompt: retryPrompt,
            useJsonResponseFormat: false,
          });
          const retryParseFailurePayload = {
            ...retryPayload,
            responseChars: retryResponse.length,
            rawResponsePreview: buildCompactSnippet(
              retryResponse,
              MAX_MAPPING_RAW_RESPONSE_DEBUG_CHARS
            ),
          };
          const retryParsedMappings = parseChunkMappingsOrThrow(
            retryResponse,
            candidateChunkIds,
            retryParseFailurePayload,
            `${traceLabel} strict retry`
          );
          const retryDebugPayload = buildMappingParseDebugPayload(
            {
              ...batchDebugPayload,
              promptChars: retryPrompt.length,
            },
            retryResponse,
            retryParsedMappings
          );

          logPdfPlanDebug('Mapping batch retry result', retryDebugPayload);
          pushNousDebugTrace('pdf-plan:mapping-batch-retry-result', retryDebugPayload);

          if (retryParsedMappings.acceptedMappingCount > parsedMappings.acceptedMappingCount) {
            rawResponse = retryResponse;
            parsedMappings = retryParsedMappings;
            parseFailurePayload = retryParseFailurePayload;
          }
        } catch (retryError) {
          console.warn(
            `[Nous][DocumentIndex] ${traceLabel} strict retry failed for ${lessonBatch.length} lesson(s).`,
            retryError
          );
        }
      }

      const parseDebugPayload = buildMappingParseDebugPayload(
        batchDebugPayload,
        rawResponse,
        parsedMappings
      );
      const isSuspiciousMapping = hasSuspiciousChunkMappings(parsedMappings, lessonBatch.length);
      const resultDebugPayload = {
        ...parseDebugPayload,
        rawResponsePreview: isSuspiciousMapping
          ? buildCompactSnippet(rawResponse, MAX_MAPPING_RAW_RESPONSE_DEBUG_CHARS)
          : '[omitted: all lessons mapped]',
      };

      logPdfPlanDebug('Mapping batch result', resultDebugPayload);
      pushNousDebugTrace('pdf-plan:mapping-batch-result', resultDebugPayload);

      if (isSuspiciousMapping) {
        console.warn(
          `[Nous][DocumentIndex] ${traceLabel} produced incomplete or rejected chunk mappings.`,
          resultDebugPayload
        );
      }

      parsedMappings.mappings.forEach((chunkIds, lessonId) => {
        mappings.set(lessonId, chunkIds);
      });

      if (parsedMappings.acceptedMappingCount === 0) {
        throw new Error(`${traceLabel} returned no valid chunk mappings.`);
      }

      successfulBatchCount += 1;
    } catch (error) {
      firstBatchError ??= error;
      console.warn(
        `[Nous][DocumentIndex] ${traceLabel} batch failed for ${lessonBatch.length} lesson(s).`,
        error
      );
    }
  }

  if (successfulBatchCount === 0 && firstBatchError) {
    throw firstBatchError;
  }

  return mappings;
};

const applyRecoveredChunkMappings = (
  plan: LearningPlan,
  mappings: Map<string, string[]>
): LearningPlan => ({
  ...plan,
  sections: plan.sections.map(section =>
    mappings.has(section.id)
      ? {
          ...section,
          primaryChunkIds: mappings.get(section.id),
          primaryChunkMappingSource: 'mapped' as const,
        }
      : section
  ),
});

const applyFallbackChunkMappings = (
  plan: LearningPlan,
  fallbackAssignments: Map<string, string[]>,
  sectionIds: string[]
): LearningPlan => {
  const fallbackSectionIdSet = new Set(sectionIds);

  return {
    ...plan,
    sections: plan.sections.map(section => {
      if (!fallbackSectionIdSet.has(section.id)) {
        return section;
      }

      const fallbackChunkIds = fallbackAssignments.get(section.id);
      if (!fallbackChunkIds || fallbackChunkIds.length === 0) {
        return section;
      }

      return {
        ...section,
        primaryChunkIds: [...fallbackChunkIds],
        primaryChunkMappingSource: 'fallback' as const,
      };
    }),
  };
};

const resolveSectionsNeedingMappingRepair = (
  file: FileData,
  plan: LearningPlan,
  documentIndex: PdfTextIndex,
  targetSectionIds: string[],
  validateWholePlan: boolean
): string[] => {
  const targetSectionIdSet = new Set(targetSectionIds);
  const targetedSections = plan.sections.filter(
    section => targetSectionIdSet.has(section.id) && section.type !== 'summary'
  );
  const explicitlyBrokenSectionIds = targetedSections
    .filter(
      section =>
        !section.primaryChunkIds ||
        section.primaryChunkIds.length === 0 ||
        section.primaryChunkMappingSource === 'fallback'
    )
    .map(section => section.id);

  if (explicitlyBrokenSectionIds.length > 0) {
    return explicitlyBrokenSectionIds;
  }

  if (!validateWholePlan) {
    return [];
  }

  return getPdfProjectHydrationState(file, plan, documentIndex) === 'ready' ? [] : targetSectionIds;
};

const describeSectionTitles = (plan: LearningPlan, sectionIds: string[]): string =>
  sectionIds
    .slice(0, 4)
    .map(sectionId => plan.sections.find(section => section.id === sectionId)?.title || sectionId)
    .join(', ');

// ── Public exports ─────────────────────────────────────────────────────

export const preparePdfLessonMappings = async (
  file: FileData,
  plan: LearningPlan,
  existingIndex?: PdfTextIndex | null,
  sectionIds?: string[]
): Promise<{ learningPlan: LearningPlan; documentIndex: PdfTextIndex | null }> => {
  if (!isPdfFile(file)) {
    return { learningPlan: plan, documentIndex: null };
  }

  const pdfSession = await getPdfTextSession(file);
  if (!pdfSession?.extractedText?.trim()) {
    return { learningPlan: plan, documentIndex: existingIndex ?? null };
  }

  const sourceHash = pdfSession.sourceHash || existingIndex?.sourceHash;
  const documentIndex =
    existingIndex && existingIndex.sourceHash === sourceHash && existingIndex.chunks.length > 0
      ? existingIndex
      : buildPdfTextIndex(pdfSession.extractedText, sourceHash, file.name, pdfSession.pages);
  const targetSectionIds = getTargetSectionsForMapping(plan, sectionIds).map(section => section.id);
  const validateWholePlan = !sectionIds || sectionIds.length === 0;
  let recoveredMappings = new Map<string, string[]>();
  let lastDeepRepairTargetIds: string[] = [];

  try {
    recoveredMappings = await mapLessonsToChunkIds(plan, documentIndex, {
      model: MODEL_FLASH,
      sectionIds,
      traceLabel: 'Fast mapping',
    });
  } catch (error) {
    console.warn(
      '[Nous][DocumentIndex] Fast mapping failed, escalating to deep PDF remapping.',
      error
    );
  }

  let learningPlan = applyRecoveredChunkMappings(plan, recoveredMappings);
  let sectionsNeedingRepair = resolveSectionsNeedingMappingRepair(
    file,
    learningPlan,
    documentIndex,
    targetSectionIds,
    validateWholePlan
  );

  if (sectionsNeedingRepair.length > 0) {
    lastDeepRepairTargetIds = sectionsNeedingRepair;
    pushNousDebugTrace('pdf-plan:deep-repair-start', {
      fileName: file.name,
      sectionCount: sectionsNeedingRepair.length,
      sectionTitles: sectionsNeedingRepair.slice(0, 8).map(sectionId => {
        const section = plan.sections.find(currentSection => currentSection.id === sectionId);
        return section?.title || sectionId;
      }),
    });

    try {
      const deepRepairMappings = await mapLessonsToChunkIds(plan, documentIndex, {
        maxLessonsPerRequest: DEEP_REPAIR_MAX_MAPPING_LESSONS_PER_REQUEST,
        model: MODEL_REASONING,
        sectionIds: sectionsNeedingRepair,
        traceLabel: 'Deep repair',
      });

      recoveredMappings = new Map([...recoveredMappings, ...deepRepairMappings]);
      learningPlan = applyRecoveredChunkMappings(plan, recoveredMappings);
      sectionsNeedingRepair = resolveSectionsNeedingMappingRepair(
        file,
        learningPlan,
        documentIndex,
        targetSectionIds,
        validateWholePlan
      );
    } catch (error) {
      console.warn(
        '[Nous][DocumentIndex] Deep PDF remapping failed, continuing with fallback mapping.',
        error
      );
      pushNousDebugTrace('pdf-plan:deep-repair-failed', {
        errorMessage: error instanceof Error ? error.message : String(error),
        fileName: file.name,
        sectionCount: sectionsNeedingRepair.length,
      });
    }
  }

  if (
    sectionsNeedingRepair.length > 0 &&
    validateWholePlan &&
    lastDeepRepairTargetIds.length > 0 &&
    lastDeepRepairTargetIds.length !== targetSectionIds.length
  ) {
    pushNousDebugTrace('pdf-plan:full-deep-repair-start', {
      fileName: file.name,
      sectionCount: targetSectionIds.length,
    });

    try {
      const fullDeepRepairMappings = await mapLessonsToChunkIds(plan, documentIndex, {
        maxLessonsPerRequest: DEEP_REPAIR_MAX_MAPPING_LESSONS_PER_REQUEST,
        model: MODEL_REASONING,
        sectionIds: targetSectionIds,
        traceLabel: 'Full deep repair',
      });

      recoveredMappings = new Map([...recoveredMappings, ...fullDeepRepairMappings]);
      learningPlan = applyRecoveredChunkMappings(plan, recoveredMappings);
      sectionsNeedingRepair = resolveSectionsNeedingMappingRepair(
        file,
        learningPlan,
        documentIndex,
        targetSectionIds,
        validateWholePlan
      );
    } catch (error) {
      console.warn(
        '[Nous][DocumentIndex] Full PDF remapping failed, continuing with fallback mapping.',
        error
      );
      pushNousDebugTrace('pdf-plan:full-deep-repair-failed', {
        errorMessage: error instanceof Error ? error.message : String(error),
        fileName: file.name,
        sectionCount: targetSectionIds.length,
      });
    }
  }

  if (sectionsNeedingRepair.length > 0) {
    const fallbackAssignments = buildFallbackChunkAssignments(learningPlan, documentIndex);
    const fallbackSectionIds = sectionsNeedingRepair.filter(
      sectionId => (fallbackAssignments.get(sectionId)?.length || 0) > 0
    );
    const unresolvedSectionIds = sectionsNeedingRepair.filter(
      sectionId => !fallbackSectionIds.includes(sectionId)
    );

    learningPlan = applyFallbackChunkMappings(
      learningPlan,
      fallbackAssignments,
      fallbackSectionIds
    );

    console.warn(
      `[Nous][DocumentIndex] Unable to recover PDF lesson mappings for ${sectionsNeedingRepair.length} section(s); continuing with fallback chunk assignments for ${fallbackSectionIds.length} section(s).`,
      describeSectionTitles(plan, sectionsNeedingRepair)
    );
    pushNousDebugTrace('pdf-plan:mapping-fallback', {
      fileName: file.name,
      failedSectionCount: sectionsNeedingRepair.length,
      fallbackSectionCount: fallbackSectionIds.length,
      unresolvedSectionCount: unresolvedSectionIds.length,
      sectionTitles: sectionsNeedingRepair.slice(0, 8).map(sectionId => {
        const section = plan.sections.find(currentSection => currentSection.id === sectionId);
        return section?.title || sectionId;
      }),
      unresolvedSectionTitles: unresolvedSectionIds.slice(0, 8).map(sectionId => {
        const section = plan.sections.find(currentSection => currentSection.id === sectionId);
        return section?.title || sectionId;
      }),
    });

    const coverageReport = emitPdfPlanCoverageDiagnostics(
      file.name,
      learningPlan,
      documentIndex,
      pdfSession,
      'fallback'
    );
    return {
      learningPlan,
      documentIndex: applyPdfMappingQuality(documentIndex, coverageReport),
    };
  }

  const coverageReport = emitPdfPlanCoverageDiagnostics(
    file.name,
    learningPlan,
    documentIndex,
    pdfSession,
    'mapped'
  );
  return {
    learningPlan,
    documentIndex: applyPdfMappingQuality(documentIndex, coverageReport),
  };
};

export const needsPdfLessonMappingMigration = (
  file: FileData | null,
  plan: LearningPlan | null,
  documentIndex: PdfTextIndex | null | undefined
): boolean => {
  const hydrationState = getPdfProjectHydrationState(file, plan, documentIndex);
  return hydrationState !== 'ready' && hydrationState !== 'idle';
};

export { getPdfProjectHydrationState as getPdfLessonMappingState } from '../../../utils/pdf/projectHydration.ts';
