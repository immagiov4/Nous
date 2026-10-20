import type { Readable } from 'node:stream';
import { type Entry, open, type ZipFile } from 'yauzl';

const readDirectoryEntries = (
  archive: ZipFile,
  maxEntries: number,
  deadlineAt: number
): Promise<Entry[]> =>
  new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      archive.off('entry', onEntry);
      archive.off('error', fail);
      archive.off('end', finish);
    };
    const fail = (error: Error) => {
      cleanup();
      archive.close();
      reject(error);
    };
    const finish = () => {
      cleanup();
      resolve(entries);
    };
    const onEntry = (entry: Entry) => {
      if (entries.length >= maxEntries) {
        fail(new Error('ZIP entry limit exceeded'));
        return;
      }
      entries.push(entry);
      archive.readEntry();
    };
    const timer = setTimeout(
      () => fail(new Error('ZIP directory deadline exceeded')),
      Math.max(1, deadlineAt - Date.now())
    );
    archive.on('entry', onEntry).once('error', fail).once('end', finish);
    archive.readEntry();
  });

/** Keeps only central-directory metadata in memory; entry bytes are read on demand. */
export const openFileSourceArchive = async (
  path: string,
  maxEntries: number,
  deadlineAt: number
) => {
  const archive = await new Promise<ZipFile>((resolve, reject) =>
    open(path, { autoClose: false, lazyEntries: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('Unreadable ZIP'));
      else resolve(zip);
    })
  );
  if (archive.entryCount > maxEntries) {
    archive.close();
    throw new Error('ZIP entry limit exceeded');
  }
  const entries = await readDirectoryEntries(archive, maxEntries, deadlineAt);
  const entriesByPath = new Map(
    entries.map(entry => [entry.fileName.replaceAll('\\', '/').replace(/\/$/u, ''), entry])
  );
  return {
    close: () => archive.close(),
    entries: entries.map(entry => ({
      decompressed: { uncompressedSize: entry.uncompressedSize },
      dir: entry.fileName.endsWith('/'),
      fileNameStr: entry.fileName,
    })),
    read: async (path: string, deadlineAt: number): Promise<Uint8Array> => {
      const entry = entriesByPath.get(path);
      if (!entry) throw new Error('Missing ZIP entry');
      const stream = await new Promise<Readable>((resolve, reject) =>
        archive.openReadStream(entry, (error, stream) => {
          if (error || !stream) reject(error ?? new Error('Unreadable ZIP entry'));
          else resolve(stream);
        })
      );
      const timer = setTimeout(
        () => stream.destroy(new Error('ZIP entry deadline exceeded')),
        Math.max(1, deadlineAt - Date.now())
      );
      const bytes = new Uint8Array(entry.uncompressedSize);
      let offset = 0;
      try {
        for await (const chunk of stream) {
          if (offset + chunk.length > bytes.length) throw new Error('ZIP entry size mismatch');
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (offset !== bytes.length) throw new Error('ZIP entry size mismatch');
        return bytes;
      } finally {
        clearTimeout(timer);
        stream.destroy();
      }
    },
  };
};
