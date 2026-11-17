import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import JSZip from 'jszip';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createSourceIngestion,
  type SourceIngestionTransport,
} from '../../../services/projects/sourceIngestion';
import { AppState, type ProjectSnapshot } from '../../../types';

const snapshot: ProjectSnapshot = {
  id: 'course',
  version: '4.1',
  sourceKind: 'document',
  source: null,
  state: AppState.ASSESSMENT,
  learningPlan: null,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: null,
  createdAt: '',
  updatedAt: '',
  lastOpenedAt: '',
};

const stage = () => {
  const files = new Map<string, File>();
  const removed: string[] = [];
  const directory = {
    getFileHandle: async (name: string) => ({
      createWritable: async () => {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        return new WritableStream<Uint8Array>({
          write: chunk => {
            chunks.push(new Uint8Array(chunk));
          },
          close: () => {
            files.set(name, new File(chunks, name));
          },
        });
      },
      getFile: async () => files.get(name),
    }),
  };
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => directory,
        removeEntry: async (name: string) => {
          removed.push(name);
          files.clear();
        },
      }),
    },
  });
  return { removed };
};
afterEach(() => vi.unstubAllGlobals());

test('standalone files and ZIP members cross one file-only transport with the same source identities', async () => {
  const staging = stage();
  const sent: { names: string[]; texts: string[]; ids: string[] }[] = [];
  const ingestSources = createSourceIngestion({
    publish: async (destination, files, options) => {
      sent.push({
        names: files.map(file => file.file.name),
        texts: await Promise.all(files.map(file => file.file.text())),
        ids: files.map(file => file.sourceId),
      });
      options.onProgress?.({ step: 'upload', completed: 1, total: 1 });
      return {
        snapshot: destination.snapshot,
        meta: {
          id: 'course',
          title: 'Course',
          sourceKind: 'document',
          createdAt: '',
          updatedAt: '',
          lastOpenedAt: '',
          lessonCount: 0,
          completedCount: 0,
          exerciseCount: 0,
          completedExercises: 0,
          hasSourceFile: true,
          coverLabel: 'lesson.txt',
        },
      };
    },
  });
  const zip = new JSZip();
  const onProgress = vi.fn();
  zip.file('lesson.txt', '∀ n ∈ ℕ');
  const packed = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'course.zip', {
    type: 'application/zip',
  });
  await ingestSources({
    inputs: [new File(['∀ n ∈ ℕ'], 'lesson.txt', { type: 'text/plain' })],
    destination: { snapshot },
  });
  await ingestSources({ inputs: [packed], destination: { snapshot }, onProgress });
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEqual(sent[1]);
  expect(sent[0].names).toEqual(['lesson.txt']);
  expect(onProgress).toHaveBeenLastCalledWith(
    expect.objectContaining({
      documents: [{ id: sent[0].ids[0], name: 'lesson.txt', state: 'idle' }],
    })
  );
  expect(staging.removed).toHaveLength(1);
});

test('cleans staged members when the common transport fails', async () => {
  const staging = stage();
  const zip = new JSZip();
  zip.file('lesson.txt', 'synthetic source');
  const input = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'course.zip', {
    type: 'application/zip',
  });
  const ingestSources = createSourceIngestion({
    publish: async () => {
      throw new Error('network unavailable');
    },
  });
  await expect(ingestSources({ inputs: [input], destination: { snapshot } })).rejects.toMatchObject(
    { code: 'source-preparation-failed' }
  );
  expect(staging.removed).toHaveLength(1);
});

test('returns named server outcomes together with the prepared source set', async () => {
  const ingestSources = createSourceIngestion({
    publish: async destination => {
      const source = destination.snapshot.source;
      if (!source?.sources?.length) throw new Error('Missing pending sources');
      source.sources[0].status = 'error';
      source.sources[0].errorReason = 'parser-failed';
      source.sources[0].errorMessage = 'Could not read this source.';
      return {
        snapshot: destination.snapshot,
        meta: { id: snapshot.id } as import('../../../types').SavedProjectMeta,
      };
    },
  });
  const result = await ingestSources({
    inputs: [new File(['unreadable source'], 'lesson.pdf', { type: 'application/pdf' })],
    destination: { snapshot },
  });
  expect(result.failures).toEqual([
    { name: 'lesson.pdf', reason: 'parser-failed', message: 'Could not read this source.' },
  ]);
  expect(result.sourceSet?.sources?.[0].status).toBe('error');
});

test.each([
  'missing-storage',
  'missing-writable',
])('ZIP ingestion works with %s using bounded Blob files', async capability => {
  if (capability === 'missing-storage') vi.stubGlobal('navigator', {});
  else
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => ({ getFileHandle: async () => ({}) }),
          removeEntry: async () => {},
        }),
      },
    });
  const publish = vi.fn(
    async (
      destination: Parameters<SourceIngestionTransport['publish']>[0],
      files: Parameters<SourceIngestionTransport['publish']>[1]
    ) => {
      expect(files).toHaveLength(1);
      expect(await files[0].file.text()).toBe('fallback content');
      return {
        snapshot: destination.snapshot,
        meta: { id: 'course' } as import('../../../types').SavedProjectMeta,
      };
    }
  );
  const zip = new JSZip();
  zip.file('lesson.txt', 'fallback content');
  await createSourceIngestion({ publish })({
    inputs: [new File([await zip.generateAsync({ type: 'arraybuffer' })], 'course.zip')],
    destination: { snapshot },
  });
  expect(publish).toHaveBeenCalledOnce();
});

test('names duplicate paths instead of publishing an ambiguous source set', async () => {
  const publish = vi.fn();
  await expect(
    createSourceIngestion({ publish })({
      inputs: [new File(['first'], 'lesson.txt'), new File(['second'], 'lesson.txt')],
      destination: { snapshot },
    })
  ).rejects.toMatchObject({
    code: 'source-preparation-failed',
    sourceWarnings: [{ name: 'lesson.txt', message: expect.any(String) }],
  });
  expect(publish).not.toHaveBeenCalled();
});

test('reports the named member when combined expanded bytes exceed the upload envelope', async () => {
  const zip = new JSZip();
  for (let i = 0; i < 5; i++) zip.file(`source-${i}.txt`, 'content');
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  const view = new DataView(bytes);
  for (let offset = 0; offset + 46 <= view.byteLength; offset++)
    if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 250_000_000, true);
  const publish = vi.fn();
  await expect(
    createSourceIngestion({ publish })({
      inputs: [new File([bytes], 'course.zip')],
      destination: { snapshot },
    })
  ).rejects.toMatchObject({
    code: 'source-preparation-failed',
    sourceWarnings: expect.arrayContaining([{ name: 'source-4.txt', message: expect.any(String) }]),
  });
  expect(publish).not.toHaveBeenCalled();
});

test.each([
  'missing',
  'unsupported-format',
])('browsers with %s decompression receive an extraction action and retain earlier warnings', async mode => {
  vi.stubGlobal(
    'DecompressionStream',
    mode === 'missing'
      ? undefined
      : class {
          constructor() {
            throw new TypeError('Unsupported format');
          }
        }
  );
  const zip = new JSZip();
  zip.file('notes.txt', 'compressed notes');
  const oversized = new File([''], 'a.txt');
  Object.defineProperty(oversized, 'size', { value: COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes + 1 });
  const publish = vi.fn();
  await expect(
    createSourceIngestion({ publish })({
      inputs: [
        oversized,
        new File(
          [await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })],
          'course.zip'
        ),
      ],
      destination: { snapshot },
    })
  ).rejects.toMatchObject({
    sourceWarnings: [
      { name: 'a.txt', message: expect.any(String) },
      { name: 'course.zip', message: expect.stringMatching(/ZIP/) },
    ],
  });
  expect(publish).not.toHaveBeenCalled();
});

test('the Blob staging fallback preserves source cancellation', async () => {
  vi.stubGlobal('navigator', {});
  const controller = new AbortController();
  const zip = new JSZip();
  zip.file('notes.txt', 'cancelled');
  const publish = vi.fn();
  await expect(
    createSourceIngestion({ publish })({
      inputs: [new File([await zip.generateAsync({ type: 'arraybuffer' })], 'course.zip')],
      destination: { snapshot },
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(publish).not.toHaveBeenCalled();
});
