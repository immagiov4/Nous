import {
  getSafeZipEntryPath,
  loadZipSafely,
  readZipEntryBytesWithinLimit,
} from '@shared/zipSafety';
import type { ExerciseAttachment } from '../../types.ts';
import { createEntityId } from '../../utils/ids.ts';
import { isBinaryFile } from '../../utils/project/codebaseBundle.ts';
import { normalizeLineEndings } from '../../utils/text.ts';
import { timestampIso } from '../../utils/time.ts';
import { decodeBase64Bytes, encodeBytesBase64 } from '../projects/projectSource.ts';
import {
  EXERCISE_MAX_ENTRIES,
  EXERCISE_MAX_ENTRY_CHARS,
  EXERCISE_MAX_TOTAL_CHARS,
  EXERCISE_TEXT_EXTENSION_ALLOWLIST,
  EXERCISE_ZIP_IGNORE_DIRS,
} from './constants.ts';

export interface ExerciseDeliverableEntry {
  path: string;
  text: string;
  truncated: boolean;
  truncatedReason?: string;
}

export interface ExerciseDeliverableValidationResult {
  dropped: string[];
  entries: ExerciseDeliverableEntry[];
  totalChars: number;
  truncations: string[];
}

const TEXT_MIME_TYPE_FALLBACK = 'text/plain';
const ZIP_MIME_TYPE_FALLBACK = 'application/zip';
const EXERCISE_MAX_ZIP_ENTRIES = 200;
const EXERCISE_MAX_ZIP_ENTRY_BYTES = 512_000;
const EXERCISE_MAX_ZIP_TOTAL_BYTES = EXERCISE_MAX_ZIP_ENTRIES * EXERCISE_MAX_ZIP_ENTRY_BYTES;
const INVALID_EXERCISE_ZIP_MESSAGE = 'Archivio ZIP non valido.';

const createExerciseAttachmentId = () => createEntityId({ fallbackPrefix: 'exercise-attachment' });

const getExtension = (path: string): string => {
  const normalized = path.toLowerCase();
  const lastSlashIndex = normalized.lastIndexOf('/');
  const lastDotIndex = normalized.lastIndexOf('.');
  return lastDotIndex > lastSlashIndex ? normalized.slice(lastDotIndex) : '';
};

const isZipFileName = (name: string, mimeType?: string): boolean => {
  const normalizedMimeType = (mimeType || '').split(';', 1)[0]?.trim().toLowerCase();
  return (
    normalizedMimeType === ZIP_MIME_TYPE_FALLBACK ||
    normalizedMimeType === 'application/x-zip-compressed' ||
    name.toLowerCase().endsWith('.zip')
  );
};

const isAllowedTextPath = (path: string): boolean =>
  EXERCISE_TEXT_EXTENSION_ALLOWLIST.has(getExtension(path));

const truncateAtBlockBoundary = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) {
    return text;
  }

  const candidate = text.slice(0, maxChars);
  const paragraphBoundary = candidate.lastIndexOf('\n\n');
  if (paragraphBoundary > maxChars * 0.6) {
    return candidate.slice(0, paragraphBoundary).trimEnd();
  }

  const lineBoundary = candidate.lastIndexOf('\n');
  if (lineBoundary > maxChars * 0.6) {
    return candidate.slice(0, lineBoundary).trimEnd();
  }

  return candidate.trimEnd();
};

const normalizeDeliverableText = (text: string): string => normalizeLineEndings(text).trim();

const buildTextEntry = (path: string, rawText: string): ExerciseDeliverableEntry | null => {
  const normalizedText = normalizeDeliverableText(rawText);
  if (!normalizedText) {
    return null;
  }

  if (normalizedText.length <= EXERCISE_MAX_ENTRY_CHARS) {
    return {
      path,
      text: normalizedText,
      truncated: false,
    };
  }

  return {
    path,
    text: truncateAtBlockBoundary(normalizedText, EXERCISE_MAX_ENTRY_CHARS),
    truncated: true,
    truncatedReason: `File troncato al limite di ${EXERCISE_MAX_ENTRY_CHARS} caratteri.`,
  };
};

const shouldIgnoreZipEntry = (path: string): boolean => {
  const parts = path.split('/').filter(Boolean);
  return parts.some(part => part.startsWith('.') || EXERCISE_ZIP_IGNORE_DIRS.has(part));
};

const buildZipSortMetadata = (paths: string[]) => {
  const siblingCountByParent = new Map<string, number>();
  for (const path of paths) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    siblingCountByParent.set(parent, (siblingCountByParent.get(parent) || 0) + 1);
  }
  return siblingCountByParent;
};

const sortZipEntries = (entries: Array<{ path: string; size: number }>) => {
  const siblingCountByParent = buildZipSortMetadata(entries.map(entry => entry.path));
  return entries.sort((left, right) => {
    const leftDepth = left.path.split('/').length;
    const rightDepth = right.path.split('/').length;
    if (leftDepth !== rightDepth) {
      return leftDepth - rightDepth;
    }

    const leftParent = left.path.includes('/')
      ? left.path.slice(0, left.path.lastIndexOf('/'))
      : '';
    const rightParent = right.path.includes('/')
      ? right.path.slice(0, right.path.lastIndexOf('/'))
      : '';
    const siblingDelta =
      (siblingCountByParent.get(leftParent) || 0) - (siblingCountByParent.get(rightParent) || 0);
    if (siblingDelta !== 0) {
      return siblingDelta;
    }

    return left.size - right.size || left.path.localeCompare(right.path);
  });
};

const addEntryWithinBudget = (
  result: ExerciseDeliverableValidationResult,
  entry: ExerciseDeliverableEntry
) => {
  if (result.entries.length >= EXERCISE_MAX_ENTRIES) {
    result.dropped.push(`${entry.path}: superato il limite di ${EXERCISE_MAX_ENTRIES} file.`);
    return;
  }

  const nextTotal = result.totalChars + entry.text.length;
  if (nextTotal > EXERCISE_MAX_TOTAL_CHARS) {
    result.dropped.push(
      `${entry.path}: superato il budget totale di ${EXERCISE_MAX_TOTAL_CHARS} caratteri.`
    );
    return;
  }

  result.entries.push(entry);
  result.totalChars = nextTotal;
  if (entry.truncated && entry.truncatedReason) {
    result.truncations.push(`${entry.path}: ${entry.truncatedReason}`);
  }
};

const createEmptyValidationResult = (): ExerciseDeliverableValidationResult => ({
  dropped: [],
  entries: [],
  totalChars: 0,
  truncations: [],
});

export const readExerciseTextAttachment = (attachment: ExerciseAttachment): string =>
  attachment.kind === 'text' ? attachment.data : '';

export const validateExerciseDeliverable = async (args: {
  attachments: ExerciseAttachment[];
  internalText?: string;
}): Promise<ExerciseDeliverableValidationResult> => {
  const result = createEmptyValidationResult();
  const internalText = normalizeDeliverableText(args.internalText || '');
  if (internalText) {
    const entry = buildTextEntry('risposta-interna.md', internalText);
    if (entry) {
      addEntryWithinBudget(result, entry);
    }
  }

  for (const attachment of args.attachments) {
    if (attachment.kind === 'text') {
      const entry = buildTextEntry(attachment.name, readExerciseTextAttachment(attachment));
      if (entry) {
        addEntryWithinBudget(result, entry);
      }
      continue;
    }

    const zip = await loadZipSafely(decodeBase64Bytes(attachment.data), {
      invalidArchiveMessage: INVALID_EXERCISE_ZIP_MESSAGE,
      maxEntries: EXERCISE_MAX_ZIP_ENTRIES,
      maxTotalUncompressedBytes: EXERCISE_MAX_ZIP_TOTAL_BYTES,
    });
    const candidates = sortZipEntries(
      Object.values(zip.files)
        .filter(entry => !entry.dir)
        .map(entry => getSafeZipEntryPath(entry))
        .filter((path): path is string => Boolean(path))
        .filter(path => !shouldIgnoreZipEntry(path))
        .filter(isAllowedTextPath)
        .map(path => ({ path, size: path.length }))
    );

    for (const candidate of candidates) {
      const zipEntry = zip.files[candidate.path];
      if (!zipEntry) {
        continue;
      }

      const bytes = await readZipEntryBytesWithinLimit(
        zipEntry,
        EXERCISE_MAX_ZIP_ENTRY_BYTES,
        INVALID_EXERCISE_ZIP_MESSAGE
      );
      if (isBinaryFile(bytes)) {
        result.dropped.push(`${candidate.path}: file binario ignorato.`);
        continue;
      }

      const entry = buildTextEntry(candidate.path, new TextDecoder('utf-8').decode(bytes));
      if (entry) {
        addEntryWithinBudget(result, entry);
      }
    }
  }

  return result;
};

export const createExerciseAttachmentFromFile = async (file: File): Promise<ExerciseAttachment> => {
  const now = timestampIso();
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (isZipFileName(file.name, file.type)) {
    const attachment: ExerciseAttachment = {
      id: createExerciseAttachmentId(),
      name: file.name,
      mimeType: file.type || ZIP_MIME_TYPE_FALLBACK,
      kind: 'archive',
      data: encodeBytesBase64(bytes),
      truncated: false,
      createdAt: now,
      updatedAt: now,
    };
    const validation = await validateExerciseDeliverable({ attachments: [attachment] });
    return {
      ...attachment,
      description: `${validation.entries.length} file testuali leggibili inclusi. ${
        validation.dropped.length
          ? `${validation.dropped.length} elementi ignorati per formato o budget.`
          : ''
      }`.trim(),
      truncated: validation.truncations.length > 0,
      truncatedReason: validation.truncations.join('\n') || undefined,
    };
  }

  if (!isAllowedTextPath(file.name) || isBinaryFile(bytes)) {
    throw new Error('Puoi allegare solo file testuali supportati o archivi .zip.');
  }

  const entry = buildTextEntry(file.name, new TextDecoder('utf-8').decode(bytes));
  if (!entry) {
    throw new Error('Il file testuale è vuoto o non leggibile.');
  }

  return {
    id: createExerciseAttachmentId(),
    name: file.name,
    mimeType: file.type || TEXT_MIME_TYPE_FALLBACK,
    kind: 'text',
    data: entry.text,
    truncated: entry.truncated,
    truncatedReason: entry.truncatedReason,
    createdAt: now,
    updatedAt: now,
  };
};
