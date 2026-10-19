import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import JSZip from 'jszip';
import { expect, test } from 'vitest';
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
  const entries = await readSourceZipDirectory(file);
  expect(entries).toHaveLength(30);
  expect(entries.find(entry => entry.name === 'lesson-29.pdf')).toEqual({
    name: 'lesson-29.pdf',
    byteSize: 7,
  });
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
