import { createHash } from 'node:crypto';

import { isRecord } from '../utils/validation.js';
import type {
  ProjectSnapshot,
  ProjectSourceFile,
  ProjectSourceRef,
  ProjectSourceUpload,
  StoredProjectSourceFile,
} from './types.js';

const STORED_SOURCE_KINDS = new Set(['archive', 'document', 'pdf']);

export const resolveProjectSourceTextKind = (
  file: Pick<ProjectSourceFile, 'mimeType' | 'name'>
): 'markdown' | 'pdf' | 'text' => {
  if (file.mimeType === 'application/pdf') return 'pdf';
  if (file.mimeType === 'text/markdown' || file.name.endsWith('.md')) return 'markdown';
  return 'text';
};

export const readEmbeddedProjectSource = (snapshot: ProjectSnapshot): ProjectSourceFile | null => {
  if (
    !isRecord(snapshot.source) ||
    typeof snapshot.source.kind !== 'string' ||
    !STORED_SOURCE_KINDS.has(snapshot.source.kind)
  ) {
    return null;
  }

  const file = snapshot.source.file;
  if (
    !isRecord(file) ||
    typeof file.name !== 'string' ||
    typeof file.mimeType !== 'string' ||
    typeof file.data !== 'string' ||
    !file.data
  ) {
    return null;
  }

  return {
    name: file.name,
    mimeType: file.mimeType,
    data: file.data,
    ...(typeof file.sourceId === 'string' ? { sourceId: file.sourceId } : {}),
  };
};

export const preserveStoredProjectSource = (
  snapshot: ProjectSnapshot,
  storedSnapshot: ProjectSnapshot
): ProjectSnapshot =>
  snapshot.source == null && storedSnapshot.source != null
    ? {
        ...snapshot,
        source: storedSnapshot.source,
        sourceKind: storedSnapshot.sourceKind,
      }
    : snapshot;

export const prepareProjectSource = (
  file: ProjectSourceFile,
  sourceId?: string
): { bytes: Uint8Array; ref: Omit<ProjectSourceRef, 'objectPath'> } => {
  const bytes = Buffer.from(file.data, 'base64');
  return prepareProjectSourceBytes(file, bytes, sourceId);
};

export const prepareProjectSourceBytes = (
  file: Pick<ProjectSourceFile, 'mimeType' | 'name'>,
  bytes: Uint8Array,
  sourceId?: string
): { bytes: Uint8Array; ref: Omit<ProjectSourceRef, 'objectPath'> } => {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return {
    bytes,
    ref: {
      id: sourceId || `source-${hash.slice(0, 24)}`,
      hash,
      byteSize: bytes.byteLength,
      name: file.name,
      mimeType: file.mimeType,
    },
  };
};

const readSourceFile = (value: unknown): ProjectSourceFile | null => {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string' ||
    typeof value.data !== 'string'
  ) {
    return null;
  }
  return { data: value.data, mimeType: value.mimeType, name: value.name };
};

export const readEmbeddedProjectSources = (snapshot: ProjectSnapshot): ProjectSourceUpload[] => {
  const source = isRecord(snapshot.source) ? snapshot.source : null;
  if (
    !source ||
    typeof source.kind !== 'string' ||
    !STORED_SOURCE_KINDS.has(source.kind) ||
    !Array.isArray(source.sources) ||
    source.sources.length === 0
  ) {
    return [];
  }

  const uploads = source.sources.map((descriptor, position) => {
    if (!isRecord(descriptor) || typeof descriptor.id !== 'string') {
      throw new Error('Project source descriptor is invalid.');
    }
    const file = readSourceFile(descriptor.file);
    if (!file) {
      throw new Error(`Project source file is invalid: ${descriptor.id}`);
    }
    return { file, id: descriptor.id, position };
  });
  const embeddedCount = uploads.filter(upload => upload.file.data).length;
  if (embeddedCount !== 0 && embeddedCount !== uploads.length) {
    throw new Error('Project source set cannot mix embedded and detached files.');
  }
  return embeddedCount === 0 ? [] : uploads;
};

export const buildProjectSourceObjectPath = (
  userId: string,
  projectId: string,
  sourceId: string,
  sourceHash: string
): string => {
  const projectPathId = createHash('sha256').update(projectId).digest('hex');
  return `users/${userId}/projects/${projectPathId}/${sourceId}/${sourceHash}/original`;
};

export const buildProjectSourceEntryObjectPath = (
  userId: string,
  projectId: string,
  sourceId: string,
  sourceHash: string,
  entryPath: string,
  entryHash: string
): string => {
  const originalPath = buildProjectSourceObjectPath(userId, projectId, sourceId, sourceHash);
  const entryPathId = createHash('sha256').update(entryPath).digest('hex');
  return `${originalPath.slice(0, -'/original'.length)}/entries/${entryPathId}/${entryHash}`;
};

export const detachProjectSource = (
  snapshot: ProjectSnapshot,
  ref: ProjectSourceRef
): ProjectSnapshot => {
  const source = isRecord(snapshot.source) ? snapshot.source : null;
  if (
    !source ||
    typeof source.kind !== 'string' ||
    !STORED_SOURCE_KINDS.has(source.kind) ||
    !isRecord(source.file)
  ) {
    return snapshot;
  }
  const primarySourceId =
    typeof source.file.sourceId === 'string' ? source.file.sourceId : undefined;

  return {
    ...snapshot,
    source: {
      ...source,
      file: {
        ...source.file,
        name: ref.name,
        mimeType: ref.mimeType,
        data: '',
      },
      sources: Array.isArray(source.sources)
        ? source.sources.map((descriptor, index) =>
            isRecord(descriptor) &&
            isRecord(descriptor.file) &&
            (primarySourceId ? descriptor.id === primarySourceId : index === 0)
              ? {
                  ...descriptor,
                  file: {
                    ...descriptor.file,
                    name: ref.name,
                    mimeType: ref.mimeType,
                    data: '',
                  },
                }
              : descriptor
          )
        : source.sources,
      ref,
    },
  };
};

export const attachProjectSource = (
  snapshot: ProjectSnapshot,
  file: ProjectSourceFile
): ProjectSnapshot => {
  const source = isRecord(snapshot.source) ? snapshot.source : null;
  if (!source || typeof source.kind !== 'string' || !STORED_SOURCE_KINDS.has(source.kind)) {
    return snapshot;
  }
  const primarySourceId =
    isRecord(source.file) && typeof source.file.sourceId === 'string'
      ? source.file.sourceId
      : undefined;

  return {
    ...snapshot,
    source: {
      ...source,
      file: isRecord(source.file) ? { ...source.file, ...file } : file,
      sources: Array.isArray(source.sources)
        ? source.sources.map((descriptor, index) =>
            isRecord(descriptor) &&
            isRecord(descriptor.file) &&
            (primarySourceId ? descriptor.id === primarySourceId : index === 0)
              ? { ...descriptor, file: { ...descriptor.file, ...file } }
              : descriptor
          )
        : source.sources,
    },
  };
};

export const detachProjectSources = (
  snapshot: ProjectSnapshot,
  refs: readonly ProjectSourceRef[]
): ProjectSnapshot => {
  const source = isRecord(snapshot.source) ? snapshot.source : null;
  if (!source || !Array.isArray(source.sources) || source.sources.length === 0) {
    throw new Error('Project source set is missing.');
  }
  const refsById = new Map(refs.map(ref => [ref.id, ref]));
  if (refsById.size !== refs.length || refs.length !== source.sources.length) {
    throw new Error('Stored source references do not match the project source set.');
  }
  const sources = source.sources.map(descriptor => {
    if (!isRecord(descriptor) || typeof descriptor.id !== 'string' || !isRecord(descriptor.file)) {
      throw new Error('Project source descriptor is invalid.');
    }
    const ref = refsById.get(descriptor.id);
    if (!ref) {
      throw new Error(`Stored source reference is missing: ${descriptor.id}`);
    }
    return {
      ...descriptor,
      id: descriptor.id,
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
  const primarySourceId =
    isRecord(source.file) && typeof source.file.sourceId === 'string'
      ? source.file.sourceId
      : refs[0]?.id;
  const primary = sources.find(
    descriptor => isRecord(descriptor) && descriptor.id === primarySourceId
  );
  if (!primary || !isRecord(primary.file)) {
    throw new Error('Stored primary source reference is missing.');
  }
  return {
    ...snapshot,
    source: { ...source, file: primary.file, ref: primary.ref, sources },
  };
};

export const attachProjectSources = (
  snapshot: ProjectSnapshot,
  storedFiles: readonly StoredProjectSourceFile[]
): ProjectSnapshot => {
  const source = isRecord(snapshot.source) ? snapshot.source : null;
  if (!source || !Array.isArray(source.sources) || source.sources.length === 0) {
    throw new Error('Project source set is missing.');
  }
  const filesById = new Map(storedFiles.map(stored => [stored.ref.id, stored]));
  if (filesById.size !== storedFiles.length || storedFiles.length !== source.sources.length) {
    throw new Error('Stored course sources do not match the project source set.');
  }
  const sources = source.sources.map(descriptor => {
    if (!isRecord(descriptor) || typeof descriptor.id !== 'string' || !isRecord(descriptor.file)) {
      throw new Error('Project source descriptor is invalid.');
    }
    const stored = filesById.get(descriptor.id);
    if (!stored) {
      throw new Error(`Stored course source is missing: ${descriptor.id}`);
    }
    return {
      ...descriptor,
      id: descriptor.id,
      file: { ...descriptor.file, ...stored.file, sourceId: stored.ref.id },
      ref: stored.ref,
    };
  });
  const primarySourceId =
    isRecord(source.file) && typeof source.file.sourceId === 'string'
      ? source.file.sourceId
      : storedFiles[0]?.ref.id;
  const primary = sources.find(
    descriptor => isRecord(descriptor) && descriptor.id === primarySourceId
  );
  if (!primary || !isRecord(primary.file)) {
    throw new Error('Stored primary course source is missing.');
  }
  return { ...snapshot, source: { ...source, file: primary.file, sources } };
};
