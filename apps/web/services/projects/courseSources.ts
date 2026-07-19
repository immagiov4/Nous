import type {
  CourseSourceDescriptor,
  FileData,
  PdfTextChunk,
  PdfTextIndex,
  ProjectSource,
  ProjectSourceRef,
  SourceOutlineNode,
} from '../../types.ts';
import { timestampIso } from '../../utils/time.ts';
import { decodeTextBase64, isPdfFileData } from './projectSource.ts';

const MAX_SOURCE_CONTEXT_CHARS = 8_000;
const TEXT_CHUNK_CHARS = 8_000;

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

const buildStableSourceHash = (file: FileData): string => {
  let hash = 0x811c9dc5;
  const value = `${file.name}\0${file.mimeType}\0${file.data}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'section';

const getSourceKind = (file: FileData): CourseSourceDescriptor['kind'] => {
  if (isPdfFileData(file)) {
    return 'pdf';
  }
  const lowerName = file.name.toLowerCase();
  return file.mimeType === 'text/markdown' || /\.(md|markdown|mdx)$/u.test(lowerName)
    ? 'markdown'
    : 'text';
};

interface TextLine {
  start: number;
  text: string;
}

const splitTextLines = (text: string): TextLine[] => {
  const lines: TextLine[] = [];
  let start = 0;
  for (const match of text.matchAll(/.*(?:\n|$)/gu)) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    const lineText = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    lines.push({ start, text: lineText.replace(/\r$/u, '') });
    start += raw.length;
  }
  return lines;
};

export const parseMarkdownOutline = (text: string, sourceId: string): SourceOutlineNode[] => {
  const lines = splitTextLines(text);
  const flatNodes: SourceOutlineNode[] = [];
  const duplicateCounts = new Map<string, number>();
  let fenceMarker = '';

  const appendHeading = (title: string, level: number, startOffset: number) => {
    const normalizedTitle = title.replace(/[ \t]+#+[ \t]*$/u, '').trim();
    if (!normalizedTitle) {
      return;
    }
    const slug = slugify(normalizedTitle);
    const occurrence = (duplicateCounts.get(slug) || 0) + 1;
    duplicateCounts.set(slug, occurrence);
    flatNodes.push({
      children: [],
      id: `${sourceId}:outline:${slug}-${occurrence}`,
      level,
      startOffset,
      title: normalizedTitle,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.text.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fenceMarker) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        fenceMarker = '';
      }
      continue;
    }
    if (fenceMarker) {
      continue;
    }

    const atxMatch = line.text.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/u);
    if (atxMatch) {
      appendHeading(atxMatch[2], atxMatch[1].length, line.start);
      continue;
    }

    const setextMatch = line.text.match(/^ {0,3}(=+|-+)\s*$/u);
    const previousLine = lines[index - 1];
    if (setextMatch && previousLine?.text.trim()) {
      appendHeading(
        previousLine.text.trim(),
        setextMatch[1][0] === '=' ? 1 : 2,
        previousLine.start
      );
    }
  }

  flatNodes.forEach((node, index) => {
    node.endOffset =
      flatNodes.slice(index + 1).find(nextNode => nextNode.level <= node.level)?.startOffset ??
      text.length;
  });

  const roots: SourceOutlineNode[] = [];
  const stack: SourceOutlineNode[] = [];
  for (const node of flatNodes) {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    (parent?.children || roots).push(node);
    stack.push(node);
  }
  return roots;
};

const flattenOutline = (
  nodes: SourceOutlineNode[],
  parentTitles: string[] = []
): Array<{ node: SourceOutlineNode; path: string[] }> =>
  nodes.flatMap(node => {
    const path = [...parentTitles, node.title];
    return [{ node, path }, ...flattenOutline(node.children, path)];
  });

const buildTextIndex = (
  text: string,
  descriptor: Pick<CourseSourceDescriptor, 'hash' | 'id' | 'name' | 'outline'>
): PdfTextIndex => {
  const outlineEntries = flattenOutline(descriptor.outline).filter(
    entry => entry.node.startOffset !== undefined
  );
  const outlinedRanges = outlineEntries.map((entry, index) => ({
    end: outlineEntries[index + 1]?.node.startOffset ?? text.length,
    headingPath: entry.path,
    start: entry.node.startOffset || 0,
  }));
  const ranges = outlinedRanges.length
    ? outlinedRanges
    : [{ end: text.length, headingPath: [descriptor.name], start: 0 }];
  const chunks: PdfTextChunk[] = [];

  for (const range of ranges) {
    for (let offset = range.start; offset < range.end; offset += TEXT_CHUNK_CHARS) {
      const chunkText = text.slice(offset, Math.min(range.end, offset + TEXT_CHUNK_CHARS)).trim();
      if (!chunkText) {
        continue;
      }
      chunks.push({
        id: `${descriptor.id}:chunk-${String(chunks.length + 1).padStart(3, '0')}`,
        sourceId: descriptor.id,
        sequence: chunks.length,
        text: chunkText,
        headingPath: range.headingPath,
        startOffset: offset,
        endOffset: Math.min(range.end, offset + TEXT_CHUNK_CHARS),
      });
    }
  }

  return {
    kind: 'pdf-text-index',
    parsedAt: timestampIso(),
    sourceHash: descriptor.hash,
    sourceIds: [descriptor.id],
    documentTitle: descriptor.name,
    chunks,
  };
};

export const buildCourseSourceDescriptors = (
  files: readonly FileData[]
): CourseSourceDescriptor[] => {
  const hashOccurrences = new Map<string, number>();
  return sortSourceFiles(files).map((originalFile, position) => {
    const hash = buildStableSourceHash(originalFile);
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
      position,
      status: 'ready',
    };
    if (kind !== 'pdf') {
      descriptor.documentIndex = buildTextIndex(text, descriptor);
    }
    return descriptor;
  });
};

export const createProjectSourceFromDescriptors = (
  descriptors: readonly CourseSourceDescriptor[]
): ProjectSource => {
  const sources = normalizeCourseSourceOrder(descriptors);
  const primary =
    sources.find(source => source.status !== 'error' && source.file.data) || sources[0];
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
    if (!source.ref) {
      return [descriptor];
    }
    return [
      {
        ...descriptor,
        file: { ...descriptor.file, sourceId: source.ref.id },
        hash: source.ref.hash,
        id: source.ref.id,
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

export const attachStoredPrimarySource = (
  source: ProjectSource,
  storedFile: FileData
): ProjectSource => {
  const descriptors = getCourseSourceDescriptors(source);
  const primarySourceId = source.file.sourceId;
  const primary =
    descriptors.find(descriptor => descriptor.id === primarySourceId) || descriptors[0];
  const hydratedFile = primary ? { ...storedFile, sourceId: primary.id } : storedFile;
  const sources = primary
    ? descriptors.map(descriptor =>
        descriptor.id === primary.id ? { ...descriptor, file: hydratedFile } : descriptor
      )
    : source.sources;
  return { ...source, file: hydratedFile, sources };
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
): PdfTextIndex | null => {
  const readySources = normalizeCourseSourceOrder(sources).filter(
    source => source.status !== 'error' && source.documentIndex?.chunks.length
  );
  if (readySources.length === 0) {
    return null;
  }
  const chunks = readySources.flatMap(source =>
    (source.documentIndex?.chunks || []).map(chunk => ({
      ...chunk,
      headingPath:
        chunk.headingPath[0] === source.name
          ? chunk.headingPath
          : [source.name, ...chunk.headingPath],
      id: chunk.id.startsWith(`${source.id}:`) ? chunk.id : `${source.id}:${chunk.id}`,
      sourceId: source.id,
    }))
  );
  return {
    kind: 'pdf-text-index',
    parsedAt: timestampIso(),
    sourceHash: readySources.map(source => source.hash).join(':'),
    sourceIds: readySources.map(source => source.id),
    documentTitle: readySources.map(source => source.name).join(', '),
    chunks: chunks.map((chunk, sequence) => ({ ...chunk, sequence })),
  };
};

const sampleSourceChunks = (source: CourseSourceDescriptor): string => {
  const chunks = source.documentIndex?.chunks || [];
  if (chunks.length === 0) {
    return '';
  }
  const indexes = new Set([0, Math.floor(chunks.length / 2), chunks.length - 1]);
  return [...indexes]
    .sort((left, right) => left - right)
    .map(index => chunks[index]?.text || '')
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_SOURCE_CONTEXT_CHARS);
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
