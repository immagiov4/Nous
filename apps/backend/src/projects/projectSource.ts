import { createHash } from 'node:crypto';

import { isRecord } from '../utils/validation.js';
import type { ProjectSnapshot, ProjectSourceFile, ProjectSourceRef } from './types.js';

export const readEmbeddedPdfSource = (snapshot: ProjectSnapshot): ProjectSourceFile | null => {
  if (!isRecord(snapshot.source) || snapshot.source.kind !== 'pdf') {
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
  };
};

export const prepareProjectSource = (
  file: ProjectSourceFile
): { bytes: Uint8Array; ref: ProjectSourceRef } => {
  const bytes = Buffer.from(file.data, 'base64');
  const hash = createHash('sha256').update(bytes).digest('hex');
  return {
    bytes,
    ref: {
      id: `source-${hash.slice(0, 24)}`,
      hash,
      byteSize: bytes.byteLength,
      name: file.name,
      mimeType: file.mimeType,
    },
  };
};

export const detachProjectSource = (
  snapshot: ProjectSnapshot,
  ref: ProjectSourceRef
): ProjectSnapshot => {
  const source = isRecord(snapshot.source) ? snapshot.source : null;
  if (!source || source.kind !== 'pdf' || !isRecord(source.file)) {
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
  if (!source || source.kind !== 'pdf') {
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
