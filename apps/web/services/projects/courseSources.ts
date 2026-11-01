import {
  buildTextSourceIndex,
  flattenOutline,
  parseMarkdownOutline,
} from '@shared/courseSourceText';
import { translateUiMessage as t } from '../../i18n/uiMessages';

export { parseMarkdownOutline } from '@shared/courseSourceText';

import { combineCourseSourceIndexes } from '@shared/courseSourceIndex';
import { buildStableProjectSourceHash } from '@shared/projectSnapshotWire';
import { clipSourceExcerptText, sliceSourceText } from '@shared/sourceTextSlice';
import type {
  CourseSourceDescriptor,
  FileData,
  PdfTextIndex,
  ProjectSource,
  ProjectSourceRef,
  ProjectSourceWarning,
} from '../../types.ts';
import { timestampIso } from '../../utils/time.ts';
import { decodeTextBase64, isPdfFileData } from './projectSource.ts';

const MAX_SOURCE_CONTEXT_CHARS = 8_000;

const compareSourceNames = (left: string, right: string): number => {
  const normalizedLeft = left.normalize('NFKC').toLowerCase();
  const normalizedRight = right.normalize('NFKC').toLowerCase();
  if (normalizedLeft !== normalizedRight) {
    return normalizedLeft < normalizedRight ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
};

export const sortSourceFiles = <T extends Pick<FileData, 'name'>>(files: readonly T[]): T[] =>
  [...files].sort((left, right) => compareSourceNames(left.name, right.name));

const getSourceKind = (file: FileData): CourseSourceDescriptor['kind'] => {
  if (isPdfFileData(file)) {
    return 'pdf';
  }
  const lowerName = file.name.toLowerCase();
  return file.mimeType === 'text/markdown' || /\.(md|markdown|mdx)$/u.test(lowerName)
    ? 'markdown'
    : 'text';
};

export const buildCourseSourceDescriptors = (
  files: readonly FileData[],
  {
    hashOccurrences = new Map<string, number>(),
    positionOffset = 0,
  }: { hashOccurrences?: Map<string, number>; positionOffset?: number } = {}
): CourseSourceDescriptor[] => {
  return sortSourceFiles(files).map((originalFile, position) => {
    const hash = buildStableProjectSourceHash(originalFile);
    const occurrence = (hashOccurrences.get(hash) || 0) + 1;
    hashOccurrences.set(hash, occurrence);
    const id = `source-${hash}-${occurrence}`;
    const file = { ...originalFile, sourceId: id };
    const kind = getSourceKind(file);
    const text = kind === 'pdf' ? '' : decodeTextBase64(file.data);
    const outline = kind === 'markdown' ? parseMarkdownOutline(text, id) : [];
    const descriptor: CourseSourceDescriptor = {
      file,
      hash,
      id,
      kind,
      name: file.name,
      outline,
      outlineOrigin: outline.length > 0 ? 'deterministic' : 'none',
      position: position + positionOffset,
      status: 'ready',
    };
    if (kind !== 'pdf') {
      descriptor.documentIndex = buildTextSourceIndex(text, descriptor);
    }
    return descriptor;
  });
};

export const createProjectSourceFromDescriptors = (
  descriptors: readonly CourseSourceDescriptor[]
): ProjectSource => {
  const sources = normalizeCourseSourceOrder(descriptors);
  const primary = sources.find(source => source.status !== 'error') || sources[0];
  if (!primary) {
    throw new Error('At least one course source is required.');
  }
  if (primary.kind === 'pdf') {
    return { kind: 'pdf', file: primary.file, sources };
  }
  return {
    file: primary.file,
    kind: 'document',
    sources,
  };
};

export const getCourseSourceDescriptors = (
  source: ProjectSource | null | undefined
): CourseSourceDescriptor[] => {
  if (!source) {
    return [];
  }
  if (source.sources?.length) {
    return normalizeCourseSourceOrder(source.sources);
  }
  if (source.kind === 'pdf' || source.kind === 'document') {
    const [descriptor] = buildCourseSourceDescriptors([source.file]);
    if (!descriptor) {
      return [];
    }
    if (source.kind === 'pdf' && source.preparedPdfText)
      descriptor.preparedPdfText = source.preparedPdfText;
    if (!source.ref) {
      return [descriptor];
    }
    return [
      {
        ...descriptor,
        file: { ...descriptor.file, sourceId: source.ref.id },
        hash: source.ref.hash,
        id: source.ref.id,
        ref: source.ref,
      },
    ];
  }
  return [];
};

export const getCourseSourceFiles = (source: ProjectSource | null | undefined): FileData[] =>
  getCourseSourceDescriptors(source)
    .filter(descriptor => descriptor.status !== 'error' && descriptor.file.data)
    .map(descriptor => descriptor.file);

export const mergeCourseSourceDescriptors = (
  existingSources: readonly CourseSourceDescriptor[],
  replacements: readonly CourseSourceDescriptor[]
): CourseSourceDescriptor[] => {
  const existingSource = existingSources[0];
  const replacement = replacements[0];
  if (existingSources.length === 1 && replacements.length === 1 && existingSource && replacement) {
    return [
      {
        ...replacement,
        file: { ...replacement.file, sourceId: existingSource.id },
        id: existingSource.id,
        position: existingSource.position,
      },
    ];
  }

  const replacementsByName = new Map<string, CourseSourceDescriptor[]>();
  for (const replacement of replacements) {
    const normalizedName = replacement.name.normalize('NFKC').toLowerCase();
    const matchingReplacements = replacementsByName.get(normalizedName) || [];
    matchingReplacements.push(replacement);
    replacementsByName.set(normalizedName, matchingReplacements);
  }
  const merged = existingSources.map(existing => {
    const normalizedName = existing.name.normalize('NFKC').toLowerCase();
    const matchingReplacements = replacementsByName.get(normalizedName);
    const replacement = matchingReplacements?.shift();
    if (!replacement) {
      return existing;
    }
    if (matchingReplacements?.length === 0) {
      replacementsByName.delete(normalizedName);
    }
    return {
      ...replacement,
      file: { ...replacement.file, sourceId: existing.id },
      id: existing.id,
      position: existing.position,
    };
  });
  return normalizeCourseSourceOrder([...merged, ...[...replacementsByName.values()].flat()]);
};

export const attachStoredSources = (
  source: ProjectSource,
  storedFiles: readonly FileData[]
): ProjectSource => {
  const descriptors = getCourseSourceDescriptors(source);
  if (descriptors.length === 0 || storedFiles.length !== descriptors.length) {
    throw new Error('Stored course sources do not match the project source set.');
  }
  const filesBySourceId = new Map(
    storedFiles.map(file => {
      if (!file.sourceId) {
        throw new Error('Stored course source is missing its source ID.');
      }
      return [file.sourceId, file] as const;
    })
  );
  if (filesBySourceId.size !== storedFiles.length) {
    throw new Error('Stored course source IDs must be unique.');
  }

  const sources = descriptors.map(descriptor => {
    const file = filesBySourceId.get(descriptor.id);
    if (!file) {
      throw new Error(`Stored course source is missing: ${descriptor.id}`);
    }
    return { ...descriptor, file };
  });
  const primaryId = source.file.sourceId || descriptors[0]?.id;
  const primary = sources.find(descriptor => descriptor.id === primaryId);
  if (!primary) {
    throw new Error('Stored primary course source is missing.');
  }
  return { ...source, file: primary.file, sources };
};

export const detachStoredPrimarySource = <TSource extends ProjectSource>(
  source: TSource
): TSource => {
  const primaryId = source.file.sourceId || source.sources?.[0]?.id;
  return {
    ...source,
    file: { ...source.file, data: '' },
    sources: source.sources?.map(descriptor =>
      descriptor.id === primaryId
        ? { ...descriptor, file: { ...descriptor.file, data: '' } }
        : descriptor
    ),
  } as TSource;
};

export const detachStoredSources = <TSource extends ProjectSource>(
  source: TSource,
  refs: readonly ProjectSourceRef[]
): TSource => {
  const descriptors = getCourseSourceDescriptors(source);
  const refsById = new Map(refs.map(ref => [ref.id, ref]));
  if (
    descriptors.length === 0 ||
    refs.length !== descriptors.length ||
    refsById.size !== refs.length
  ) {
    throw new Error('Stored source references do not match the project source set.');
  }
  const sources = descriptors.map(descriptor => {
    const ref = refsById.get(descriptor.id);
    if (!ref) {
      throw new Error(`Stored source reference is missing: ${descriptor.id}`);
    }
    return {
      ...descriptor,
      file: {
        ...descriptor.file,
        data: '',
        mimeType: ref.mimeType,
        name: ref.name,
        sourceId: ref.id,
      },
      hash: ref.hash,
      ref,
    };
  });
  const primaryId = source.file.sourceId || descriptors[0]?.id;
  const primary = sources.find(descriptor => descriptor.id === primaryId);
  if (!primary) {
    throw new Error('Stored primary source reference is missing.');
  }
  return {
    ...source,
    file: primary.file,
    ref: primary.ref,
    sources,
  } as TSource;
};

export const normalizeCourseSourceOrder = (
  sources: readonly CourseSourceDescriptor[]
): CourseSourceDescriptor[] =>
  [...sources]
    .sort((left, right) => compareSourceNames(left.name, right.name))
    .map((source, position) => ({ ...source, position }));

export const buildCombinedSourceIndex = (
  sources: readonly CourseSourceDescriptor[]
): PdfTextIndex | null =>
  combineCourseSourceIndexes(normalizeCourseSourceOrder(sources), timestampIso);

const sampleSourceChunks = (source: CourseSourceDescriptor): string => {
  const chunks = source.documentIndex?.chunks || [];
  if (chunks.length === 0) {
    return '';
  }
  const indexes = new Set([0, Math.floor(chunks.length / 2), chunks.length - 1]);
  const text = [...indexes]
    .sort((left, right) => left - right)
    .map(index => clipSourceExcerptText(chunks[index]?.text || ''))
    .filter(Boolean)
    .join('\n\n');
  return sliceSourceText(text, 0, MAX_SOURCE_CONTEXT_CHARS);
};

export const formatCourseSourceSetContext = (sources: readonly CourseSourceDescriptor[]): string =>
  normalizeCourseSourceOrder(sources)
    .map(source => {
      const outline = flattenOutline(source.outline).map(({ node }) => ({
        level: node.level,
        page: node.page,
        title: node.title,
      }));
      return JSON.stringify({
        id: source.id,
        name: source.name,
        kind: source.kind,
        approximateBytes: source.ref?.byteSize ?? Math.floor((source.file.data.length * 3) / 4),
        status: source.status,
        outlineOrigin: source.outlineOrigin,
        outline,
        sampledContent: sampleSourceChunks(source),
      });
    })
    .join('\n');

const UNUSABLE_PDF_SOURCE_MESSAGE = 'Questa fonte non contiene testo PDF utilizzabile.';

export const getProjectSourceWarnings = (source: ProjectSource): ProjectSourceWarning[] => {
  const descriptorWarnings = (source.sources || [])
    .filter(descriptor => descriptor.status === 'error')
    .map(descriptor => ({
      message: descriptor.errorMessage || 'Questa fonte non è utilizzabile.',
      name: descriptor.name,
      reason: descriptor.errorReason,
    }));
  const missingPageWarnings = (source.sources || []).flatMap(descriptor =>
    (descriptor.preparedPdfText?.failedPages || []).map(pageNumber => ({
      name: descriptor.name,
      message: t('Pagina {page}: non trascritta.', { page: pageNumber }),
    }))
  );
  if (source.kind !== 'archive') {
    return [...(source.preparationWarnings ?? []), ...descriptorWarnings, ...missingPageWarnings];
  }

  const archivePdfWarnings = source.index.entries.flatMap(entry =>
    entry.kind === 'file' &&
    entry.contentKind === 'binary' &&
    entry.path.toLowerCase().endsWith('.pdf')
      ? [
          {
            message: UNUSABLE_PDF_SOURCE_MESSAGE,
            name: entry.path,
            reason: entry.warningReason || 'no-usable-text',
          },
        ]
      : []
  );
  return [...descriptorWarnings, ...archivePdfWarnings];
};
