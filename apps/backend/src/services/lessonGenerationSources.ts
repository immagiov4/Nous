import {
  DEFAULT_LESSON_CONTEXT_CHUNKS,
  MAX_LESSON_COMBINED_SOURCE_CONTEXT_CHARS,
  MAX_LESSON_CONTEXT_CHUNKS,
  MAX_LESSON_SOURCE_CONTEXT_CHARS,
} from '@shared/lessonSourceContext';
import {
  ORIGINAL_COURSE_ARCHIVE_SOURCE_NOTE,
  ORIGINAL_COURSE_SOURCE_NOTE,
} from '@shared/lessonSourceContract';
import type { LessonWorkflowWarning } from '@shared/lessonWorkflowContract';
import { LESSON_PDF_IMAGE_EXTRACTION_LIMIT } from '@shared/pdfImagePolicy';
import { SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES } from '@shared/sourceArchiveSelectors';
import {
  formatYouTubeTranscript,
  parseYouTubeTranscript,
  type YouTubeTranscript,
} from '@shared/youtubeTranscript';
import { SourceArchiveAccess } from '../projects/sourceArchiveAccess.js';
import type { ProjectSnapshot, ProjectStore } from '../projects/types.js';
import { buildSha256HexDigest } from '../utils/hash.js';
import { isRecord } from '../utils/validation.js';
import type { ExtractedPdfImage, extractPdfImages } from './pdfImageExtractor.js';
import { isPdfProjectSourceFile, readProjectSourceText } from './projectSourceText.js';
import type { YouTubeResearchOutcome } from './youtubeResearch.js';

export interface ResearchSource {
  chunkIds?: string[];
  note?: string;
  pageEnd?: number;
  pageStart?: number;
  sourceId?: string;
  title: string;
  url?: string;
  videoClip?: { endSeconds: number; startSeconds: number };
  youtubeTranscript?: YouTubeTranscript;
}

export interface LessonPdfImageAsset {
  caption?: string;
  dataUrl: string;
  id: string;
  intrinsicHeight?: number;
  intrinsicWidth?: number;
  mimeType: string;
  pageNumber?: number;
  sizeBytes?: number;
  sourceHash?: string;
  sourceId?: string;
  sourceOrder: number;
  textAfter: string;
  textBefore: string;
  textCurrent?: string;
}

export interface LessonPdfImageExtractionOutcome {
  assets: LessonPdfImageAsset[];
  warnings: LessonWorkflowWarning[];
}

export class LessonPdfImageExtractionError extends Error {
  readonly code = 'lesson_pdf_image_extraction_failed';

  constructor(cause: unknown) {
    super('Every stored PDF source failed image extraction.', { cause });
    this.name = 'LessonPdfImageExtractionError';
  }
}

export interface LessonImageCandidate {
  caption?: string;
  id: string;
  intrinsicHeight?: number;
  intrinsicWidth?: number;
  pageNumber?: number;
  sizeBytes?: number;
  sourceOrder: number;
  textAfter?: string;
  textBefore?: string;
  textCurrent?: string;
  visibleLabel: string;
}

const PDF_ASSET_SESSION_TIMEOUT_MS = 90_000;

class PdfAssetSoftTimeoutError extends Error {
  constructor() {
    super(`PDF image extraction exceeded ${PDF_ASSET_SESSION_TIMEOUT_MS}ms.`);
    this.name = 'PdfAssetSoftTimeoutError';
  }
}

export const withPdfAssetSoftTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal
): Promise<T> => {
  const operationController = new AbortController();
  const timeoutError = new PdfAssetSoftTimeoutError();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => operationController.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  try {
    return await Promise.race([
      operation(operationController.signal),
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          operationController.abort(timeoutError);
          reject(timeoutError);
        }, PDF_ASSET_SESSION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    parentSignal.removeEventListener('abort', abortFromParent);
  }
};

export const isPdfAssetSoftTimeoutError = (error: unknown): error is PdfAssetSoftTimeoutError =>
  error instanceof PdfAssetSoftTimeoutError;

const clipSourceContext = (value: string, maxChars: number): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n[estratto della fonte troncato]`;
};

const readReferenceChunkIds = (section: Record<string, unknown>, sourceId?: string): string[] =>
  Array.isArray(section.sourceReferences)
    ? section.sourceReferences.flatMap(reference =>
        isRecord(reference) &&
        (sourceId === undefined || reference.sourceId === sourceId) &&
        Array.isArray(reference.chunkIds)
          ? reference.chunkIds.filter((id): id is string => typeof id === 'string')
          : []
      )
    : [];

const readSectionChunkIds = (section: Record<string, unknown>): Set<string> =>
  new Set([
    ...(Array.isArray(section.primaryChunkIds)
      ? section.primaryChunkIds.filter((id): id is string => typeof id === 'string')
      : []),
    ...readReferenceChunkIds(section),
  ]);

export const readSectionSourceIds = (
  project: ProjectSnapshot,
  section: Record<string, unknown>
): Set<string> => {
  const sourceIds = new Set<string>();
  if (Array.isArray(section.sourceReferences)) {
    for (const reference of section.sourceReferences) {
      if (isRecord(reference) && typeof reference.sourceId === 'string') {
        sourceIds.add(reference.sourceId);
      }
    }
  }
  if (!isRecord(project.documentIndex) || !Array.isArray(project.documentIndex.chunks)) {
    return sourceIds;
  }
  const selectedChunkIds = readSectionChunkIds(section);
  for (const chunk of project.documentIndex.chunks) {
    if (
      isRecord(chunk) &&
      selectedChunkIds.has(String(chunk.id)) &&
      typeof chunk.sourceId === 'string'
    ) {
      sourceIds.add(chunk.sourceId);
    }
  }
  return sourceIds;
};

export const buildMappedSourceContext = (
  project: ProjectSnapshot,
  section: Record<string, unknown>
) => {
  if (!isRecord(project.documentIndex) || !Array.isArray(project.documentIndex.chunks)) return '';
  const chunks = project.documentIndex.chunks.filter(isRecord);
  const selectedIds = readSectionChunkIds(section);
  const selectedIndexes = chunks.flatMap((chunk, index) =>
    selectedIds.has(String(chunk.id)) ? [index] : []
  );
  const contextIndexes = new Set<number>();
  for (const index of selectedIndexes) {
    const selectedChunk = chunks[index];
    const selectedSourceId =
      isRecord(selectedChunk) && typeof selectedChunk.sourceId === 'string'
        ? selectedChunk.sourceId
        : null;
    for (const candidateIndex of [index, index - 1, index + 1]) {
      const candidate = chunks[candidateIndex];
      const sharesSource =
        !selectedSourceId || (isRecord(candidate) && candidate.sourceId === selectedSourceId);
      if (
        candidateIndex >= 0 &&
        candidateIndex < chunks.length &&
        sharesSource &&
        contextIndexes.size < MAX_LESSON_CONTEXT_CHUNKS
      ) {
        contextIndexes.add(candidateIndex);
      }
    }
  }
  if (contextIndexes.size === 0) {
    chunks.slice(0, DEFAULT_LESSON_CONTEXT_CHUNKS).forEach((_chunk, index) => {
      contextIndexes.add(index);
    });
  }
  return [...contextIndexes]
    .sort((left, right) => left - right)
    .map(index => chunks[index])
    .map(chunk => {
      if (!isRecord(chunk) || typeof chunk.text !== 'string' || !chunk.text.trim()) return '';
      const headingPath = Array.isArray(chunk.headingPath)
        ? chunk.headingPath.filter((heading): heading is string => typeof heading === 'string')
        : [];
      return `CHUNK ${String(chunk.id)}\nHeading path: ${headingPath.join(' > ') || 'Nessuno'}\n${chunk.text.trim()}`;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');
};

interface StoredSourceCandidate {
  file: { data: string; mimeType: string; name: string };
  hash: string;
  id: string;
}

export class LessonSourceUnavailableError extends Error {
  constructor() {
    super('The requested lesson source is unavailable.');
    this.name = 'LessonSourceUnavailableError';
  }
}

export const readAuthoritativePrimarySourceId = (project: ProjectSnapshot): string => {
  if (!isRecord(project.source)) return '';
  const refId =
    isRecord(project.source.ref) && typeof project.source.ref.id === 'string'
      ? project.source.ref.id.trim()
      : '';
  if (refId) return refId;
  return isRecord(project.source.file) && typeof project.source.file.sourceId === 'string'
    ? project.source.file.sourceId.trim()
    : '';
};

const loadStoredSourceCandidates = async (
  store: ProjectStore,
  userId: string,
  projectId: string,
  fallbackSourceId = ''
): Promise<StoredSourceCandidate[]> => {
  const storedSources = await store.loadProjectSources(userId, projectId);
  if (storedSources.length) {
    return storedSources.map(source => ({
      file: source.file,
      hash: source.ref.hash,
      id: source.ref.id,
    }));
  }
  const primarySource = await store.loadProjectSource(userId, projectId);
  return primarySource
    ? [
        {
          file: primarySource,
          hash: buildSha256HexDigest(Buffer.from(primarySource.data, 'base64')),
          id: primarySource.sourceId || fallbackSourceId || primarySource.name,
        },
      ]
    : [];
};

const filterReferencedStoredSources = (
  candidates: StoredSourceCandidate[],
  section: Record<string, unknown>
): StoredSourceCandidate[] => {
  const referencedSourceIds = new Set(
    Array.isArray(section.sourceReferences)
      ? section.sourceReferences.flatMap(reference =>
          isRecord(reference) && typeof reference.sourceId === 'string' ? [reference.sourceId] : []
        )
      : []
  );
  const hasKnownReference = candidates.some(candidate => referencedSourceIds.has(candidate.id));
  return hasKnownReference
    ? candidates.filter(candidate => referencedSourceIds.has(candidate.id))
    : candidates;
};

export const buildStoredDocumentSourceContext = async (
  store: ProjectStore,
  userId: string,
  projectId: string,
  section: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> => {
  const candidates = filterReferencedStoredSources(
    await loadStoredSourceCandidates(store, userId, projectId),
    section
  );
  const blocks: string[] = [];
  for (const candidate of candidates) {
    signal.throwIfAborted();
    const content = clipSourceContext(
      await readProjectSourceText(candidate.file),
      MAX_LESSON_SOURCE_CONTEXT_CHARS
    );
    if (content) blocks.push(`FONTE ORIGINALE: ${candidate.file.name}\n${content}`);
  }
  return clipSourceContext(blocks.join('\n\n---\n\n'), MAX_LESSON_COMBINED_SOURCE_CONTEXT_CHARS);
};

export const buildArchiveSourceContext = async (
  store: ProjectStore,
  userId: string,
  projectId: string,
  section: Record<string, unknown>
): Promise<string> => {
  const selectors = Array.isArray(section.sourceArchiveSelectors)
    ? section.sourceArchiveSelectors.filter(
        (selector): selector is { kind: 'directory' | 'file'; path: string } =>
          isRecord(selector) &&
          (selector.kind === 'directory' || selector.kind === 'file') &&
          typeof selector.path === 'string'
      )
    : [];
  if (selectors.length === 0) return '';
  const index = await store.loadProjectSourceArchiveIndex(userId, projectId);
  if (!index) throw new LessonSourceUnavailableError();
  const access = new SourceArchiveAccess({
    index: { entries: index.entries },
    maxContextBytes: SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES,
    readByteRange: (path, start, endExclusive) =>
      store
        .loadProjectSourceArchiveEntryRange(
          userId,
          projectId,
          path,
          index.version,
          start,
          endExclusive
        )
        .then(bytes => {
          if (!bytes) throw new Error('Source archive entry is missing.');
          return bytes;
        }),
    readBytes: path =>
      store.loadProjectSourceArchiveEntry(userId, projectId, path, index.version).then(bytes => {
        if (!bytes) throw new Error('Source archive entry is missing.');
        return bytes;
      }),
  });
  const files = await access.resolveSelectors(selectors);
  return files.map(file => `FILE ${file.path}\n${file.text}`).join('\n\n---\n\n');
};

export const parseResearchSource = (value: unknown): ResearchSource | null => {
  if (!isRecord(value) || typeof value.title !== 'string' || !value.title.trim()) return null;
  const transcript = parseYouTubeTranscript(value.youtubeTranscript);
  const videoClip = isRecord(value.videoClip) ? value.videoClip : null;
  return {
    title: value.title.trim(),
    ...(typeof value.sourceId === 'string' && value.sourceId.trim()
      ? { sourceId: value.sourceId.trim() }
      : {}),
    ...(Array.isArray(value.chunkIds)
      ? {
          chunkIds: value.chunkIds.filter(
            (chunkId: unknown): chunkId is string =>
              typeof chunkId === 'string' && Boolean(chunkId.trim())
          ),
        }
      : {}),
    ...(typeof value.pageStart === 'number' ? { pageStart: value.pageStart } : {}),
    ...(typeof value.pageEnd === 'number' ? { pageEnd: value.pageEnd } : {}),
    ...(typeof value.url === 'string' && value.url.trim() ? { url: value.url.trim() } : {}),
    ...(typeof value.note === 'string' && value.note.trim() ? { note: value.note.trim() } : {}),
    ...(videoClip &&
    typeof videoClip.startSeconds === 'number' &&
    typeof videoClip.endSeconds === 'number'
      ? {
          videoClip: {
            endSeconds: videoClip.endSeconds,
            startSeconds: videoClip.startSeconds,
          },
        }
      : {}),
    ...(transcript ? { youtubeTranscript: transcript } : {}),
  };
};

export const readExistingDossier = (project: ProjectSnapshot, sectionId: string) => {
  const value = project.researchDossiersBySectionId?.[sectionId];
  return isRecord(value) ? value : null;
};

export const readProjectLanguage = (project: ProjectSnapshot): string =>
  project.userProfile?.language || 'Italiano';

const sourceKey = (source: ResearchSource): string => {
  if (source.sourceId?.trim()) return `source:${source.sourceId.trim()}`;
  let url = source.url?.trim().toLocaleLowerCase();
  while (url?.endsWith('/')) url = url.slice(0, -1);
  return url || source.title.trim().normalize('NFKC').toLocaleLowerCase();
};

const mergeSource = (
  existing: ResearchSource | undefined,
  incoming: ResearchSource
): ResearchSource => {
  if (!existing) return { ...incoming };
  return {
    ...incoming,
    ...existing,
    title: existing.title || incoming.title,
    ...(existing.chunkIds || incoming.chunkIds
      ? { chunkIds: [...new Set([...(existing.chunkIds || []), ...(incoming.chunkIds || [])])] }
      : {}),
    ...(incoming.videoClip ? { videoClip: incoming.videoClip } : {}),
    ...(incoming.youtubeTranscript ? { youtubeTranscript: incoming.youtubeTranscript } : {}),
  };
};

export const mergeSources = (...sourceGroups: ResearchSource[][]): ResearchSource[] => {
  const sources = new Map<string, ResearchSource>();
  for (const source of sourceGroups.flat()) {
    const key = sourceKey(source);
    sources.set(key, mergeSource(sources.get(key), source));
  }
  return [...sources.values()];
};

export const readOriginalSourceNames = (
  project: ProjectSnapshot,
  section: Record<string, unknown>
): ResearchSource[] => {
  if (!isRecord(project.source)) return [];
  const selectedSourceIds = readSectionSourceIds(project, section);
  const descriptors = Array.isArray(project.source.sources) ? project.source.sources : [];
  const hasKnownSelectedSource = descriptors.some(
    descriptor =>
      isRecord(descriptor) &&
      typeof descriptor.id === 'string' &&
      selectedSourceIds.has(descriptor.id)
  );
  const descriptorSources = descriptors.flatMap(descriptor => {
    if (!isRecord(descriptor)) return [];
    if (
      hasKnownSelectedSource &&
      (typeof descriptor.id !== 'string' || !selectedSourceIds.has(descriptor.id))
    ) {
      return [];
    }
    const name =
      (typeof descriptor.name === 'string' && descriptor.name.trim()) ||
      (isRecord(descriptor.file) && typeof descriptor.file.name === 'string'
        ? descriptor.file.name.trim()
        : '');
    if (!name) return [];
    const sourceId = typeof descriptor.id === 'string' ? descriptor.id : undefined;
    const references = Array.isArray(section.sourceReferences)
      ? section.sourceReferences.filter(
          reference => isRecord(reference) && reference.sourceId === sourceId
        )
      : [];
    const chunkIds = references.flatMap(reference =>
      Array.isArray(reference.chunkIds)
        ? reference.chunkIds.filter(
            (chunkId: unknown): chunkId is string =>
              typeof chunkId === 'string' && Boolean(chunkId.trim())
          )
        : []
    );
    const pageStarts = references.flatMap(reference =>
      typeof reference.pageStart === 'number' ? [reference.pageStart] : []
    );
    const pageEnds = references.flatMap(reference =>
      typeof reference.pageEnd === 'number' ? [reference.pageEnd] : []
    );
    return [
      {
        ...(chunkIds.length ? { chunkIds: [...new Set(chunkIds)] } : {}),
        note: ORIGINAL_COURSE_SOURCE_NOTE,
        ...(pageEnds.length ? { pageEnd: Math.max(...pageEnds) } : {}),
        ...(pageStarts.length ? { pageStart: Math.min(...pageStarts) } : {}),
        ...(sourceId ? { sourceId } : {}),
        title: name,
      },
    ];
  });
  const fileName =
    isRecord(project.source.file) && typeof project.source.file.name === 'string'
      ? project.source.file.name.trim()
      : '';
  const primarySourceId = readAuthoritativePrimarySourceId(project);
  const archiveName =
    project.source.kind === 'archive' && typeof project.source.name === 'string'
      ? project.source.name.trim()
      : '';
  return mergeSources(
    descriptorSources,
    descriptors.length === 0 && fileName
      ? [
          {
            note: ORIGINAL_COURSE_SOURCE_NOTE,
            ...(primarySourceId ? { sourceId: primarySourceId } : {}),
            title: fileName,
          },
        ]
      : [],
    archiveName ? [{ note: ORIGINAL_COURSE_ARCHIVE_SOURCE_NOTE, title: archiveName }] : []
  );
};

export const youtubeSources = (outcome: YouTubeResearchOutcome): ResearchSource[] =>
  outcome.videoCandidates.map(video => ({
    note: 'Video con transcript consultato per questa lezione',
    title: video.title,
    url: video.url,
    youtubeTranscript: { segments: video.segments },
  }));

export const formatSourcesForPrompt = (sources: ResearchSource[]): string =>
  sources
    .map((source, sourceIndex) => {
      const sourceUrl = source.url ? ` — ${source.url}` : '';
      const transcript = source.youtubeTranscript
        ? `\nTranscript timestampato:\n${formatYouTubeTranscript(source.youtubeTranscript.segments)}\nUsa sourceIndex ${sourceIndex} per le clip.`
        : '';
      return `[${sourceIndex}] ${source.title}${sourceUrl}${transcript}`;
    })
    .join('\n\n');

const parsePdfImageAsset = (image: unknown): LessonPdfImageAsset | null => {
  if (
    !isRecord(image) ||
    typeof image.id !== 'string' ||
    typeof image.dataUrl !== 'string' ||
    typeof image.mimeType !== 'string'
  ) {
    return null;
  }
  return {
    dataUrl: image.dataUrl,
    id: image.id,
    mimeType: image.mimeType,
    sourceOrder: typeof image.sourceOrder === 'number' ? image.sourceOrder : 0,
    textAfter: typeof image.textAfter === 'string' ? image.textAfter : '',
    textBefore: typeof image.textBefore === 'string' ? image.textBefore : '',
    ...(typeof image.caption === 'string' ? { caption: image.caption } : {}),
    ...(typeof image.intrinsicHeight === 'number'
      ? { intrinsicHeight: image.intrinsicHeight }
      : {}),
    ...(typeof image.intrinsicWidth === 'number' ? { intrinsicWidth: image.intrinsicWidth } : {}),
    ...(typeof image.pageNumber === 'number' ? { pageNumber: image.pageNumber } : {}),
    ...(typeof image.sizeBytes === 'number' ? { sizeBytes: image.sizeBytes } : {}),
    ...(typeof image.sourceId === 'string' && image.sourceId.trim()
      ? { sourceId: image.sourceId.trim() }
      : {}),
    ...(typeof image.sourceHash === 'string' && image.sourceHash.trim()
      ? { sourceHash: image.sourceHash.trim() }
      : {}),
    ...(typeof image.textCurrent === 'string' ? { textCurrent: image.textCurrent } : {}),
  };
};

export const readExistingPdfImageAssets = (project: ProjectSnapshot): LessonPdfImageAsset[] => {
  if (!isRecord(project.documentAssets) || !Array.isArray(project.documentAssets.usedImages)) {
    return [];
  }
  return project.documentAssets.usedImages.flatMap(image => {
    const parsed = parsePdfImageAsset(image);
    return parsed ? [parsed] : [];
  });
};

const isChunkMappedToSource = (
  chunk: Record<string, unknown>,
  sourceId: string | undefined,
  sourceReferenceChunkIds: Set<string>
): boolean => {
  if (sourceId === undefined) return true;
  return typeof chunk.sourceId === 'string'
    ? chunk.sourceId === sourceId
    : sourceReferenceChunkIds.has(String(chunk.id));
};

const readPdfPageRange = (chunk: Record<string, unknown>): [number, number] | null => {
  const pageStart = typeof chunk.pageStart === 'number' ? Math.trunc(chunk.pageStart) : null;
  const pageEnd = typeof chunk.pageEnd === 'number' ? Math.trunc(chunk.pageEnd) : pageStart;
  return pageStart === null || pageEnd === null || pageStart < 1 || pageEnd < pageStart
    ? null
    : [pageStart, pageEnd];
};

export const readMappedPdfPages = (
  project: ProjectSnapshot,
  section: Record<string, unknown>,
  sourceId?: string
): number[] | undefined => {
  if (!isRecord(project.documentIndex) || !Array.isArray(project.documentIndex.chunks)) {
    return undefined;
  }
  const selectedChunkIds = readSectionChunkIds(section);
  const sourceReferenceChunkIds = new Set(
    sourceId === undefined ? [] : readReferenceChunkIds(section, sourceId)
  );
  const pages = new Set<number>();
  for (const chunk of project.documentIndex.chunks) {
    if (!isRecord(chunk)) continue;
    const chunkId = String(chunk.id);
    if (!selectedChunkIds.has(chunkId)) continue;
    if (!isChunkMappedToSource(chunk, sourceId, sourceReferenceChunkIds)) continue;
    const pageRange = readPdfPageRange(chunk);
    if (!pageRange) continue;
    const [pageStart, pageEnd] = pageRange;
    for (let page = pageStart; page <= pageEnd; page += 1) pages.add(page);
  }
  return pages.size ? [...pages].sort((left, right) => left - right) : undefined;
};

const toPdfImageAsset = (
  image: ExtractedPdfImage,
  sourceOrder: number,
  sourceId: string,
  sourceHash: string
): LessonPdfImageAsset => ({
  dataUrl: image.dataUrl,
  id: `pdf-img-${buildSha256HexDigest(
    Buffer.from(JSON.stringify([sourceId, sourceHash, image.hash]))
  )}`,
  intrinsicHeight: image.intrinsicHeight,
  intrinsicWidth: image.intrinsicWidth,
  mimeType: image.mimeType,
  pageNumber: image.pageNumber,
  sizeBytes: image.sizeBytes,
  sourceHash,
  sourceId,
  sourceOrder,
  textAfter: image.textAfter?.trim() || '',
  textBefore: image.textBefore?.trim() || '',
  textCurrent: image.textCurrent?.trim() || undefined,
});

export const extractStoredPdfImageAssets = async ({
  extractImages,
  project,
  section,
  signal,
  store,
  userId,
}: {
  extractImages: typeof extractPdfImages;
  project: ProjectSnapshot;
  section: Record<string, unknown>;
  signal: AbortSignal;
  store: ProjectStore;
  userId: string;
}): Promise<LessonPdfImageExtractionOutcome> => {
  if (project.sourceKind !== 'document') return { assets: [], warnings: [] };
  const storedSources = filterReferencedStoredSources(
    await loadStoredSourceCandidates(
      store,
      userId,
      project.id,
      readAuthoritativePrimarySourceId(project)
    ),
    section
  ).filter(candidate => isPdfProjectSourceFile(candidate.file));
  const singleSourcePartialPages =
    storedSources.length === 1 ? readMappedPdfPages(project, section) : undefined;
  const assets: LessonPdfImageAsset[] = [];
  const assetIds = new Set<string>();
  const warnings: LessonWorkflowWarning[] = [];
  const extractionFailures: unknown[] = [];
  let successfulSourceCount = 0;
  for (const source of storedSources) {
    signal.throwIfAborted();
    try {
      const partialPages =
        readMappedPdfPages(project, section, source.id) ?? singleSourcePartialPages;
      const extraction = await extractImages(
        `data:${source.file.mimeType};base64,${source.file.data}`,
        LESSON_PDF_IMAGE_EXTRACTION_LIMIT,
        partialPages,
        signal
      );
      successfulSourceCount += 1;
      warnings.push(
        ...extraction.failedPages.map(pageNumber => ({
          code: 'lesson_pdf_image_extraction_incomplete' as const,
          pageNumber,
          sourceId: source.id,
          stage: 'sources' as const,
        }))
      );
      for (const image of extraction.images) {
        const asset = toPdfImageAsset(image, assets.length + 1, source.id, source.hash);
        if (assetIds.has(asset.id)) continue;
        assetIds.add(asset.id);
        assets.push(asset);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      extractionFailures.push(error);
      warnings.push({
        code: 'lesson_pdf_image_extraction_incomplete',
        sourceId: source.id,
        stage: 'sources',
      });
      console.warn('[Lesson workflow] PDF image extraction failed for a stored source.', {
        error,
        projectId: project.id,
        sourceName: source.file.name,
      });
    }
  }
  signal.throwIfAborted();
  if (storedSources.length > 0 && successfulSourceCount === 0) {
    throw new LessonPdfImageExtractionError(extractionFailures[0]);
  }
  return { assets, warnings };
};

type StoredDocumentImage = Record<string, unknown> & { id: string };

const readDocumentAssetImages = (value: unknown): StoredDocumentImage[] => {
  if (!isRecord(value) || !Array.isArray(value.usedImages)) return [];
  return value.usedImages.flatMap(image =>
    isRecord(image) && typeof image.id === 'string' ? [{ ...image, id: image.id }] : []
  );
};

const readImageRefIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(reference =>
        isRecord(reference) && typeof reference.assetId === 'string' ? [reference.assetId] : []
      )
    : [];

const collectReferencedAssetIds = (
  project: ProjectSnapshot,
  sectionId: string,
  nextSectionImageRefs: unknown
): Set<string> => {
  const referencedAssetIds = new Set<string>();
  const candidates = [
    ...(project.learningPlan?.modules || []).flatMap(module => module.children || []),
    ...(project.learningPlan?.sections || []),
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || candidate.kind === 'exercise') continue;
    const imageRefs = candidate.id === sectionId ? nextSectionImageRefs : candidate.imageRefs;
    for (const assetId of readImageRefIds(imageRefs)) referencedAssetIds.add(assetId);
  }
  return referencedAssetIds;
};

const indexDocumentAssetImages = (
  currentAssets: Record<string, unknown> | null,
  incomingAssets: Record<string, unknown> | null
): Map<string, StoredDocumentImage> =>
  new Map(
    [...readDocumentAssetImages(currentAssets), ...readDocumentAssetImages(incomingAssets)].map(
      image => [image.id, image]
    )
  );

export const mergeProjectDocumentAssets = (
  project: ProjectSnapshot,
  sectionId: string,
  incomingAssets: unknown,
  nextSectionImageRefs: unknown
): Record<string, unknown> | undefined => {
  const currentAssets = isRecord(project.documentAssets) ? project.documentAssets : null;
  const incoming = isRecord(incomingAssets) ? incomingAssets : null;
  const template = incoming || currentAssets;
  if (!template) return undefined;

  const referencedAssetIds = collectReferencedAssetIds(project, sectionId, nextSectionImageRefs);
  const availableAssets = indexDocumentAssetImages(currentAssets, incoming);

  return {
    ...template,
    imageCount: Math.max(
      typeof currentAssets?.imageCount === 'number' ? currentAssets.imageCount : 0,
      typeof incoming?.imageCount === 'number' ? incoming.imageCount : 0
    ),
    kind: 'pdf',
    usedImages: [...referencedAssetIds].flatMap(assetId => {
      const image = availableAssets.get(assetId);
      return image ? [image] : [];
    }),
  };
};
