import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import { isSafeZipEntryPath, updateZipCrc32 } from '@shared/zipSafety';

const ZIP_END_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const ZIP_DIRECTORY_HEADER_BYTES = 46;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_FIELD = 0xffff_ffff;
export class ZipEntryCountError extends Error {}
const readView = async (file: Blob, start: number, size: number) =>
  new DataView(await file.slice(start, start + size).arrayBuffer());
const readZipNumber = (view: DataView, offset: number) => {
  const value = Number(view.getBigUint64(offset, true));
  if (!Number.isSafeInteger(value)) throw new Error('Invalid ZIP size');
  return value;
};

const readZipDirectoryLocation = async (file: Blob) => {
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

const createDirectoryReader = (file: Blob, directory: { offset: number; size: number }) => {
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

const readZip64Fields = (extra: DataView) => {
  let cursor = 0;
  while (cursor + 4 <= extra.byteLength && extra.getUint16(cursor, true) !== 1)
    cursor += 4 + extra.getUint16(cursor + 2, true);
  if (cursor + 4 > extra.byteLength) throw new Error('Invalid ZIP64 entry');
  const fieldEnd = cursor + 4 + extra.getUint16(cursor + 2, true);
  if (fieldEnd > extra.byteLength) throw new Error('Invalid ZIP64 entry');
  cursor += 4;
  return () => {
    if (cursor + 8 > fieldEnd) throw new Error('Invalid ZIP64 entry');
    const value = readZipNumber(extra, cursor);
    cursor += 8;
    return value;
  };
};

const readZipDirectoryEntry = async (
  readDirectory: ReturnType<typeof createDirectoryReader>,
  offset: number,
  includeRecords: boolean
) => {
  const header = await readDirectory(offset, ZIP_DIRECTORY_HEADER_BYTES);
  if (header.getUint32(0, true) !== ZIP_DIRECTORY_SIGNATURE) throw new Error('Invalid ZIP entry');
  let byteSize = header.getUint32(24, true);
  let compressedSize = header.getUint32(20, true);
  let localHeaderOffset = header.getUint32(42, true);
  const nameBytes = header.getUint16(28, true),
    extraBytes = header.getUint16(30, true),
    commentBytes = header.getUint16(32, true);
  const recordBytes = ZIP_DIRECTORY_HEADER_BYTES + nameBytes + extraBytes + commentBytes;
  const record = await readDirectory(offset, recordBytes);
  const name = new TextDecoder().decode(
    new Uint8Array(record.buffer, record.byteOffset + ZIP_DIRECTORY_HEADER_BYTES, nameBytes)
  );
  if ([byteSize, compressedSize, localHeaderOffset].includes(ZIP64_FIELD)) {
    const extra = new DataView(
      record.buffer,
      record.byteOffset + ZIP_DIRECTORY_HEADER_BYTES + nameBytes,
      extraBytes
    );
    const readField = readZip64Fields(extra);
    if (byteSize === ZIP64_FIELD) byteSize = readField();
    if (compressedSize === ZIP64_FIELD) compressedSize = readField();
    if (localHeaderOffset === ZIP64_FIELD) localHeaderOffset = readField();
  }
  return {
    entry: {
      name,
      byteSize,
      compressedSize,
      localHeaderOffset,
      flags: header.getUint16(8, true),
      compression: header.getUint16(10, true),
      crc32: header.getUint32(16, true),
      unixMode: header.getUint32(38, true) >>> 16,
      record: includeRecords
        ? new Uint8Array(record.buffer, record.byteOffset, record.byteLength).slice()
        : undefined,
    },
    nextOffset: offset + recordBytes,
  };
};

/** Reads only metadata, keeping memory independent of the compressed archive size. */
export const readZipDirectory = async (
  file: Blob,
  {
    includeRecords = false,
    maxEntries = COURSE_SOURCE_UPLOAD_LIMITS.maxArchiveEntries,
  }: { includeRecords?: boolean; maxEntries?: number } = {}
) => {
  const directory = await readZipDirectoryLocation(file);
  if (directory.count > maxEntries) throw new ZipEntryCountError();
  const readDirectory = createDirectoryReader(file, directory);
  const entries = [];
  let offset = 0;
  for (let index = 0; index < directory.count; index += 1) {
    const next = await readZipDirectoryEntry(readDirectory, offset, includeRecords);
    entries.push(next.entry);
    offset = next.nextOffset;
  }
  return entries;
};

export const readSourceZipDirectory = async (file: Blob) =>
  (await readZipDirectory(file)).map(({ name, byteSize }) => ({ name, byteSize }));

/** Repackages one compressed member for the existing manifest/CRC validator. */
export const readZipEntryArchive = async (
  file: Blob,
  entry: Awaited<ReturnType<typeof readZipDirectory>>[number]
): Promise<Blob> => {
  if (!entry.record) throw new Error('ZIP directory record is required');
  const header = await readView(file, entry.localHeaderOffset, ZIP_LOCAL_HEADER_BYTES);
  if (header.getUint32(0, true) !== ZIP_LOCAL_HEADER_SIGNATURE)
    throw new Error('Invalid ZIP entry');
  const localBytes =
    ZIP_LOCAL_HEADER_BYTES +
    header.getUint16(26, true) +
    header.getUint16(28, true) +
    entry.compressedSize;
  if (entry.localHeaderOffset + localBytes > file.size) throw new Error('Invalid ZIP entry size');
  const local = file.slice(entry.localHeaderOffset, entry.localHeaderOffset + localBytes);
  const directory = new DataView(entry.record.buffer);
  directory.setUint32(20, entry.compressedSize, true);
  directory.setUint32(24, entry.byteSize, true);
  directory.setUint32(42, 0, true);
  const end = new Uint8Array(ZIP_END_BYTES);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, ZIP_END_SIGNATURE, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, entry.record.byteLength, true);
  endView.setUint32(16, localBytes, true);
  return new Blob([local, entry.record, end]);
};

/** Streams a single admitted member; expansion never buffers the archive or trusts declared size. */
export const readZipEntryStream = async (
  file: Blob,
  entry: Awaited<ReturnType<typeof readZipDirectory>>[number]
): Promise<ReadableStream<Uint8Array>> => {
  const zipSymlinkMode = 0xa000;
  const zipFileTypeMask = 0xf000;
  const zipDeflateMethod = 8;
  if (
    !isSafeZipEntryPath(entry.name) ||
    entry.flags & 1 ||
    (entry.unixMode & zipFileTypeMask) === zipSymlinkMode ||
    entry.byteSize > COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes
  )
    throw new Error('Invalid ZIP member');
  const header = await readView(file, entry.localHeaderOffset, ZIP_LOCAL_HEADER_BYTES);
  if (
    header.getUint32(0, true) !== ZIP_LOCAL_HEADER_SIGNATURE ||
    header.getUint16(6, true) & 1 ||
    header.getUint16(8, true) !== entry.compression
  )
    throw new Error('Invalid ZIP member header');
  const nameBytes = header.getUint16(26, true);
  const name = new TextDecoder().decode(
    await file
      .slice(
        entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES,
        entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES + nameBytes
      )
      .arrayBuffer()
  );
  const start =
    entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES + nameBytes + header.getUint16(28, true);
  if (name !== entry.name || start + entry.compressedSize > file.size)
    throw new Error('Invalid ZIP member size');
  let stream = file.slice(start, start + entry.compressedSize).stream();
  if (entry.compression === zipDeflateMethod)
    stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
  else if (entry.compression !== 0) throw new Error('Unsupported ZIP compression');
  let bytes = 0;
  let crc = 0xffff_ffff;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > entry.byteSize || bytes > COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes)
          throw new Error('Invalid ZIP member size');
        crc = updateZipCrc32(crc, chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (bytes !== entry.byteSize || (crc ^ 0xffff_ffff) >>> 0 !== entry.crc32)
          throw new Error('Invalid ZIP member integrity');
      },
    })
  );
};
