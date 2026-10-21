import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { combineCourseSourceIndexes, type IndexedCourseSource } from '@shared/courseSourceIndex';
import { buildTextSourceIndex, parseMarkdownOutline } from '@shared/courseSourceText';
import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import type { PdfTextIndex } from '@shared/pdfTextIndex';
import { buildPdfTextIndex } from '@shared/pdfTextIndex';
import {
  SOURCE_INGESTION_REQUIRED_MESSAGE,
  SOURCE_PREPARATION_FAILURE_MESSAGES,
  SOURCE_PREPARATION_UNUSABLE_MESSAGE,
  type SourcePreparationFailure,
} from '@shared/sourcePreparation';
import { isSafeZipEntryPath } from '@shared/zipSafety';
import { preparePdfTextExtraction } from '../services/pdfPageTranscription.js';
import {
  PdfTextExtractionOutputLimitError,
  PdfTextExtractionTimeoutError,
} from '../services/pdfTextExtractor.js';
import { countRetainedScannedPages } from '../services/pdfTranscriptionCollection.js';
import { PdfScannedPageLimitError } from '../services/pdfTranscriptionPolicy.js';
import type { ProjectSourceMaterial } from '../services/projectSourceText.js';
import {
  isPdfProjectSourceFile,
  readPreparedProjectPdfText,
  readProjectSourceMaterial,
} from '../services/projectSourceText.js';
import { isRecord } from '../utils/validation.js';
import { ProjectImportInputError } from './projectImportChunks.js';
import { restoreStoredPreparedPdfText } from './projectSource.js';
import type { SourcePreparationContext } from './sourcePreparationContext.js';
import { collectReleasedSourceMemory } from './sourcePreparationMemory.js';
import type { ProjectSaveOptions, ProjectSnapshot } from './types.js';

export class SourceIngestionRequiredError extends Error {
  constructor() {
    super(SOURCE_INGESTION_REQUIRED_MESSAGE);
  }
}

export class SourcePreparationUnusableError extends Error {
  constructor(readonly failures: SourcePreparationFailure[]) {
    super(SOURCE_PREPARATION_UNUSABLE_MESSAGE);
  }
}

class SourceHasNoTextError extends Error {}
const failureReason = (error: unknown): SourcePreparationFailure['reason'] => {
  if (error instanceof SourceHasNoTextError) return 'no-usable-text';
  if (error instanceof PdfTextExtractionTimeoutError) return 'timeout';
  if (error instanceof PdfTextExtractionOutputLimitError) return 'safety-limit';
  return 'parser-failed';
};

interface SourceDescriptor extends IndexedCourseSource {
  [field: string]: unknown;
}

type SourceUpload = NonNullable<ProjectSaveOptions['sourceFiles']>;

const readFileSegment = async (
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  offset: number
) => {
  let read = 0;
  while (read < bytes.length) {
    const result = await handle.read(bytes, read, bytes.length - read, offset + read);
    if (!result.bytesRead) throw new ProjectImportInputError('File sorgente incompleto.');
    read += result.bytesRead;
  }
};

/** Runs the server preparation steps for one file. */
const prepareSourceFile = async (
  bytes: Buffer,
  file: SourceUpload['files'][number],
  descriptor: SourceDescriptor,
  context: SourcePreparationContext
) => {
  context.signal.throwIfAborted();
  // Uploaded members are files, never another trusted archive container.
  if (
    bytes.length >= 4 &&
    bytes.readUInt16LE(0) === 0x4b50 &&
    [0x0403, 0x0605, 0x0807].includes(bytes.readUInt16LE(2))
  )
    throw new ProjectImportInputError('Gli archivi devono essere espansi prima del caricamento.');
  if (file.mimeType.toLowerCase().includes('zip') || file.name.toLowerCase().endsWith('.zip'))
    throw new ProjectImportInputError('Gli archivi devono essere espansi prima del caricamento.');
  const material = isPdfProjectSourceFile(file)
    ? await readProjectSourceMaterial({ ...file, data: bytes.toString('base64') })
    : { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  context.signal.throwIfAborted();
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!material.pdf)
    return { completion: Promise.resolve(finishSourceFile(material, file, descriptor, hash)) };
  const prepared = await preparePdfTextExtraction(bytes, material.pdf, {
    context,
    documentName: file.name,
  });
  const completion = prepared.completion.then(pdf =>
    finishSourceFile({ pdf, text: pdf.text }, file, descriptor, hash)
  );
  void completion.catch(() => undefined);
  return { completion };
};

const finishSourceFile = (
  material: ProjectSourceMaterial,
  file: SourceUpload['files'][number],
  descriptor: SourceDescriptor,
  hash: string
) => {
  descriptor.hash = hash;
  if (!material.text.trim()) {
    if (material.pdf)
      descriptor.preparedPdfText = {
        ...material.pdf,
        failedPages: material.pdf.transcription?.failedPages ?? material.pdf.failedPages ?? [],
        blankPages: material.pdf.transcription?.blankPages ?? material.pdf.blankPages ?? [],
      };
    throw new SourceHasNoTextError();
  }
  const outline =
    material.pdf?.outline ??
    (descriptor.kind === 'markdown' ? parseMarkdownOutline(material.text, descriptor.id) : []);
  const index = material.pdf
    ? buildPdfTextIndex(material.text, hash, descriptor.name, material.pdf.pages, file.id)
    : buildTextSourceIndex(material.text, {
        hash,
        id: descriptor.id,
        name: descriptor.name,
        outline,
      });
  if (material.pdf?.pageCount !== undefined) index.pageCount = material.pdf.pageCount;
  return {
    ...descriptor,
    hash,
    ...(material.pdf
      ? {
          preparedPdfText: {
            ...material.pdf,
            failedPages: material.pdf.transcription?.failedPages ?? material.pdf.failedPages ?? [],
            blankPages: material.pdf.transcription?.blankPages ?? material.pdf.blankPages ?? [],
          },
        }
      : {}),
    documentIndex: index,
    status: 'ready',
    outline,
    outlineOrigin: material.pdf?.outlineOrigin ?? (outline.length ? 'deterministic' : 'none'),
  };
};

const findPreparedUploadPdf = (
  snapshots: readonly (ProjectSnapshot | null | undefined)[],
  sourceId: string,
  hash: string
) => {
  for (const snapshot of snapshots) {
    const pdf = readPreparedProjectPdfText(snapshot?.source, sourceId, hash);
    if (pdf) return { pdf, source: snapshot?.source };
  }
  return undefined;
};

/** Prepares uploaded files sequentially; only indexes and named outcomes survive each file. */
export const prepareSourceCollection = async ({
  snapshot,
  upload,
  context,
  storedSnapshot,
  preparedSnapshot,
}: {
  storedSnapshot?: ProjectSnapshot | null;
  preparedSnapshot?: ProjectSnapshot;
  snapshot: ProjectSnapshot;
  upload: SourceUpload;
  context: SourcePreparationContext;
}): Promise<{ snapshot: ProjectSnapshot; failures: SourcePreparationFailure[] }> => {
  snapshot = restoreStoredPreparedPdfText(snapshot, storedSnapshot);
  if (!isRecord(snapshot.source) || !Array.isArray(snapshot.source.sources))
    throw new ProjectImportInputError('Metadati delle fonti non validi.');
  const submittedSources = snapshot.source.sources;
  const source = snapshot.source;
  const descriptors: SourceDescriptor[] = submittedSources.map((descriptor: unknown) => {
    if (
      !isRecord(descriptor) ||
      typeof descriptor.id !== 'string' ||
      typeof descriptor.name !== 'string' ||
      typeof descriptor.hash !== 'string' ||
      typeof descriptor.status !== 'string'
    )
      throw new ProjectImportInputError('Metadati delle fonti non validi.');
    return {
      ...descriptor,
      id: descriptor.id,
      name: descriptor.name,
      hash: descriptor.hash,
      status: descriptor.status,
      documentIndex: descriptor.documentIndex as PdfTextIndex | undefined,
    };
  });
  const byId = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]));
  const totalBytes = upload.files.reduce((total, file) => total + file.byteSize, 0);
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes ||
    totalBytes + (upload.offset ?? 0) !== (await stat(upload.path)).size
  )
    throw new ProjectImportInputError('Dimensione delle fonti non valida.');
  const handle = await open(upload.path, 'r');
  let buffer = Buffer.alloc(Math.min(totalBytes, COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes));
  const failures: SourcePreparationFailure[] = [];
  const completions: Promise<void>[] = [];
  const checkpoint = () =>
    context.checkpointPreparedSources?.({
      ...snapshot,
      source: { ...source, sources: descriptors },
    });
  const markFailure = (descriptor: SourceDescriptor, error: unknown) => {
    context.signal.throwIfAborted();
    if (error instanceof PdfScannedPageLimitError) throw error;
    descriptor.status = 'error';
    const reason = failureReason(error);
    descriptor.errorReason = reason;
    descriptor.errorMessage = SOURCE_PREPARATION_FAILURE_MESSAGES[reason];
    delete descriptor.documentIndex;
    const prepared = descriptor.preparedPdfText;
    const failedPages =
      isRecord(prepared) && Array.isArray(prepared.failedPages)
        ? (prepared.failedPages as number[])
        : [];
    failures.push({
      name: descriptor.name,
      reason,
      ...(failedPages.length ? { failedPages } : {}),
    });
    checkpoint();
    console.warn('[Sources] Per-file preparation failed.', { name: descriptor.name, reason });
  };
  let offset = upload.offset ?? 0;
  const uploadedIds = new Set<string>();
  try {
    for (const [position, file] of upload.files.entries()) {
      context.signal.throwIfAborted();
      const descriptor = byId.get(file.id);
      if (
        !descriptor ||
        !isRecord(descriptor.file) ||
        descriptor.file.name !== file.name ||
        descriptor.file.mimeType !== file.mimeType ||
        !isSafeZipEntryPath(file.name) ||
        uploadedIds.has(file.id) ||
        !Number.isSafeInteger(file.byteSize) ||
        file.byteSize < 0 ||
        file.byteSize > COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes
      )
        throw new ProjectImportInputError('File sorgente non valido.');
      uploadedIds.add(file.id);
      context.reportProgress({
        step: 'extraction',
        documentName: descriptor.name,
        completed: position,
        total: upload.files.length,
      });
      const bytes = buffer.subarray(0, file.byteSize);
      await readFileSegment(handle, bytes, offset);
      offset += file.byteSize;
      const hash = createHash('sha256').update(bytes).digest('hex');
      const cached = findPreparedUploadPdf([storedSnapshot, preparedSnapshot], file.id, hash);
      const preparedPdf = cached?.pdf;
      delete descriptor.preparedPdfText;
      delete descriptor.documentIndex;
      delete descriptor.errorMessage;
      delete descriptor.errorReason;
      try {
        if (preparedPdf)
          context.pdfTranscriptionPool?.allocateScannedPages(
            countRetainedScannedPages(cached?.source, { sources: [{ id: file.id }] }, [])
          );
        const preparation = preparedPdf
          ? {
              completion: Promise.resolve(
                finishSourceFile(
                  { pdf: preparedPdf, text: preparedPdf.text },
                  file,
                  descriptor,
                  hash
                )
              ),
            }
          : await prepareSourceFile(bytes, file, descriptor, context);
        const completion = preparation.completion
          .then(prepared => {
            Object.assign(descriptor, prepared);
            checkpoint();
          })
          .catch(error => markFailure(descriptor, error));
        void completion.catch(() => undefined);
        completions.push(completion);
      } catch (error) {
        markFailure(descriptor, error);
      }
      collectReleasedSourceMemory();
      const transcription = context.pdfTranscriptionPool?.progress;
      if (!transcription || transcription.completed === transcription.total)
        context.reportProgress({
          step: 'extraction',
          documentName: descriptor.name,
          completed: position + 1,
          total: upload.files.length,
          failures: failures.map(failure => ({ documentName: failure.name })),
        });
    }
    buffer = Buffer.alloc(0);
    await Promise.all(completions);
    failures.sort(
      (left, right) =>
        upload.files.findIndex(file => file.name === left.name) -
        upload.files.findIndex(file => file.name === right.name)
    );
  } finally {
    await handle.close();
  }
  if (descriptors.every(descriptor => descriptor.status === 'error'))
    throw new SourcePreparationUnusableError(failures);
  return {
    failures,
    snapshot: {
      ...snapshot,
      source: { ...source, sources: descriptors },
      documentIndex: combineCourseSourceIndexes(descriptors),
    },
  };
};
