import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import JSZip from 'jszip';
import { expect, test, vi } from 'vitest';
import {
  inspectSourceSelection,
  readSourceZipDirectory,
} from '../../../services/projects/sourceFileSelection';

test('preflights every lesson in a 30-PDF ZIP without extracting its contents', async () => {
  const zip = new JSZip();
  for (let index = 0; index < 30; index += 1) zip.file(`lesson-${index}.pdf`, `%PDF-${index}`);
  const file = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'course.zip', {
    type: 'application/zip',
  });
  const reads = vi.spyOn(file, 'slice');
  const entries = await readSourceZipDirectory(file);
  expect(entries).toHaveLength(30);
  expect(entries.find(entry => entry.name === 'lesson-29.pdf')).toEqual({
    name: 'lesson-29.pdf',
    byteSize: 7,
  });
  expect(reads.mock.calls).toHaveLength(2);
  reads.mockRestore();
  expect(await inspectSourceSelection([file])).toEqual({ files: [file], warnings: [] });
});

test('identifies each oversized separate file before transferring the remaining sources', async () => {
  const tooLarge = new File(
    [new Uint8Array(COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes + 1)],
    'large.pdf',
    { type: 'application/pdf' }
  );
  const valid = new File(['%PDF-valid'], 'valid.pdf', { type: 'application/pdf' });
  const result = await inspectSourceSelection([tooLarge, valid]);
  expect(result.files).toEqual([valid]);
  expect(result.warnings).toEqual([{ name: 'large.pdf', message: expect.any(String) }]);
});

test('names an oversized PDF inside a ZIP before the archive is uploaded', async () => {
  const zip = new JSZip();
  zip.file('notes/large.pdf', new Uint8Array(COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes + 1));
  const file = new File(
    [await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })],
    'course.zip',
    { type: 'application/zip' }
  );
  const result = await inspectSourceSelection([file]);
  expect(result.files).toEqual([file]);
  expect(result.warnings.map(warning => warning.name)).toEqual(['notes/large.pdf']);
});

test('rejects a damaged ZIP instead of treating it as an empty course', async () => {
  const file = new File(['PK malformed'], 'broken.zip', { type: 'application/zip' });
  expect(await inspectSourceSelection([file])).toEqual({
    files: [],
    warnings: [{ name: 'broken.zip', message: expect.any(String) }],
  });
});

test('rejects a central directory extending past its end record before reading it', async () => {
  const zip = new JSZip();
  zip.file('lesson.pdf', '%PDF-example');
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  const view = new DataView(bytes);
  view.setUint32(bytes.byteLength - 22 + 12, bytes.byteLength, true);
  const file = new File([bytes], 'invalid-size.zip');
  const reads = vi.spyOn(file, 'slice');
  await expect(readSourceZipDirectory(file)).rejects.toThrow('Invalid ZIP directory size');
  expect(reads.mock.calls).toHaveLength(1);
  reads.mockRestore();
});

test('reads a long-comment directory in bounded blocks without excluding its entries', async () => {
  const name = new TextEncoder().encode('lesson.pdf');
  const commentBytes = 65_535;
  const record = new Uint8Array(46 + name.byteLength + commentBytes);
  const header = new DataView(record.buffer);
  header.setUint32(0, 0x02014b50, true);
  header.setUint32(24, 7, true);
  header.setUint16(28, name.byteLength, true);
  header.setUint16(32, commentBytes, true);
  record.set(name, 46);
  const count = Math.floor(COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes / record.byteLength) + 1;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(10, count, true);
  endView.setUint32(12, count * record.byteLength, true);
  const file = new File([...Array.from({ length: count }, () => record), end], 'comments.zip');
  const reads = vi.spyOn(file, 'slice');
  const entries = await readSourceZipDirectory(file);
  expect(entries).toEqual(
    Array.from({ length: count }, () => ({ name: 'lesson.pdf', byteSize: 7 }))
  );
  expect(reads.mock.calls).toHaveLength(3);
  for (const [start = 0, stop = file.size] of reads.mock.calls)
    expect(stop - start).toBeLessThanOrEqual(COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes);
  reads.mockRestore();
});

test.each([
  false,
  true,
])('preserves ZIP64 sizes when only size is a sentinel: %s', async sizeOnly => {
  const zip = new JSZip();
  zip.file('lesson.pdf', '%PDF-example');
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }));
  const endOffset = bytes.byteLength - 22;
  const end = bytes.slice(endOffset);
  const endView = new DataView(end.buffer);
  const directoryOffset = endView.getUint32(16, true);
  const directory = bytes.slice(directoryOffset, endOffset);
  const header = new DataView(directory.buffer);
  const byteSize = header.getUint32(24, true);
  header.setUint32(24, 0xffff_ffff, true);
  header.setUint16(30, 12, true);
  const extra = new Uint8Array(12);
  const extraView = new DataView(extra.buffer);
  extraView.setUint16(0, 1, true);
  extraView.setUint16(2, 8, true);
  extraView.setBigUint64(4, BigInt(byteSize), true);
  const zip64EndOffset = endOffset + extra.byteLength;
  const zip64End = new Uint8Array(56);
  const zip64View = new DataView(zip64End.buffer);
  zip64View.setUint32(0, 0x06064b50, true);
  zip64View.setBigUint64(4, 44n, true);
  zip64View.setBigUint64(24, 1n, true);
  zip64View.setBigUint64(32, 1n, true);
  zip64View.setBigUint64(40, BigInt(directory.byteLength + extra.byteLength), true);
  zip64View.setBigUint64(48, BigInt(directoryOffset), true);
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, BigInt(zip64EndOffset), true);
  locatorView.setUint32(16, 1, true);
  if (!sizeOnly) {
    endView.setUint16(10, 0xffff, true);
    endView.setUint32(16, 0xffff_ffff, true);
  }
  endView.setUint32(12, 0xffff_ffff, true);
  const file = new File(
    [bytes.subarray(0, directoryOffset), directory, extra, zip64End, locator, end],
    'zip64.zip'
  );
  expect(await readSourceZipDirectory(file)).toEqual([{ name: 'lesson.pdf', byteSize }]);
});

test('rejects a ZIP whose declared expanded total exceeds the existing safety envelope', async () => {
  const zip = new JSZip();
  for (let index = 0; index < 5; index += 1) zip.file(`file-${index}.txt`, 'data');
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  const view = new DataView(bytes);
  for (let offset = 0; offset + 46 <= view.byteLength; offset += 1)
    if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 250_000_000, true);
  const file = new File([bytes], 'expanded.zip', { type: 'application/zip' });
  const result = await inspectSourceSelection([file]);
  expect(result.files).toEqual([]);
  expect(result.warnings).toEqual([{ name: 'expanded.zip', message: expect.any(String) }]);
});

test('names nested archives and unsafe paths before any transfer', async () => {
  const zip = new JSZip();
  zip.file('notes/nested.zip', 'PK nested');
  zip.file('notes/lesson.txt', 'Usable text');
  zip.file('../outside.txt', 'unsafe');
  const file = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'course.zip', {
    type: 'application/zip',
  });
  const result = await inspectSourceSelection([file]);
  expect(result.files).toEqual([file]);
  expect(result.warnings.map(warning => warning.name)).toEqual([
    'notes/nested.zip',
    '../outside.txt',
  ]);
});
