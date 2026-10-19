import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import { translateUiMessage } from '../../i18n/uiMessages';
import type { ProjectSourceWarning } from '../../types';
import { isZipFileData } from './projectSource';

const ZIP_END_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const ZIP_DIRECTORY_HEADER_BYTES = 46;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_FIELD = 0xffff_ffff;
class ZipEntryCountError extends Error {}
const readView = async (file: File, start: number, size: number) =>
  new DataView(await file.slice(start, start + size).arrayBuffer());
const readZipNumber = (view: DataView, offset: number) => {
  const value = Number(view.getBigUint64(offset, true));
  if (!Number.isSafeInteger(value)) throw new Error('Invalid ZIP size');
  return value;
};

const readZipDirectoryLocation = async (file: File) => {
  const tailStart = Math.max(0, file.size - ZIP_END_BYTES - ZIP_MAX_COMMENT_BYTES);
  const tail = await readView(file, tailStart, file.size - tailStart);
  let end = tail.byteLength - ZIP_END_BYTES;
  while (
    end >= 0 &&
    (tail.getUint32(end, true) !== ZIP_END_SIGNATURE ||
      end + ZIP_END_BYTES + tail.getUint16(end + 20, true) !== tail.byteLength)
  )
    end -= 1;
  if (end < 0) throw new Error('Invalid ZIP directory');
  let count = tail.getUint16(end + 10, true);
  let size = tail.getUint32(end + 12, true);
  let offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || size === ZIP64_FIELD || offset === ZIP64_FIELD) {
    const locator = await readView(file, tailStart + end - 20, 20);
    if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE)
      throw new Error('Invalid ZIP64 locator');
    const directory = await readView(file, readZipNumber(locator, 8), 56);
    if (directory.getUint32(0, true) !== ZIP64_END_SIGNATURE)
      throw new Error('Invalid ZIP64 directory');
    count = readZipNumber(directory, 32);
    size = readZipNumber(directory, 40);
    offset = readZipNumber(directory, 48);
  }
  if (size < count * ZIP_DIRECTORY_HEADER_BYTES || offset > tailStart + end - size)
    throw new Error('Invalid ZIP directory size');
  return { count, offset, size };
};

const createDirectoryReader = (file: File, directory: { offset: number; size: number }) => {
  let buffer = new DataView(new ArrayBuffer(0));
  let bufferStart = 0;
  return async (offset: number, size: number): Promise<DataView> => {
    if (offset + size > directory.size) throw new Error('Invalid ZIP entry size');
    if (offset < bufferStart || offset + size > bufferStart + buffer.byteLength) {
      bufferStart = offset;
      // Reuse the per-file memory budget without imposing a new archive admission limit.
      buffer = await readView(
        file,
        directory.offset + offset,
        Math.min(directory.size - offset, COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes)
      );
    }
    return new DataView(buffer.buffer, buffer.byteOffset + offset - bufferStart, size);
  };
};

const readZipDirectoryEntry = async (
  readDirectory: ReturnType<typeof createDirectoryReader>,
  offset: number
) => {
  const header = await readDirectory(offset, ZIP_DIRECTORY_HEADER_BYTES);
  if (header.getUint32(0, true) !== ZIP_DIRECTORY_SIGNATURE) throw new Error('Invalid ZIP entry');
  let byteSize = header.getUint32(24, true);
  const nameBytes = header.getUint16(28, true),
    extraBytes = header.getUint16(30, true),
    commentBytes = header.getUint16(32, true);
  const recordBytes = ZIP_DIRECTORY_HEADER_BYTES + nameBytes + extraBytes + commentBytes;
  const record = await readDirectory(offset, recordBytes);
  const name = new TextDecoder().decode(
    new Uint8Array(record.buffer, record.byteOffset + ZIP_DIRECTORY_HEADER_BYTES, nameBytes)
  );
  if (byteSize === ZIP64_FIELD) {
    const extra = new DataView(
      record.buffer,
      record.byteOffset + ZIP_DIRECTORY_HEADER_BYTES + nameBytes,
      extraBytes
    );
    let cursor = 0;
    while (cursor + 4 <= extra.byteLength && extra.getUint16(cursor, true) !== 1)
      cursor += 4 + extra.getUint16(cursor + 2, true);
    if (
      cursor + 12 > extra.byteLength ||
      extra.getUint16(cursor + 2, true) < 8 ||
      cursor + 4 + extra.getUint16(cursor + 2, true) > extra.byteLength
    )
      throw new Error('Invalid ZIP64 entry');
    byteSize = readZipNumber(extra, cursor + 4);
  }
  return {
    entry: { name, byteSize },
    nextOffset: offset + recordBytes,
  };
};

/** Reads only metadata, keeping memory independent of the compressed archive size. */
export const readSourceZipDirectory = async (
  file: File
): Promise<Array<{ name: string; byteSize: number }>> => {
  const directory = await readZipDirectoryLocation(file);
  if (directory.count > COURSE_SOURCE_UPLOAD_LIMITS.maxArchiveEntries)
    throw new ZipEntryCountError();
  const readDirectory = createDirectoryReader(file, directory);
  const entries = [];
  let offset = 0;
  for (let index = 0; index < directory.count; index += 1) {
    const next = await readZipDirectoryEntry(readDirectory, offset);
    entries.push(next.entry);
    offset = next.nextOffset;
  }
  return entries;
};

const inspectSourceFile = async (
  file: File
): Promise<{ accepted: boolean; warnings: ProjectSourceWarning[] }> => {
  if (!isZipFileData({ name: file.name, mimeType: file.type }))
    return file.size > COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes
      ? {
          accepted: false,
          warnings: [
            { name: file.name, message: translateUiMessage('Supera il limite di 32 MB per file.') },
          ],
        }
      : { accepted: true, warnings: [] };
  if (file.size > COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes)
    return {
      accepted: false,
      warnings: [
        { name: file.name, message: translateUiMessage('L’archivio supera il limite di 1 GB.') },
      ],
    };
  try {
    const entries = await readSourceZipDirectory(file);
    const invalidEntries = entries.filter(
      entry => entry.byteSize > COURSE_SOURCE_UPLOAD_LIMITS.maxArchiveEntryBytes
    );
    if (invalidEntries.length)
      return {
        accepted: false,
        warnings: invalidEntries.map(entry => ({
          name: entry.name,
          message: translateUiMessage('Supera il limite di 256 MB per file nell’archivio.'),
        })),
      };
    if (
      entries.reduce((bytes, entry) => bytes + entry.byteSize, 0) >
      COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes
    )
      return {
        accepted: false,
        warnings: [
          {
            name: file.name,
            message: translateUiMessage('L’archivio espanso supera il limite di 1 GB.'),
          },
        ],
      };
    return {
      accepted: true,
      warnings: entries
        .filter(
          entry =>
            entry.name.toLowerCase().endsWith('.pdf') &&
            entry.byteSize > COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes
        )
        .map(entry => ({
          name: entry.name,
          message: translateUiMessage('Supera il limite di 32 MB per file.'),
        })),
    };
  } catch (error) {
    if (error instanceof ZipEntryCountError)
      return {
        accepted: false,
        warnings: [
          {
            name: file.name,
            message: translateUiMessage('L’archivio contiene più di 20.000 voci.'),
          },
        ],
      };
    return {
      accepted: false,
      warnings: [
        {
          name: file.name,
          message: translateUiMessage('La struttura dell’archivio ZIP non è leggibile.'),
        },
      ],
    };
  }
};

export const inspectSourceSelection = async (
  files: readonly File[]
): Promise<{ files: File[]; warnings: ProjectSourceWarning[] }> => {
  const accepted: File[] = [];
  const warnings: ProjectSourceWarning[] = [];
  for (const file of files) {
    const result = await inspectSourceFile(file);
    warnings.push(...result.warnings);
    if (result.accepted) accepted.push(file);
  }
  if (
    accepted.reduce((bytes, file) => bytes + file.size, 0) >
    COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes
  )
    return {
      files: [],
      warnings: [
        ...warnings,
        {
          name: 'Materiale selezionato',
          message: translateUiMessage('Supera il limite di 1 GB per caricamento.'),
        },
      ],
    };
  return { files: accepted, warnings };
};
