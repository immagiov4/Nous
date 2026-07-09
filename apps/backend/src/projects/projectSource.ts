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

  return {
    ...snapshot,
    source: {
      ...source,
      file,
    },
  };
};
