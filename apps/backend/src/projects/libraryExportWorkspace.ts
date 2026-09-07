import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  LIBRARY_ARCHIVE_MANIFEST_PATH,
  type LibraryArchiveManifest,
} from '@shared/libraryExportContract';
import JSZip from 'jszip';

import type { LibraryExportProjectCheckpoint } from './libraryExportRunStore.js';

export interface LibraryExportArchiveFile {
  bytes: number;
  path: string;
  sha256: string;
}

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXPORT_ROOT_DIRECTORY = 'nous-library-exports';
const FINAL_ARCHIVE_NAME = 'library.nous-library.zip';

const hashFile = async (path: string, signal?: AbortSignal): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
};

export class LibraryExportWorkspace {
  constructor(
    private readonly root = process.env.LIBRARY_EXPORT_ROOT?.trim() ||
      join(tmpdir(), EXPORT_ROOT_DIRECTORY)
  ) {}

  async writeProjectArchive(
    runId: string,
    archivePath: string,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<LibraryExportArchiveFile> {
    const path = this.resolveArchivePath(runId, archivePath);
    const partialPath = `${path}.partial`;
    await mkdir(dirname(path), { recursive: true });
    await rm(partialPath, { force: true });
    await writeFile(partialPath, bytes, { flag: 'wx', mode: 0o600, signal });
    signal?.throwIfAborted();
    await rm(path, { force: true });
    await rename(partialPath, path);
    return { bytes: bytes.byteLength, path: archivePath, sha256: await hashFile(path, signal) };
  }

  async matchesProjectCheckpoint(
    runId: string,
    checkpoint: LibraryExportProjectCheckpoint,
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const path = this.resolveArchivePath(runId, checkpoint.archivePath);
      const metadata = await stat(path);
      return (
        metadata.size === checkpoint.archiveBytes &&
        (await hashFile(path, signal)) === checkpoint.archiveSha256
      );
    } catch {
      return false;
    }
  }

  async createLibraryArchive(
    runId: string,
    manifest: LibraryArchiveManifest,
    checkpoints: readonly LibraryExportProjectCheckpoint[],
    signal?: AbortSignal
  ): Promise<LibraryExportArchiveFile> {
    const path = this.resolveRunPath(runId, FINAL_ARCHIVE_NAME);
    const partialPath = `${path}.partial`;
    await mkdir(dirname(path), { recursive: true });
    await rm(partialPath, { force: true });

    const zip = new JSZip();
    for (const checkpoint of checkpoints) {
      zip.file(
        checkpoint.archivePath,
        createReadStream(this.resolveArchivePath(runId, checkpoint.archivePath), { signal }),
        { binary: true, compression: 'STORE' }
      );
    }
    zip.file(LIBRARY_ARCHIVE_MANIFEST_PATH, JSON.stringify(manifest), {
      compression: 'DEFLATE',
    });
    await pipeline(
      zip.generateNodeStream({
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
        streamFiles: true,
        type: 'nodebuffer',
      }) as Readable,
      createWriteStream(partialPath, { flags: 'wx', mode: 0o600, signal }),
      { signal }
    );
    signal?.throwIfAborted();
    await rm(path, { force: true });
    await rename(partialPath, path);
    const metadata = await stat(path);
    return { bytes: metadata.size, path, sha256: await hashFile(path, signal) };
  }

  async verifyLibraryArchive(
    runId: string,
    expected: Pick<LibraryExportArchiveFile, 'bytes' | 'sha256'>,
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const path = this.resolveRunPath(runId, FINAL_ARCHIVE_NAME);
      const metadata = await stat(path);
      return metadata.size === expected.bytes && (await hashFile(path, signal)) === expected.sha256;
    } catch {
      return false;
    }
  }

  getLibraryArchivePath(runId: string): string {
    return this.resolveRunPath(runId, FINAL_ARCHIVE_NAME);
  }

  async removeRun(runId: string): Promise<void> {
    await rm(this.resolveRunPath(runId), { force: true, recursive: true });
  }

  private resolveArchivePath(runId: string, archivePath: string): string {
    const segments = archivePath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('Library export archive path is invalid.');
    }
    return this.resolveRunPath(runId, ...segments);
  }

  private resolveRunPath(runId: string, ...segments: string[]): string {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error('Library export run id is invalid.');
    return join(this.root, runId, ...segments);
  }
}
