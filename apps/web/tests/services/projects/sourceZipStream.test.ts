import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { expect, test, vi } from 'vitest';
import { readZipDirectory, readZipEntryStream } from '../../../services/projects/zipDirectory';

const fixture = async () => {
  const zip = new JSZip();
  zip.file('notes/lesson.txt', '∀ n ∈ ℕ: n + 0 = n');
  return new File(
    [await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })],
    'course.zip'
  );
};

test('streams one ZIP member with integrity checks without reading the archive as a buffer', async () => {
  const file = await fixture();
  const wholeRead = vi.spyOn(file, 'arrayBuffer');
  const entries = await readZipDirectory(file);
  const entry = entries.find(candidate => candidate.name === 'notes/lesson.txt');
  assert(entry);
  const stream = await readZipEntryStream(file, entry);
  expect(await new Response(stream).text()).toBe('∀ n ∈ ℕ: n + 0 = n');
  expect(wholeRead).not.toHaveBeenCalled();
});

test('rejects corrupt member bytes rather than publishing partial text', async () => {
  const zip = new JSZip();
  zip.file('lesson.txt', 'synthetic source');
  const bytes = new Uint8Array(
    await zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
  );
  bytes[30 + 'lesson.txt'.length] ^= 1;
  const file = new File([bytes], 'corrupt.zip');
  const [entry] = await readZipDirectory(file);
  await expect(new Response(await readZipEntryStream(file, entry)).arrayBuffer()).rejects.toThrow();
});

test('enforces actual expanded bytes even when the directory declares a smaller size', async () => {
  const file = await fixture();
  const entries = await readZipDirectory(file);
  const entry = entries.find(candidate => candidate.name === 'notes/lesson.txt');
  assert(entry);
  await expect(
    new Response(await readZipEntryStream(file, { ...entry, byteSize: 1 })).arrayBuffer()
  ).rejects.toThrow();
});
