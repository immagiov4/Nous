import type { FileData, LearningPlan, PdfTextChunk, PdfTextIndex, PdfTextPage } from '../../types.ts';
import { getPdfTextSession } from './pdfAssets.ts';
import {
  MODEL_FLASH,
  callOpenRouter,
  isPdfFile,
  parseCleanJson,
  retryWithBackoff,
} from './shared.ts';
import { getPdfProjectHydrationState } from '../../utils/pdfProjectHydration.ts';

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
const HEADING_MAX_WORDS = 14;
const HEADING_MAX_CHARS = 120;

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

interface LessonMappingDescriptor {
  lessonId: string;
  title: string;
  description: string;
  moduleTitle: string;
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

const buildLessonDescriptor = (
  section: LearningPlan['sections'][number]
): LessonMappingDescriptor => ({
  lessonId: section.id,
  title: section.title,
  description: section.description,
  moduleTitle: section.moduleTitle || '',
});

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
  sections: LessonMappingDescriptor[]
): LessonMappingDescriptor[][] => {
  const batches: LessonMappingDescriptor[][] = [];
  let currentBatch: LessonMappingDescriptor[] = [];
  let currentJsonChars = 0;

  sections.forEach(section => {
    const sectionJsonChars = JSON.stringify(section).length;
    const shouldFlush =
      currentBatch.length > 0 &&
      (currentBatch.length >= MAX_MAPPING_LESSONS_PER_REQUEST ||
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
7. Restituisci SOLO JSON valido.

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

const resolveChunkDescriptorsForBatch = (
  documentIndex: PdfTextIndex,
  lessons: LessonMappingDescriptor[]
): ChunkMappingDescriptor[] => {
  let previewChars = MAX_MAPPING_CHUNK_PREVIEW_CHARS;
  let descriptors = documentIndex.chunks.map(chunk => buildChunkDescriptor(chunk, previewChars));
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
    descriptors = documentIndex.chunks.map(chunk => buildChunkDescriptor(chunk, previewChars));
    promptLength = buildChunkMappingPrompt(lessons, descriptors).length;
  }

  return descriptors;
};

const parseChunkMappings = (
  response: string,
  availableChunkIds: Set<string>
): Map<string, string[]> => {
  const parsed = parseCleanJson<ChunkMappingResponse>(response || '{}');
  const mappings = new Map<string, string[]>();

  parsed.mappings?.forEach(mapping => {
    if (!mapping?.lessonId || !Array.isArray(mapping.chunkIds)) {
      return;
    }

    const chunkIds = mapping.chunkIds
      .filter(
        (chunkId): chunkId is string =>
          typeof chunkId === 'string' && availableChunkIds.has(chunkId)
      )
      .slice(0, MAX_PRIMARY_CHUNKS_PER_LESSON);

    if (chunkIds.length > 0) {
      mappings.set(mapping.lessonId, chunkIds);
    }
  });

  return mappings;
};

const resolveMappingMaxTokens = (lessonCount: number): number =>
  Math.min(MAX_MAPPING_OUTPUT_TOKENS, Math.max(512, lessonCount * 180));

const buildMappingFallback = (plan: LearningPlan, documentIndex: PdfTextIndex): LearningPlan => {
  const fallbackChunkIds = documentIndex.chunks
    .slice(0, Math.min(2, documentIndex.chunks.length))
    .map(chunk => chunk.id);
  return {
    ...plan,
    sections: plan.sections.map(section => ({
      ...section,
      primaryChunkIds:
        section.primaryChunkIds && section.primaryChunkIds.length > 0
          ? section.primaryChunkIds
          : fallbackChunkIds,
    })),
  };
};

const mapLessonsToChunkIds = async (
  plan: LearningPlan,
  documentIndex: PdfTextIndex,
  sectionIds?: string[]
): Promise<Map<string, string[]>> => {
  const targetSections = plan.sections.filter(
    section => (!sectionIds || sectionIds.includes(section.id)) && section.type !== 'summary'
  );

  if (targetSections.length === 0 || documentIndex.chunks.length === 0) {
    return new Map();
  }

  const availableChunkIds = new Set(documentIndex.chunks.map(chunk => chunk.id));
  const mappings = new Map<string, string[]>();
  const sectionBatches = buildSectionMappingBatches(targetSections.map(buildLessonDescriptor));
  let firstBatchError: unknown = null;
  let successfulBatchCount = 0;

  for (const lessonBatch of sectionBatches) {
    const chunkDescriptors = resolveChunkDescriptorsForBatch(documentIndex, lessonBatch);
    const prompt = buildChunkMappingPrompt(lessonBatch, chunkDescriptors);

    try {
      const response = await retryWithBackoff(
        () =>
          callOpenRouter({
            model: MODEL_FLASH,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            max_tokens: resolveMappingMaxTokens(lessonBatch.length),
          }),
        2,
        500
      );

      parseChunkMappings(response || '{}', availableChunkIds).forEach((chunkIds, lessonId) => {
        mappings.set(lessonId, chunkIds);
      });
      successfulBatchCount += 1;
    } catch (error) {
      firstBatchError ??= error;
      console.warn(
        `[Lumina][DocumentIndex] Mapping batch failed for ${lessonBatch.length} lesson(s).`,
        error
      );
    }
  }

  if (successfulBatchCount === 0 && firstBatchError) {
    throw firstBatchError;
  }

  return mappings;
};

const applyChunkMappings = (
  plan: LearningPlan,
  mappings: Map<string, string[]>,
  fallbackChunkIds: string[]
): LearningPlan => ({
  ...plan,
  sections: plan.sections.map(section => ({
    ...section,
    primaryChunkIds:
      mappings.get(section.id) ||
      (section.primaryChunkIds && section.primaryChunkIds.length > 0
        ? section.primaryChunkIds
        : fallbackChunkIds),
  })),
});

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

  try {
    const mappings = await mapLessonsToChunkIds(plan, documentIndex, sectionIds);
    const fallbackChunkIds = documentIndex.chunks
      .slice(0, Math.min(2, documentIndex.chunks.length))
      .map(chunk => chunk.id);
    return {
      learningPlan: applyChunkMappings(plan, mappings, fallbackChunkIds),
      documentIndex,
    };
  } catch (error) {
    console.warn(
      '[Lumina][DocumentIndex] Mapping failed, falling back to default chunk assignment.',
      error
    );
    return {
      learningPlan: buildMappingFallback(plan, documentIndex),
      documentIndex,
    };
  }
};

export const needsPdfLessonMappingMigration = (
  file: FileData | null,
  plan: LearningPlan | null,
  documentIndex: PdfTextIndex | null | undefined
): boolean => {
  const hydrationState = getPdfProjectHydrationState(file, plan, documentIndex);
  return hydrationState !== 'ready' && hydrationState !== 'idle';
};

export { getPdfProjectHydrationState as getPdfLessonMappingState } from '../../utils/pdfProjectHydration.ts';

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
