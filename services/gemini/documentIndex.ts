import type { FileData, LearningPlan, PdfTextChunk, PdfTextIndex } from '../../types';
import { getPdfTextSession } from './pdfAssets';
import { MODEL_FLASH, callOpenRouter, isPdfFile, parseCleanJson, retryWithBackoff } from './shared';
import { getPdfProjectHydrationState } from '../../utils/pdfProjectHydration';

const TARGET_CHUNK_CHARS = 7000;
const MIN_CHUNK_CHARS = 3500;
const MAX_CHUNK_CHARS = 9500;
const MAX_PRIMARY_CHUNKS_PER_LESSON = 3;
const MAX_CONTEXT_CHUNKS = 6;
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

const normalizeWhitespace = (text: string): string =>
  text.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

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

const splitLargeSection = (section: SectionBuffer): Array<Omit<PdfTextChunk, 'id' | 'sequence'>> => {
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
      currentStartOffset = Math.max(section.startOffset, currentStartOffset + text.length - currentLength);
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
  documentTitle?: string
): PdfTextIndex => {
  const normalized = normalizeWhitespace(extractedText);
  const sections = buildSections(normalized);

  const baseChunks = sections.length > 0
    ? sections.flatMap(section => splitLargeSection(section))
    : splitLargeSection({
        headingPath: documentTitle ? [documentTitle] : [],
        paragraphs: splitParagraphs(normalized),
        startOffset: 0,
        endOffset: normalized.length,
      });

  const chunks: PdfTextChunk[] = baseChunks.map((chunk, index) => ({
    id: `chunk-${String(index + 1).padStart(3, '0')}`,
    sequence: index,
    text: chunk.text,
    headingPath: chunk.headingPath.length > 0 ? chunk.headingPath : documentTitle ? [documentTitle] : [],
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
  }));

  return {
    kind: 'pdf-text-index',
    parsedAt: new Date().toISOString(),
    sourceHash,
    documentTitle,
    chunks,
  };
};

const buildChunkDescriptor = (chunk: PdfTextChunk) => ({
  id: chunk.id,
  headingPath: chunk.headingPath,
  text: chunk.text,
});

const buildMappingFallback = (plan: LearningPlan, documentIndex: PdfTextIndex): LearningPlan => {
  const fallbackChunkIds = documentIndex.chunks.slice(0, Math.min(2, documentIndex.chunks.length)).map(chunk => chunk.id);
  return {
    ...plan,
    sections: plan.sections.map(section => ({
      ...section,
      primaryChunkIds: section.primaryChunkIds && section.primaryChunkIds.length > 0
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
  const targetSections = plan.sections.filter(section =>
    (!sectionIds || sectionIds.includes(section.id)) &&
    section.type !== 'summary'
  );

  if (targetSections.length === 0 || documentIndex.chunks.length === 0) {
    return new Map();
  }

  const prompt = `Sei un mapper semantico per Lumina Reader.

Devi associare a ciascuna lezione i chunk del documento sorgente piu pertinenti.

REGOLE:
1. Lavora semanticamente anche se la lezione e in una lingua diversa dal documento.
2. Per ogni lezione scegli da 1 a ${MAX_PRIMARY_CHUNKS_PER_LESSON} chunk principali.
3. Scegli il numero minimo di chunk necessari.
4. Se un concetto e chiaramente a cavallo tra due chunk, puoi selezionarli entrambi.
5. Non inventare chunkId.
6. Restituisci SOLO JSON valido.

LEZIONI:
${JSON.stringify(targetSections.map(section => ({
  lessonId: section.id,
  title: section.title,
  description: section.description,
  moduleTitle: section.moduleTitle || '',
})), null, 2)}

CHUNK DOCUMENTO:
${JSON.stringify(documentIndex.chunks.map(buildChunkDescriptor), null, 2)}

Rispondi con:
{
  "mappings": [
    { "lessonId": "section-1", "chunkIds": ["chunk-001", "chunk-002"] }
  ]
}`;

  const response = await retryWithBackoff(() =>
    callOpenRouter({
      model: MODEL_FLASH,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
  2, 500);

  const parsed = parseCleanJson<ChunkMappingResponse>(response || '{}');
  const availableChunkIds = new Set(documentIndex.chunks.map(chunk => chunk.id));
  const mappings = new Map<string, string[]>();

  parsed.mappings?.forEach(mapping => {
    if (!mapping?.lessonId || !Array.isArray(mapping.chunkIds)) {
      return;
    }

    const chunkIds = mapping.chunkIds
      .filter((chunkId): chunkId is string => typeof chunkId === 'string' && availableChunkIds.has(chunkId))
      .slice(0, MAX_PRIMARY_CHUNKS_PER_LESSON);

    if (chunkIds.length > 0) {
      mappings.set(mapping.lessonId, chunkIds);
    }
  });

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
      (section.primaryChunkIds && section.primaryChunkIds.length > 0 ? section.primaryChunkIds : fallbackChunkIds),
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
      : buildPdfTextIndex(pdfSession.extractedText, sourceHash, file.name);

  try {
    const mappings = await mapLessonsToChunkIds(plan, documentIndex, sectionIds);
    const fallbackChunkIds = documentIndex.chunks.slice(0, Math.min(2, documentIndex.chunks.length)).map(chunk => chunk.id);
    return {
      learningPlan: applyChunkMappings(plan, mappings, fallbackChunkIds),
      documentIndex,
    };
  } catch (error) {
    console.warn('[Lumina][DocumentIndex] Mapping failed, falling back to default chunk assignment.', error);
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

export { getPdfProjectHydrationState as getPdfLessonMappingState } from '../../utils/pdfProjectHydration';

export const buildLessonChunkContext = (
  documentIndex: PdfTextIndex | null | undefined,
  primaryChunkIds: string[] | undefined
): string => {
  if (!documentIndex || documentIndex.chunks.length === 0) {
    return '';
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
    .filter(Boolean)
    .map(chunk => `CHUNK ${chunk.id}
Heading path: ${chunk.headingPath.join(' > ') || 'Nessuno'}
${chunk.text}`)
    .join('\n\n---\n\n');
};
