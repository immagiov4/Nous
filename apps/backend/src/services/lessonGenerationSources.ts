import {
  DEFAULT_LESSON_CONTEXT_CHUNKS,
  MAX_LESSON_COMBINED_SOURCE_CONTEXT_CHARS,
  MAX_LESSON_CONTEXT_CHUNKS,
  MAX_LESSON_SOURCE_CONTEXT_CHARS,
} from '@shared/lessonSourceContext';
import { LESSON_PDF_IMAGE_EXTRACTION_LIMIT } from '@shared/pdfImagePolicy';
import { SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES } from '@shared/sourceArchiveSelectors';

import { SourceArchiveAccess } from '../projects/sourceArchiveAccess.js';
import type { ProjectSnapshot, ProjectStore } from '../projects/types.js';
import { isRecord } from '../utils/validation.js';
import type { ExtractedPdfImage, extractPdfImages } from './pdfImageExtractor.js';
import { extractPdfText } from './pdfTextExtractor.js';
import type { YouTubeResearchOutcome } from './youtubeResearch.js';

export interface ResearchSource {
  note?: string;
  title: string;
  url?: string;
  youtubeTranscript?: {
    ranges: Array<{ endSeconds: number; startSeconds: number }>;
    text: string;
  };
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
  sourceOrder: number;
  textAfter: string;
  textBefore: string;
  textCurrent?: string;
}

export interface LessonImageCandidate {
  caption?: string;
  id: string;
  pageNumber?: number;
  textAfter?: string;
  textBefore?: string;
  textCurrent?: string;
}

const clipSourceContext = (value: string, maxChars: number): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n[estratto della fonte troncato]`;
};

const readSectionSourceIds = (
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
  const selectedChunkIds = new Set([
    ...(Array.isArray(section.primaryChunkIds)
      ? section.primaryChunkIds.filter((id): id is string => typeof id === 'string')
      : []),
    ...(Array.isArray(section.sourceReferences)
      ? section.sourceReferences.flatMap(reference =>
          isRecord(reference) && Array.isArray(reference.chunkIds)
            ? reference.chunkIds.filter((id): id is string => typeof id === 'string')
            : []
        )
      : []),
  ]);
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
  const primaryChunkIds = Array.isArray(section.primaryChunkIds)
    ? section.primaryChunkIds.filter((id): id is string => typeof id === 'string')
    : [];
  const referencedChunkIds = Array.isArray(section.sourceReferences)
    ? section.sourceReferences.flatMap(reference =>
        isRecord(reference) && Array.isArray(reference.chunkIds)
          ? reference.chunkIds.filter((id): id is string => typeof id === 'string')
          : []
      )
    : [];
  const chunks = project.documentIndex.chunks.filter(isRecord);
  const selectedIds = new Set([...primaryChunkIds, ...referencedChunkIds]);
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
    .map(chunk => (isRecord(chunk) && typeof chunk.text === 'string' ? chunk.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n---\n\n');
};

const isPdfSourceFile = (file: { mimeType: string; name: string }): boolean =>
  file.mimeType.toLowerCase() === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

const decodeStoredSourceText = async (file: {
  data: string;
  mimeType: string;
  name: string;
}): Promise<string> => {
  if (isPdfSourceFile(file)) {
    return (await extractPdfText(`data:${file.mimeType};base64,${file.data}`)).text;
  }
  return Buffer.from(file.data, 'base64').toString('utf8');
};

interface StoredSourceCandidate {
  file: { data: string; mimeType: string; name: string };
  id: string;
}

const loadStoredSourceCandidates = async (
  store: ProjectStore,
  userId: string,
  projectId: string
): Promise<StoredSourceCandidate[]> => {
  const storedSources = await store.loadProjectSources(userId, projectId);
  if (storedSources.length) {
    return storedSources.map(source => ({ file: source.file, id: source.ref.id }));
  }
  const primarySource = await store.loadProjectSource(userId, projectId);
  return primarySource
    ? [{ file: primarySource, id: primarySource.sourceId || primarySource.name }]
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
      await decodeStoredSourceText(candidate.file),
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
  if (!index) throw new Error('Source archive not found for lesson generation.');
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
  const transcript = isRecord(value.youtubeTranscript) ? value.youtubeTranscript : null;
  const ranges = Array.isArray(transcript?.ranges)
    ? transcript.ranges.flatMap(range =>
        isRecord(range) &&
        typeof range.startSeconds === 'number' &&
        typeof range.endSeconds === 'number'
          ? [{ endSeconds: range.endSeconds, startSeconds: range.startSeconds }]
          : []
      )
    : [];
  return {
    title: value.title.trim(),
    ...(typeof value.url === 'string' && value.url.trim() ? { url: value.url.trim() } : {}),
    ...(typeof value.note === 'string' && value.note.trim() ? { note: value.note.trim() } : {}),
    ...(transcript && typeof transcript.text === 'string' && transcript.text.trim() && ranges.length
      ? { youtubeTranscript: { ranges, text: transcript.text.trim() } }
      : {}),
  };
};

export const readExistingDossier = (project: ProjectSnapshot, sectionId: string) => {
  const value = project.researchDossiersBySectionId?.[sectionId];
  return isRecord(value) ? value : null;
};

export const readProjectLanguage = (project: ProjectSnapshot): string =>
  project.userProfile?.language || 'Italiano';

const sourceKey = (source: ResearchSource): string =>
  source.url || source.title.toLocaleLowerCase();

export const mergeSources = (...sourceGroups: ResearchSource[][]): ResearchSource[] => {
  const sources = new Map<string, ResearchSource>();
  for (const source of sourceGroups.flat()) {
    const key = sourceKey(source);
    const existing = sources.get(key);
    sources.set(key, existing?.youtubeTranscript ? existing : { ...existing, ...source });
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
  const descriptorSources = descriptors.flatMap(descriptor => {
    if (!isRecord(descriptor)) return [];
    if (
      selectedSourceIds.size > 0 &&
      typeof descriptor.id === 'string' &&
      !selectedSourceIds.has(descriptor.id)
    ) {
      return [];
    }
    const name =
      (typeof descriptor.name === 'string' && descriptor.name.trim()) ||
      (isRecord(descriptor.file) && typeof descriptor.file.name === 'string'
        ? descriptor.file.name.trim()
        : '');
    return name ? [{ note: 'Materiale originale del corso', title: name }] : [];
  });
  const fileName =
    isRecord(project.source.file) && typeof project.source.file.name === 'string'
      ? project.source.file.name.trim()
      : '';
  const archiveName =
    project.source.kind === 'archive' && typeof project.source.name === 'string'
      ? project.source.name.trim()
      : '';
  return mergeSources(
    descriptorSources,
    descriptors.length === 0 && fileName
      ? [{ note: 'Materiale originale del corso', title: fileName }]
      : [],
    archiveName ? [{ note: 'Archivio sorgente del corso', title: archiveName }] : []
  );
};

export const youtubeSources = (outcome: YouTubeResearchOutcome): ResearchSource[] =>
  outcome.videoCandidates.map(video => ({
    note: 'Video con transcript consultato per questa lezione',
    title: video.title,
    url: video.url,
    youtubeTranscript: { ranges: video.ranges, text: video.transcript },
  }));

export const formatSourcesForPrompt = (sources: ResearchSource[]): string =>
  sources
    .map((source, sourceIndex) => {
      const sourceUrl = source.url ? ` — ${source.url}` : '';
      const transcript = source.youtubeTranscript
        ? `\nTranscript timestampato:\n${source.youtubeTranscript.text}\nIntervalli consentiti: ${JSON.stringify(source.youtubeTranscript.ranges)}\nUsa sourceIndex ${sourceIndex} per le clip.`
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

export const toImageCandidate = (image: LessonPdfImageAsset): LessonImageCandidate => ({
  caption: image.caption,
  id: image.id,
  pageNumber: image.pageNumber,
  textAfter: image.textAfter || undefined,
  textBefore: image.textBefore || undefined,
  textCurrent: image.textCurrent || undefined,
});

const readMappedPdfPages = (
  project: ProjectSnapshot,
  section: Record<string, unknown>
): number[] | undefined => {
  if (!isRecord(project.documentIndex) || !Array.isArray(project.documentIndex.chunks)) {
    return undefined;
  }
  const selectedChunkIds = new Set([
    ...(Array.isArray(section.primaryChunkIds)
      ? section.primaryChunkIds.filter((id): id is string => typeof id === 'string')
      : []),
    ...(Array.isArray(section.sourceReferences)
      ? section.sourceReferences.flatMap(reference =>
          isRecord(reference) && Array.isArray(reference.chunkIds)
            ? reference.chunkIds.filter((id): id is string => typeof id === 'string')
            : []
        )
      : []),
  ]);
  const pages = new Set<number>();
  for (const chunk of project.documentIndex.chunks) {
    if (!isRecord(chunk) || !selectedChunkIds.has(String(chunk.id))) continue;
    const pageStart = typeof chunk.pageStart === 'number' ? Math.trunc(chunk.pageStart) : null;
    const pageEnd = typeof chunk.pageEnd === 'number' ? Math.trunc(chunk.pageEnd) : pageStart;
    if (pageStart === null || pageEnd === null || pageStart < 1 || pageEnd < pageStart) continue;
    for (let page = pageStart; page <= pageEnd; page += 1) pages.add(page);
  }
  return pages.size ? [...pages].sort((left, right) => left - right) : undefined;
};

const toPdfImageAsset = (image: ExtractedPdfImage, sourceOrder: number): LessonPdfImageAsset => ({
  dataUrl: image.dataUrl,
  id: `pdf-img-${image.hash.slice(0, 24)}`,
  intrinsicHeight: image.intrinsicHeight,
  intrinsicWidth: image.intrinsicWidth,
  mimeType: image.mimeType,
  pageNumber: image.pageNumber,
  sizeBytes: image.sizeBytes,
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
}): Promise<LessonPdfImageAsset[]> => {
  if (project.sourceKind !== 'document') return [];
  const storedSources = filterReferencedStoredSources(
    await loadStoredSourceCandidates(store, userId, project.id),
    section
  ).filter(candidate => isPdfSourceFile(candidate.file));
  const partialPages = readMappedPdfPages(project, section);
  const assets: LessonPdfImageAsset[] = [];
  for (const source of storedSources) {
    signal.throwIfAborted();
    try {
      const images = await extractImages(
        `data:${source.file.mimeType};base64,${source.file.data}`,
        LESSON_PDF_IMAGE_EXTRACTION_LIMIT,
        partialPages
      );
      for (const image of images) {
        if (assets.some(candidate => candidate.id === `pdf-img-${image.hash.slice(0, 24)}`)) {
          continue;
        }
        assets.push(toPdfImageAsset(image, assets.length + 1));
      }
    } catch (error) {
      console.warn('[Generation job] Optional PDF image extraction failed.', {
        error,
        projectId: project.id,
        sourceName: source.file.name,
      });
    }
  }
  signal.throwIfAborted();
  return assets;
};

export const mergePdfImageAssets = (
  existing: LessonPdfImageAsset[],
  extracted: LessonPdfImageAsset[]
): LessonPdfImageAsset[] => {
  const byId = new Map(existing.map(image => [image.id, image]));
  for (const image of extracted) byId.set(image.id, image);
  return [...byId.values()];
};

export const buildDocumentAssets = (
  project: ProjectSnapshot,
  availableImages: LessonPdfImageAsset[],
  imageRefs: Array<{ assetId: string }>
): Record<string, unknown> | undefined => {
  if (!isRecord(project.documentAssets) && availableImages.length === 0) return undefined;
  const selectedIds = new Set(imageRefs.map(image => image.assetId));
  const usedImages = availableImages.filter(image => selectedIds.has(image.id));
  const source = isRecord(project.source) ? project.source : null;
  const sourceRef = source && isRecord(source.ref) ? source.ref : null;
  return {
    ...(isRecord(project.documentAssets) ? project.documentAssets : {}),
    imageCount: Math.max(
      availableImages.length,
      isRecord(project.documentAssets) && typeof project.documentAssets.imageCount === 'number'
        ? project.documentAssets.imageCount
        : 0
    ),
    kind: 'pdf',
    parsedAt: new Date().toISOString(),
    ...(sourceRef && typeof sourceRef.hash === 'string' ? { sourceHash: sourceRef.hash } : {}),
    usedImages,
  };
};

const readDocumentAssetImages = (value: unknown): LessonPdfImageAsset[] => {
  if (!isRecord(value) || !Array.isArray(value.usedImages)) return [];
  return value.usedImages.flatMap(image => {
    const parsed = parsePdfImageAsset(image);
    return parsed ? [parsed] : [];
  });
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
  for (const module of project.learningPlan?.modules || []) {
    for (const candidate of module.children || []) {
      if (!isRecord(candidate) || candidate.kind === 'exercise') continue;
      const imageRefs = candidate.id === sectionId ? nextSectionImageRefs : candidate.imageRefs;
      for (const assetId of readImageRefIds(imageRefs)) referencedAssetIds.add(assetId);
    }
  }
  return referencedAssetIds;
};

const indexDocumentAssetImages = (
  currentAssets: Record<string, unknown> | null,
  incomingAssets: Record<string, unknown> | null
): Map<string, LessonPdfImageAsset> =>
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
