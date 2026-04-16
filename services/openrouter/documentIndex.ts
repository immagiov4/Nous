import type {
  FileData,
  LearningPlan,
  PdfTextChunk,
  PdfTextIndex,
  PdfTextPage,
} from '../../types.ts';
import { getPdfProjectHydrationState } from '../../utils/pdf/projectHydration.ts';
import { pushLuminaDebugTrace } from '../core/debugTrace.ts';
import { getPdfTextSession } from './pdfAssets.ts';
import {
  callOpenRouter,
  isPdfFile,
  MODEL_FLASH,
  MODEL_REASONING,
  parseCleanJson,
  retryWithBackoff,
} from './shared.ts';

const TARGET_CHUNK_CHARS = 7000;
const MIN_CHUNK_CHARS = 3500;
const MAX_CHUNK_CHARS = 9500;
const MAX_PRIMARY_CHUNKS_PER_LESSON = 3;
const MAX_CONTEXT_CHUNKS = 6;
const MAX_MAPPING_LESSONS_PER_REQUEST = 8;
const MAX_MAPPING_LESSON_JSON_CHARS = 7000;
const TARGET_MAPPING_PROMPT_CHARS = 180000;
const MIN_MAPPING_CHUNK_PREVIEW_CHARS = 96;
const MAX_MAPPING_CHUNK_PREVIEW_CHARS = 480;
const MAX_MAPPING_OUTPUT_TOKENS = 2048;
const MIN_MAPPING_OUTPUT_TOKENS = 768;
const MIN_REPAIR_MAPPING_OUTPUT_TOKENS = 1024;
const MAPPING_OUTPUT_TOKENS_PER_LESSON = 220;
const REPAIR_MAPPING_OUTPUT_TOKENS_PER_LESSON = 512;
const MAX_MAPPING_RAW_RESPONSE_DEBUG_CHARS = 6000;
const MAPPING_REQUEST_TEMPERATURE = 0;
const DEEP_REPAIR_MAX_MAPPING_LESSONS_PER_REQUEST = 1;
const MIN_MAPPING_CHUNK_CANDIDATES = 36;
const MAX_MAPPING_CHUNK_CANDIDATES = 96;
const MAPPING_CHUNK_WINDOW_PADDING = 12;
const MIN_REPAIR_MAPPING_CHUNK_CANDIDATES = 20;
const MAX_REPAIR_MAPPING_CHUNK_CANDIDATES = 32;
const REPAIR_MAPPING_CHUNK_WINDOW_PADDING = 5;
const HEADING_MAX_WORDS = 14;
const HEADING_MAX_CHARS = 120;
const PDF_PLAN_COVERAGE_TARGET_RATIO = 0.9;
const PDF_PLAN_COVERAGE_WARN_RATIO = 0.75;
const PDF_PLAN_EDGE_EXCLUSION_RATIO = 0.05;
const PDF_PLAN_MAX_EDGE_PAGES = 6;
const PDF_PLAN_MIN_PAGES_FOR_EDGE_EXCLUSION = 18;
const PDF_PLAN_MAX_REPORTED_GAPS = 8;
const PDF_PLAN_FRAGMENTATION_SLACK_PAGES = 2;

type PageRangeSource = 'exact' | 'estimated' | 'mixed' | 'missing';

interface PdfPlanLessonCoverage {
  lessonId: string;
  title: string;
  type: LearningPlan['sections'][number]['type'];
  chunkCount: number;
  chunkIds: string[];
  coveredPageCount: number;
  coveredPages: number[];
  flags: string[];
  pageRange: string | null;
  pageRangeLength: number;
  pageRangeSource: PageRangeSource;
}

interface PdfPlanPageGap {
  endPage: number;
  pageCount: number;
  startPage: number;
}

interface PdfPlanCoverageReport {
  coveredSubstantivePages: number;
  coverageRatio: number;
  gapCount: number;
  gaps: PdfPlanPageGap[];
  lessonCount: number;
  lessonPageHeuristic: { max: number; min: number } | null;
  lessonSpans: PdfPlanLessonCoverage[];
  mappedLessonCount: number;
  mappingSource: 'fallback' | 'mapped';
  missingLessonCount: number;
  pageCount: number;
  parser: 'pdftotext' | 'pdf-parse' | 'unknown';
  substantiveRange: { endPage: number; pageCount: number; startPage: number };
  warnings: string[];
}

interface SectionBuffer {
  headingPath: string[];
  paragraphs: string[];
  startOffset: number;
  endOffset: number;
}

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

const normalizeWhitespace = (text: string): string =>
  text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

interface PdfPageLayoutEntry extends PdfTextPage {
  startOffset: number;
  endOffset: number;
}

export interface PdfPageTextLayout {
  text: string;
  pages: PdfPageLayoutEntry[];
}

const PAGE_TEXT_SEPARATOR = '\n\n';

export const buildPdfPageTextLayout = (
  pages: PdfTextPage[] | null | undefined
): PdfPageTextLayout | null => {
  if (!Array.isArray(pages) || pages.length === 0) {
    return null;
  }

  let combinedText = '';
  const normalizedPages = pages
    .filter(
      (page): page is PdfTextPage =>
        Boolean(page) && Number.isInteger(page.pageNumber) && page.pageNumber > 0
    )
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .map(page => {
      const normalizedText = normalizeWhitespace(page.text || '');
      const needsSeparator = combinedText.length > 0 && normalizedText.length > 0;
      if (needsSeparator) {
        combinedText += PAGE_TEXT_SEPARATOR;
      }

      const startOffset = combinedText.length;
      if (normalizedText.length > 0) {
        combinedText += normalizedText;
      }

      return {
        pageNumber: page.pageNumber,
        text: normalizedText,
        startOffset,
        endOffset: combinedText.length,
      };
    });

  return {
    text: combinedText,
    pages: normalizedPages,
  };
};

const resolveChunkPageSpanFromLayout = (
  startOffset: number,
  endOffset: number,
  pageLayout: PdfPageTextLayout | null | undefined
): { startPage: number; endPage: number } | null => {
  if (!pageLayout || pageLayout.pages.length === 0) {
    return null;
  }

  const pagesWithText = pageLayout.pages.filter(page => page.endOffset > page.startOffset);
  if (pagesWithText.length === 0) {
    return null;
  }

  const normalizedEndOffset = Math.max(startOffset + 1, endOffset);
  const overlappingPages = pagesWithText.filter(
    page => page.startOffset < normalizedEndOffset && page.endOffset > startOffset
  );
  if (overlappingPages.length > 0) {
    return {
      startPage: overlappingPages[0].pageNumber,
      endPage: overlappingPages[overlappingPages.length - 1].pageNumber,
    };
  }

  const midpoint = (startOffset + normalizedEndOffset) / 2;
  const closestPage = pagesWithText
    .map(page => ({
      page,
      distance:
        midpoint < page.startOffset
          ? page.startOffset - midpoint
          : midpoint > page.endOffset
            ? midpoint - page.endOffset
            : 0,
    }))
    .sort((left, right) => left.distance - right.distance)[0]?.page;

  return closestPage
    ? {
        startPage: closestPage.pageNumber,
        endPage: closestPage.pageNumber,
      }
    : null;
};

const splitParagraphs = (text: string): string[] =>
  normalizeWhitespace(text)
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

const isHeadingCandidate = (paragraph: string): boolean => {
  const compact = paragraph.replace(/\s+/g, ' ').trim();
  if (!compact || compact.length > HEADING_MAX_CHARS) {
    return false;
  }

  const words = compact.split(' ');
  if (words.length > HEADING_MAX_WORDS) {
    return false;
  }

  if (/[.!?;:]$/.test(compact)) {
    return false;
  }

  if (/^\d+(\.\d+)*\s+/.test(compact) || /^[IVXLC]+\.\s+/i.test(compact)) {
    return true;
  }

  const letterCount = compact.replace(/[^A-Za-z]/g, '').length;
  if (letterCount === 0) {
    return false;
  }

  const uppercaseCount = compact.replace(/[^A-Z]/g, '').length;
  if (uppercaseCount / letterCount > 0.7) {
    return true;
  }

  const titleCaseWords = words.filter(word => /^[A-Z][a-z]+/.test(word)).length;
  return titleCaseWords >= Math.max(2, Math.ceil(words.length * 0.6));
};

const inferHeadingLevel = (heading: string): number => {
  const numberingMatch = heading.match(/^(\d+(?:\.\d+)*)\s+/);
  if (numberingMatch) {
    return Math.min(4, numberingMatch[1].split('.').length);
  }

  if (/^[IVXLC]+\.\s+/i.test(heading) || heading === heading.toUpperCase()) {
    return 1;
  }

  return 2;
};

const applyHeadingToPath = (path: string[], heading: string): string[] => {
  const level = inferHeadingLevel(heading);
  const nextPath = path.slice(0, Math.max(0, level - 1));
  nextPath[level - 1] = heading;
  return nextPath.filter(Boolean);
};

const pushSection = (sections: SectionBuffer[], section: SectionBuffer | null) => {
  if (!section || section.paragraphs.length === 0) {
    return;
  }

  sections.push({
    headingPath: [...section.headingPath],
    paragraphs: [...section.paragraphs],
    startOffset: section.startOffset,
    endOffset: section.endOffset,
  });
};

const buildSections = (text: string): SectionBuffer[] => {
  const paragraphs = splitParagraphs(text);
  const sections: SectionBuffer[] = [];
  let headingPath: string[] = [];
  let offset = 0;
  let current: SectionBuffer | null = null;

  paragraphs.forEach(paragraph => {
    const startOffset = offset;
    offset += paragraph.length + 2;

    if (isHeadingCandidate(paragraph)) {
      pushSection(sections, current);
      headingPath = applyHeadingToPath(headingPath, paragraph);
      current = null;
      return;
    }

    if (!current) {
      current = {
        headingPath: [...headingPath],
        paragraphs: [paragraph],
        startOffset,
        endOffset: startOffset + paragraph.length,
      };
      return;
    }

    current.paragraphs.push(paragraph);
    current.endOffset = startOffset + paragraph.length;
  });

  pushSection(sections, current);
  return sections;
};

const buildChunkText = (paragraphs: string[]): string => paragraphs.join('\n\n').trim();

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const logPdfPlanDebug = (label: string, payload: Record<string, unknown>) => {
  console.groupCollapsed(`[Lumina][PDF Plan] ${label}`);
  Object.entries(payload).forEach(([key, value]) => {
    console.info(key, value);
  });
  console.groupEnd();
};

const formatPageRange = (
  startPage: number | undefined,
  endPage: number | undefined
): string | null => {
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage)) {
    return null;
  }

  return startPage === endPage ? `pag. ${startPage}` : `pag. ${startPage}-${endPage}`;
};

const expandPageRange = (startPage: number, endPage: number): number[] =>
  Array.from({ length: Math.max(0, endPage - startPage + 1) }, (_, index) => startPage + index);

const compressPagesToGaps = (pages: number[]): PdfPlanPageGap[] => {
  if (pages.length === 0) {
    return [];
  }

  const sortedPages = [...pages].sort((left, right) => left - right);
  const gaps: PdfPlanPageGap[] = [];
  let rangeStart = sortedPages[0];
  let previousPage = sortedPages[0];

  for (let index = 1; index < sortedPages.length; index += 1) {
    const page = sortedPages[index];
    if (page === previousPage + 1) {
      previousPage = page;
      continue;
    }

    gaps.push({
      startPage: rangeStart,
      endPage: previousPage,
      pageCount: previousPage - rangeStart + 1,
    });
    rangeStart = page;
    previousPage = page;
  }

  gaps.push({
    startPage: rangeStart,
    endPage: previousPage,
    pageCount: previousPage - rangeStart + 1,
  });
  return gaps;
};

const resolvePdfPlanSubstantiveRange = (pageCount: number) => {
  if (pageCount < PDF_PLAN_MIN_PAGES_FOR_EDGE_EXCLUSION) {
    return {
      startPage: 1,
      endPage: pageCount,
      pageCount,
    };
  }

  const edgePages = clamp(
    Math.round(pageCount * PDF_PLAN_EDGE_EXCLUSION_RATIO),
    1,
    PDF_PLAN_MAX_EDGE_PAGES
  );
  const startPage = Math.min(pageCount, 1 + edgePages);
  const endPage = Math.max(startPage, pageCount - edgePages);
  return {
    startPage,
    endPage,
    pageCount: endPage - startPage + 1,
  };
};

const resolveSoftLessonPageBounds = (pageCount: number): { min: number; max: number } | null => {
  if (pageCount >= 120) {
    return { min: 10, max: 30 };
  }

  if (pageCount >= 61) {
    return { min: 8, max: 24 };
  }

  if (pageCount >= 25) {
    return { min: 4, max: 18 };
  }

  return null;
};

const buildCompactSnippet = (text: string, maxChars: number): string => {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const separator = ' ... ';
  const headChars = Math.max(24, Math.floor(maxChars * 0.65));
  const tailChars = Math.max(16, maxChars - headChars - separator.length);
  return `${normalized.slice(0, headChars).trimEnd()}${separator}${normalized.slice(-tailChars).trimStart()}`;
};

const splitLargeSection = (
  section: SectionBuffer
): Array<Omit<PdfTextChunk, 'id' | 'sequence'>> => {
  const chunks: Array<Omit<PdfTextChunk, 'id' | 'sequence'>> = [];
  let currentParagraphs: string[] = [];
  let currentLength = 0;
  let currentStartOffset = section.startOffset;

  section.paragraphs.forEach((paragraph, index) => {
    const addition = paragraph.length + (currentParagraphs.length > 0 ? 2 : 0);
    const shouldFlush =
      currentParagraphs.length > 0 &&
      currentLength >= MIN_CHUNK_CHARS &&
      currentLength + addition > TARGET_CHUNK_CHARS;

    if (shouldFlush) {
      const text = buildChunkText(currentParagraphs);
      chunks.push({
        text,
        headingPath: [...section.headingPath],
        startOffset: currentStartOffset,
        endOffset: currentStartOffset + text.length,
      });

      const overlapParagraph = currentParagraphs[currentParagraphs.length - 1];
      currentParagraphs = overlapParagraph ? [overlapParagraph] : [];
      currentLength = overlapParagraph ? overlapParagraph.length : 0;
      currentStartOffset = Math.max(
        section.startOffset,
        currentStartOffset + text.length - currentLength
      );
    }

    currentParagraphs.push(paragraph);
    currentLength += addition;

    if (currentLength > MAX_CHUNK_CHARS) {
      const text = buildChunkText(currentParagraphs);
      chunks.push({
        text,
        headingPath: [...section.headingPath],
        startOffset: currentStartOffset,
        endOffset: currentStartOffset + text.length,
      });

      currentParagraphs = [];
      currentLength = 0;
      if (index + 1 < section.paragraphs.length) {
        currentStartOffset += text.length;
      }
    }
  });

  if (currentParagraphs.length > 0) {
    const text = buildChunkText(currentParagraphs);
    chunks.push({
      text,
      headingPath: [...section.headingPath],
      startOffset: currentStartOffset,
      endOffset: currentStartOffset + text.length,
    });
  }

  return chunks.filter(chunk => chunk.text.trim().length > 0);
};

export const buildPdfTextIndex = (
  extractedText: string,
  sourceHash?: string,
  documentTitle?: string,
  pages?: PdfTextPage[]
): PdfTextIndex => {
  const pageLayout = buildPdfPageTextLayout(pages);
  const normalized = pageLayout?.text || normalizeWhitespace(extractedText);
  const sections = buildSections(normalized);

  const baseChunks =
    sections.length > 0
      ? sections.flatMap(section => splitLargeSection(section))
      : splitLargeSection({
          headingPath: documentTitle ? [documentTitle] : [],
          paragraphs: splitParagraphs(normalized),
          startOffset: 0,
          endOffset: normalized.length,
        });

  const chunks: PdfTextChunk[] = baseChunks.map((chunk, index) => {
    const pageSpan = resolveChunkPageSpanFromLayout(chunk.startOffset, chunk.endOffset, pageLayout);

    return {
      id: `chunk-${String(index + 1).padStart(3, '0')}`,
      sequence: index,
      text: chunk.text,
      headingPath:
        chunk.headingPath.length > 0 ? chunk.headingPath : documentTitle ? [documentTitle] : [],
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      pageStart: pageSpan?.startPage,
      pageEnd: pageSpan?.endPage,
    };
  });

  return {
    kind: 'pdf-text-index',
    parsedAt: new Date().toISOString(),
    sourceHash,
    documentTitle,
    pageCount: pageLayout?.pages.length,
    chunks,
  };
};

const clampPageNumber = (page: number, pageCount: number): number =>
  Math.min(pageCount, Math.max(1, page));

const getPdfDocumentCharLength = (documentIndex: PdfTextIndex): number =>
  Math.max(
    documentIndex.chunks[documentIndex.chunks.length - 1]?.endOffset || 0,
    documentIndex.chunks.reduce((maxChars, chunk) => Math.max(maxChars, chunk.endOffset), 0)
  );

const estimatePdfChunkPageSpan = (
  documentIndex: PdfTextIndex | null | undefined,
  chunk: PdfTextChunk,
  pageCount: number | undefined
): { startPage: number; endPage: number } | null => {
  if (!documentIndex || documentIndex.chunks.length === 0 || !pageCount || pageCount < 1) {
    return null;
  }

  const totalDocumentChars = getPdfDocumentCharLength(documentIndex);
  const startProgress =
    totalDocumentChars > 0
      ? chunk.startOffset / totalDocumentChars
      : chunk.sequence / Math.max(1, documentIndex.chunks.length);
  const endProgress =
    totalDocumentChars > 0
      ? Math.max(chunk.startOffset, chunk.endOffset - 1) / totalDocumentChars
      : (chunk.sequence + 1) / Math.max(1, documentIndex.chunks.length);
  const startPage = clampPageNumber(Math.floor(startProgress * pageCount) + 1, pageCount);
  const endPage = clampPageNumber(Math.ceil(endProgress * pageCount), pageCount);

  return {
    startPage: Math.min(startPage, endPage),
    endPage: Math.max(startPage, endPage),
  };
};

export const resolvePdfChunkPageSpan = (
  documentIndex: PdfTextIndex | null | undefined,
  chunk: PdfTextChunk,
  pageCount: number | undefined,
  pageLayout?: PdfPageTextLayout | null
): { startPage: number; endPage: number; exact: boolean } | null => {
  if (typeof chunk.pageStart === 'number' && typeof chunk.pageEnd === 'number') {
    return {
      startPage: chunk.pageStart,
      endPage: chunk.pageEnd,
      exact: true,
    };
  }

  const exactSpan = resolveChunkPageSpanFromLayout(chunk.startOffset, chunk.endOffset, pageLayout);
  if (exactSpan) {
    return {
      ...exactSpan,
      exact: true,
    };
  }

  const estimatedSpan = estimatePdfChunkPageSpan(documentIndex, chunk, pageCount);
  return estimatedSpan
    ? {
        ...estimatedSpan,
        exact: false,
      }
    : null;
};

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
): string => `Sei un mapper semantico per Lumina Reader.

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
      `[Lumina][DocumentIndex] ${traceLabel} response could not be parsed as chunk mappings.`,
      parseFailurePayload,
      parseError
    );
    pushLuminaDebugTrace('pdf-plan:mapping-parse-failed', {
      ...parseFailurePayload,
      errorMessage: parseError instanceof Error ? parseError.message : String(parseError),
    });
    throw parseError;
  }
};

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
    pushLuminaDebugTrace('pdf-plan:mapping-batch-start', batchDebugPayload);

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
        pushLuminaDebugTrace('pdf-plan:mapping-batch-retry-start', retryPayload);

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
          pushLuminaDebugTrace('pdf-plan:mapping-batch-retry-result', retryDebugPayload);

          if (retryParsedMappings.acceptedMappingCount > parsedMappings.acceptedMappingCount) {
            rawResponse = retryResponse;
            parsedMappings = retryParsedMappings;
            parseFailurePayload = retryParseFailurePayload;
          }
        } catch (retryError) {
          console.warn(
            `[Lumina][DocumentIndex] ${traceLabel} strict retry failed for ${lessonBatch.length} lesson(s).`,
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
      pushLuminaDebugTrace('pdf-plan:mapping-batch-result', resultDebugPayload);

      if (isSuspiciousMapping) {
        console.warn(
          `[Lumina][DocumentIndex] ${traceLabel} produced incomplete or rejected chunk mappings.`,
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
        `[Lumina][DocumentIndex] ${traceLabel} batch failed for ${lessonBatch.length} lesson(s).`,
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

const buildPdfPlanCoverageReport = (
  plan: LearningPlan,
  documentIndex: PdfTextIndex,
  pageCount: number,
  pdfPages: PdfTextPage[] | undefined,
  parser: 'pdftotext' | 'pdf-parse' | undefined,
  mappingSource: 'fallback' | 'mapped'
): PdfPlanCoverageReport => {
  const pageLayout = buildPdfPageTextLayout(pdfPages);
  const indexById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));
  const lessonPageHeuristic = resolveSoftLessonPageBounds(pageCount);

  const lessonSpans = plan.sections
    .filter(section => section.type !== 'summary')
    .map(section => {
      const primaryChunks = (section.primaryChunkIds || [])
        .map(chunkId => indexById.get(chunkId))
        .filter((chunk): chunk is PdfTextChunk => Boolean(chunk));
      const chunkSpans = primaryChunks
        .map(chunk => resolvePdfChunkPageSpan(documentIndex, chunk, pageCount, pageLayout))
        .filter(
          (
            span
          ): span is {
            startPage: number;
            endPage: number;
            exact: boolean;
          } => Boolean(span)
        );

      if (chunkSpans.length === 0) {
        return {
          lessonId: section.id,
          title: section.title,
          type: section.type,
          chunkCount: primaryChunks.length,
          chunkIds: primaryChunks.map(chunk => chunk.id),
          coveredPageCount: 0,
          coveredPages: [],
          flags: ['missing-mapping'],
          pageRange: null,
          pageRangeLength: 0,
          pageRangeSource: 'missing' as const,
        } satisfies PdfPlanLessonCoverage;
      }

      const coveredPages = Array.from(
        new Set(chunkSpans.flatMap(span => expandPageRange(span.startPage, span.endPage)))
      ).sort((left, right) => left - right);
      const startPage = coveredPages[0];
      const endPage = coveredPages[coveredPages.length - 1];
      const pageRangeLength = endPage - startPage + 1;
      const coveredPageCount = coveredPages.length;
      const flags: string[] = [];

      if (
        lessonPageHeuristic &&
        coveredPageCount > 0 &&
        coveredPageCount < lessonPageHeuristic.min
      ) {
        flags.push('too-narrow');
      }

      if (lessonPageHeuristic && pageRangeLength > lessonPageHeuristic.max) {
        flags.push('too-wide');
      }

      if (coveredPageCount + PDF_PLAN_FRAGMENTATION_SLACK_PAGES < pageRangeLength) {
        flags.push('fragmented');
      }

      return {
        lessonId: section.id,
        title: section.title,
        type: section.type,
        chunkCount: primaryChunks.length,
        chunkIds: primaryChunks.map(chunk => chunk.id),
        coveredPageCount,
        coveredPages,
        flags,
        pageRange: formatPageRange(startPage, endPage),
        pageRangeLength,
        pageRangeSource: chunkSpans.every(span => span.exact)
          ? 'exact'
          : chunkSpans.some(span => span.exact)
            ? 'mixed'
            : 'estimated',
      } satisfies PdfPlanLessonCoverage;
    });

  const substantiveRange = resolvePdfPlanSubstantiveRange(pageCount);
  const substantivePages = expandPageRange(substantiveRange.startPage, substantiveRange.endPage);
  const coveredSubstantivePages = new Set<number>();

  lessonSpans.forEach(lesson => {
    lesson.coveredPages.forEach(page => {
      if (page >= substantiveRange.startPage && page <= substantiveRange.endPage) {
        coveredSubstantivePages.add(page);
      }
    });
  });

  const uncoveredSubstantivePages = substantivePages.filter(
    page => !coveredSubstantivePages.has(page)
  );
  const gaps = compressPagesToGaps(uncoveredSubstantivePages);
  const coverageRatio =
    substantiveRange.pageCount > 0 ? coveredSubstantivePages.size / substantiveRange.pageCount : 1;

  const missingLessons = lessonSpans.filter(lesson => lesson.flags.includes('missing-mapping'));
  const tooNarrowLessons = lessonSpans.filter(lesson => lesson.flags.includes('too-narrow'));
  const tooWideLessons = lessonSpans.filter(lesson => lesson.flags.includes('too-wide'));
  const fragmentedLessons = lessonSpans.filter(lesson => lesson.flags.includes('fragmented'));
  const warnings: string[] = [];

  if (coverageRatio < PDF_PLAN_COVERAGE_WARN_RATIO) {
    warnings.push(
      `Copertura sostanziale stimata bassa: ${(coverageRatio * 100).toFixed(1)}% delle pagine utili contro un target morbido del ${(PDF_PLAN_COVERAGE_TARGET_RATIO * 100).toFixed(0)}%.`
    );
  } else if (coverageRatio < PDF_PLAN_COVERAGE_TARGET_RATIO) {
    warnings.push(
      `Copertura sotto il target morbido: ${(coverageRatio * 100).toFixed(1)}% delle pagine utili coperte.`
    );
  }

  if (gaps.length > 0) {
    const visibleGaps = gaps.slice(0, PDF_PLAN_MAX_REPORTED_GAPS);
    warnings.push(
      `Sono presenti ${gaps.length} gap interni nella copertura del PDF; primi gap: ${visibleGaps
        .map(gap => formatPageRange(gap.startPage, gap.endPage))
        .filter(Boolean)
        .join(', ')}.`
    );
  }

  if (missingLessons.length > 0) {
    warnings.push(
      `${missingLessons.length} lezioni non hanno chunk primari risolti dopo il mapping.`
    );
  }

  if (tooNarrowLessons.length > 0) {
    warnings.push(
      `${tooNarrowLessons.length} lezioni risultano molto strette rispetto all'euristica di pagine per lezione.`
    );
  }

  if (tooWideLessons.length > 0) {
    warnings.push(
      `${tooWideLessons.length} lezioni risultano molto ampie rispetto all'euristica di pagine per lezione.`
    );
  }

  if (fragmentedLessons.length > 0) {
    warnings.push(
      `${fragmentedLessons.length} lezioni mappano pagine troppo sparse o non contigue.`
    );
  }

  return {
    coveredSubstantivePages: coveredSubstantivePages.size,
    coverageRatio: Number.parseFloat(coverageRatio.toFixed(4)),
    gapCount: gaps.length,
    gaps,
    lessonCount: lessonSpans.length,
    lessonPageHeuristic,
    lessonSpans,
    mappedLessonCount: lessonSpans.filter(lesson => lesson.pageRange).length,
    mappingSource,
    missingLessonCount: missingLessons.length,
    pageCount,
    parser: parser || 'unknown',
    substantiveRange,
    warnings,
  };
};

const emitPdfPlanCoverageDiagnostics = (
  fileName: string,
  plan: LearningPlan,
  documentIndex: PdfTextIndex,
  pdfSession:
    | {
        pages?: PdfTextPage[];
        pageCount?: number;
        parser?: 'pdftotext' | 'pdf-parse';
      }
    | null
    | undefined,
  mappingSource: 'fallback' | 'mapped'
): void => {
  const pageCount = pdfSession?.pageCount || documentIndex.pageCount;
  if (!pageCount || pageCount < 1) {
    return;
  }

  const report = buildPdfPlanCoverageReport(
    plan,
    documentIndex,
    pageCount,
    pdfSession?.pages,
    pdfSession?.parser,
    mappingSource
  );
  const payload = {
    fileName,
    ...report,
  };

  logPdfPlanDebug('Coverage summary', payload);
  pushLuminaDebugTrace('pdf-plan:coverage', payload);

  if (report.warnings.length > 0) {
    logPdfPlanDebug('Coverage warnings', {
      fileName,
      warningCount: report.warnings.length,
      warnings: report.warnings,
    });
    pushLuminaDebugTrace('pdf-plan:coverage-warning', {
      fileName,
      warningCount: report.warnings.length,
      warnings: report.warnings,
      coverageRatio: report.coverageRatio,
      gapCount: report.gapCount,
      mappingSource: report.mappingSource,
    });
  }
};

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
      '[Lumina][DocumentIndex] Fast mapping failed, escalating to deep PDF remapping.',
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
    pushLuminaDebugTrace('pdf-plan:deep-repair-start', {
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
        '[Lumina][DocumentIndex] Deep PDF remapping failed, continuing with fallback mapping.',
        error
      );
      pushLuminaDebugTrace('pdf-plan:deep-repair-failed', {
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
    pushLuminaDebugTrace('pdf-plan:full-deep-repair-start', {
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
        '[Lumina][DocumentIndex] Full PDF remapping failed, continuing with fallback mapping.',
        error
      );
      pushLuminaDebugTrace('pdf-plan:full-deep-repair-failed', {
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
      `[Lumina][DocumentIndex] Unable to recover PDF lesson mappings for ${sectionsNeedingRepair.length} section(s); continuing with fallback chunk assignments for ${fallbackSectionIds.length} section(s).`,
      describeSectionTitles(plan, sectionsNeedingRepair)
    );
    pushLuminaDebugTrace('pdf-plan:mapping-fallback', {
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

    emitPdfPlanCoverageDiagnostics(file.name, learningPlan, documentIndex, pdfSession, 'fallback');
    return {
      learningPlan,
      documentIndex,
    };
  }

  emitPdfPlanCoverageDiagnostics(file.name, learningPlan, documentIndex, pdfSession, 'mapped');
  return {
    learningPlan,
    documentIndex,
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

export { getPdfProjectHydrationState as getPdfLessonMappingState } from '../../utils/pdf/projectHydration.ts';

export const buildLessonChunkContext = (
  documentIndex: PdfTextIndex | null | undefined,
  primaryChunkIds: string[] | undefined
): string => {
  if (!documentIndex || documentIndex.chunks.length === 0) {
    return '';
  }

  return resolveLessonContextChunks(documentIndex, primaryChunkIds)
    .map(
      chunk => `CHUNK ${chunk.id}
Heading path: ${chunk.headingPath.join(' > ') || 'Nessuno'}
${chunk.text}`
    )
    .join('\n\n---\n\n');
};

export const resolveLessonContextChunks = (
  documentIndex: PdfTextIndex | null | undefined,
  primaryChunkIds: string[] | undefined
): PdfTextChunk[] => {
  if (!documentIndex || documentIndex.chunks.length === 0) {
    return [];
  }

  const indexById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));
  const orderedSequences = new Set<number>();

  (primaryChunkIds || [])
    .map(chunkId => indexById.get(chunkId))
    .filter((chunk): chunk is PdfTextChunk => Boolean(chunk))
    .forEach(chunk => {
      orderedSequences.add(chunk.sequence);
      if (orderedSequences.size < MAX_CONTEXT_CHUNKS) {
        orderedSequences.add(Math.max(0, chunk.sequence - 1));
      }
      if (orderedSequences.size < MAX_CONTEXT_CHUNKS) {
        orderedSequences.add(Math.min(documentIndex.chunks.length - 1, chunk.sequence + 1));
      }
    });

  if (orderedSequences.size === 0) {
    documentIndex.chunks.slice(0, Math.min(2, documentIndex.chunks.length)).forEach(chunk => {
      orderedSequences.add(chunk.sequence);
    });
  }

  return Array.from(orderedSequences)
    .sort((left, right) => left - right)
    .slice(0, MAX_CONTEXT_CHUNKS)
    .map(sequence => documentIndex.chunks[sequence])
    .filter((chunk): chunk is PdfTextChunk => Boolean(chunk));
};
