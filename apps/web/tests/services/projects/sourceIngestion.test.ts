import JSZip from 'jszip';
import { afterEach, expect, test, vi } from 'vitest';
import { createSourceIngestion } from '../../../services/projects/sourceIngestion';
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
    publish: async (destination, files) => {
      sent.push({
        names: files.map(file => file.file.name),
        texts: await Promise.all(files.map(file => file.file.text())),
        ids: files.map(file => file.sourceId),
      });
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
  zip.file('lesson.txt', '∀ n ∈ ℕ');
  const packed = new File([await zip.generateAsync({ type: 'arraybuffer' })], 'course.zip', {
    type: 'application/zip',
  });
  await ingestSources({
    inputs: [new File(['∀ n ∈ ℕ'], 'lesson.txt', { type: 'text/plain' })],
    destination: { snapshot },
  });
  await ingestSources({ inputs: [packed], destination: { snapshot } });
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEqual(sent[1]);
  expect(sent[0].names).toEqual(['lesson.txt']);
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
