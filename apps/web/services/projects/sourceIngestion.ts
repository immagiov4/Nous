import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import type { SourcePreparationProgress } from '@shared/sourcePreparation';
import { translateUiMessage } from '../../i18n/uiMessages';
import type { ProjectSnapshot, ProjectSourceWarning, ProjectWriteOptions } from '../../types';
import {
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
  getCourseSourceDescriptors,
  getProjectSourceWarnings,
  mergeCourseSourceDescriptors,
  sortSourceFiles,
} from './courseSources';
import { type ProjectSaveResult, ProjectStorageError } from './projectRepository';
import { detectSourceFileKind, isZipFileData, normalizeSourceFileMimeType } from './projectSource';
import { getSourceFileExclusion } from './sourceFileSelection';
import { readZipDirectory, readZipEntryStream, ZIP_DEFLATE_METHOD } from './zipDirectory';

interface SourceDestination {
  snapshot: ProjectSnapshot;
  options?: ProjectWriteOptions;
}
export interface SourceTransferFile {
  file: File;
  sourceId: string;
}
type ProgressOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: SourcePreparationProgress) => void;
};
export interface SourceIngestionTransport {
  publish: (
    destination: SourceDestination,
    files: readonly SourceTransferFile[],
    options: ProgressOptions
  ) => Promise<ProjectSaveResult>;
}

const fileMimeType = (file: Pick<File, 'name' | 'type'>) =>
  normalizeSourceFileMimeType(
    file.name,
    file.type,
    detectSourceFileKind({ name: file.name, mimeType: file.type })
  ) || 'application/octet-stream';
const normalizeSourceFile = (file: File) => {
  const type = fileMimeType(file);
  return file.type === type
    ? file
    : new File([file], file.name, { type, lastModified: file.lastModified });
};

const canExpandZip = (needsDecompression: boolean): boolean => {
  if (typeof TransformStream !== 'function') return false;
  if (!needsDecompression) return true;
  try {
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
};

/** Owns temporary browser files; collection members never accumulate in a JavaScript byte array. */
class BrowserSourceCollection {
  readonly files: File[] = [];
  readonly failures: ProjectSourceWarning[] = [];
  private readonly paths = new Set<string>();
  private readonly stagingName = `nous-source-staging-${crypto.randomUUID()}`;
  private root?: FileSystemDirectoryHandle;
  private directory?: FileSystemDirectoryHandle;
  private expandedBytes = 0;
  constructor(private readonly options: ProgressOptions) {}

  private admit(name: string, bytes: number, archiveMember = false): boolean {
    if (this.paths.has(name)) {
      const message = translateUiMessage('Il percorso del file è duplicato: {name}.', { name });
      throw new ProjectStorageError(message, 'source-preparation-failed', {
        sourceWarnings: [...this.failures, { name, message }],
      });
    }
    this.paths.add(name);
    this.expandedBytes += bytes;
    if (this.expandedBytes > COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes)
      throw new ProjectStorageError(
        translateUiMessage('Supera il limite di 1 GB per caricamento.'),
        'source-preparation-failed',
        {
          sourceWarnings: [
            ...this.failures,
            { name, message: translateUiMessage('Supera il limite di 1 GB per caricamento.') },
          ],
        }
      );
    const exclusion = getSourceFileExclusion({ name, byteSize: bytes }, archiveMember);
    if (!exclusion) return true;
    this.failures.push(exclusion);
    return false;
  }

  private async stage(stream: ReadableStream<Uint8Array>, name: string): Promise<File> {
    if (typeof navigator.storage?.getDirectory !== 'function') return this.stageBlob(stream, name);
    if (!this.directory) {
      this.root = await navigator.storage.getDirectory();
      this.directory = await this.root.getDirectoryHandle(this.stagingName, { create: true });
    }
    const handle = await this.directory.getFileHandle(String(this.files.length), { create: true });
    if (typeof handle.createWritable !== 'function') return this.stageBlob(stream, name);
    await stream.pipeTo(await handle.createWritable(), { signal: this.options.signal });
    return new File([await handle.getFile()], name, { type: fileMimeType({ name, type: '' }) });
  }

  private async stageBlob(stream: ReadableStream<Uint8Array>, name: string): Promise<File> {
    // Member size and CRC are enforced by readZipEntryStream; Blob storage avoids a JS chunk array.
    const body = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
      signal: this.options.signal,
    });
    return new File([await new Response(body).blob()], name, {
      type: fileMimeType({ name, type: '' }),
    });
  }

  private async expandZip(input: File): Promise<void> {
    if (input.size > COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes)
      throw new ProjectStorageError(
        translateUiMessage('L’archivio supera il limite di 1 GB.'),
        'source-preparation-failed'
      );
    const entries = await readZipDirectory(input);
    if (!canExpandZip(entries.some(entry => entry.compression === ZIP_DEFLATE_METHOD))) {
      const message = translateUiMessage(
        'Questo browser non può espandere lo ZIP. Estrai l’archivio e aggiungi i file separatamente.'
      );
      throw new ProjectStorageError(message, 'source-preparation-failed', {
        sourceWarnings: [...this.failures, { name: input.name, message }],
      });
    }
    for (const [position, entry] of entries.entries()) {
      this.options.signal?.throwIfAborted();
      if (entry.name.endsWith('/')) continue;
      this.options.onProgress?.({
        step: 'expansion',
        documentName: entry.name,
        completed: position,
        total: entries.length,
      });
      if (!this.admit(entry.name, entry.byteSize, true)) continue;
      this.files.push(await this.stage(await readZipEntryStream(input, entry), entry.name));
    }
  }

  async collect(input: File): Promise<void> {
    this.options.signal?.throwIfAborted();
    if (isZipFileData({ name: input.name, mimeType: input.type })) return this.expandZip(input);
    if (this.admit(input.name, input.size)) this.files.push(normalizeSourceFile(input));
  }

  async dispose(): Promise<void> {
    if (this.root && this.directory)
      await this.root.removeEntry(this.stagingName, { recursive: true });
  }
}

/** Binds the transport seam once; callers use only the resulting ingestSources interface. */
export const createSourceIngestion = (transport: SourceIngestionTransport) =>
  async function ingestSources({
    inputs,
    destination,
    signal,
    onProgress,
  }: { inputs: readonly File[]; destination: SourceDestination } & ProgressOptions) {
    const collection = new BrowserSourceCollection({ signal, onProgress });
    try {
      for (const input of sortSourceFiles(inputs)) await collection.collect(input);
      if (!collection.files.length)
        throw new ProjectStorageError(
          translateUiMessage('Nessuna delle fonti selezionate può essere caricata.'),
          'source-preparation-failed',
          { sourceWarnings: collection.failures }
        );
      const filesByName = new Map(collection.files.map(file => [file.name, file]));
      const descriptors = buildCourseSourceDescriptors(
        collection.files.map(file => ({ name: file.name, mimeType: file.type, data: '' }))
      );
      for (const descriptor of descriptors) delete descriptor.documentIndex;
      const retained = getCourseSourceDescriptors(destination.snapshot.source).filter(
        descriptor => descriptor.ref || filesByName.has(descriptor.file.name)
      );
      const source = createProjectSourceFromDescriptors(
        mergeCourseSourceDescriptors(retained, descriptors)
      );
      source.preparationWarnings = collection.failures;
      const snapshot = {
        ...destination.snapshot,
        sourceKind: 'document' as const,
        source,
        documentIndex: null,
      };
      const files = (source.sources ?? [])
        .filter(descriptor => !descriptor.ref)
        .map(descriptor => {
          const file = filesByName.get(descriptor.file.name);
          if (!file) throw new Error('Prepared source is missing');
          return { file, sourceId: descriptor.id };
        });
      const result = await transport.publish({ ...destination, snapshot }, files, {
        signal,
        onProgress,
      });
      return {
        sourceSet: result.snapshot.source,
        failures: result.snapshot.source
          ? getProjectSourceWarnings(result.snapshot.source)
          : collection.failures,
        result,
      };
    } catch (error) {
      if (signal?.aborted || error instanceof ProjectStorageError) throw error;
      console.warn('[Sources] Browser preparation failed.', error);
      throw new ProjectStorageError(
        translateUiMessage('Non è stato possibile preparare le fonti.'),
        'source-preparation-failed',
        { sourceWarnings: collection.failures }
      );
    } finally {
      await collection
        .dispose()
        .catch(error => console.warn('[Sources] Browser staging cleanup failed.', error));
    }
  };
