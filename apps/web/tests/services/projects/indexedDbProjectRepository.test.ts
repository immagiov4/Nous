import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { AppState, type ProjectSnapshot } from '../../../types.ts';
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

const PATCH_TIMEOUT_MS = 250;

const stores = vi.hoisted(
  () =>
    new Map<string, Map<string, unknown>>([
      ['project-meta', new Map()],
      ['project-snapshots', new Map()],
      ['library-folders', new Map()],
      ['library-placements', new Map()],
    ])
);

vi.mock('idb', () => {
  const getStore = (name: string) => {
    const store = stores.get(name);
    if (!store) {
      throw new Error(`Missing fake IndexedDB store: ${name}`);
    }
    return store;
  };

  const putRecord = (storeName: string, value: unknown) => {
    const id =
      (value as { id?: string; projectId?: string }).id ??
      (value as { projectId: string }).projectId;
    getStore(storeName).set(id, value);
  };

  const db = {
    objectStoreNames: {
      contains: (storeName: string) => stores.has(storeName),
    },
    get: async (storeName: string, key: string) => getStore(storeName).get(key),
    getAll: async (storeName: string) => Array.from(getStore(storeName).values()),
    put: async (storeName: string, value: unknown) => {
      putRecord(storeName, value);
    },
    transaction: (storeNames: string | string[]) => ({
      objectStore: (storeName: string) => ({
        delete: async (key: string) => {
          getStore(storeName).delete(key);
        },
        get: async (key: string) => getStore(storeName).get(key),
        getAll: async () => Array.from(getStore(storeName).values()),
        put: async (value: unknown) => {
          putRecord(storeName, value);
        },
      }),
      done: Promise.resolve(),
      storeNames,
    }),
  };

  return {
    openDB: async () => db,
  };
});

const { IndexedDbProjectRepository } = await import(
  '../../../services/projects/indexedDbProjectRepository.ts'
);

const rejectAfterTimeout = (message: string) =>
  new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(message)), PATCH_TIMEOUT_MS);
  });

const snapshot: ProjectSnapshot = {
  id: 'project-1',
  version: '4.1',
  sourceKind: 'learn-mode',
  state: AppState.READING,
  source: null,
  learningPlan: buildTestLearningPlan([
    buildTestLesson({
      id: 'lesson-1',
      title: 'Lezione 1',
      description: 'Intro',
      moduleTitle: 'Modulo',
    }),
  ]),
  isLearnMode: true,
  userProfile: null,
  syllabus: [],
  activeSectionId: 'lesson-1',
  createdAt: '2026-05-12T12:00:00.000Z',
  updatedAt: '2026-05-12T12:00:00.000Z',
  lastOpenedAt: '2026-05-12T12:00:00.000Z',
  documentAssets: null,
  documentIndex: null,
};

beforeEach(() => {
  for (const store of stores.values()) {
    store.clear();
  }
});

test('patchProject persists lesson content without waiting on its own queue entry', async () => {
  const repository = new IndexedDbProjectRepository();
  await repository.saveProject(snapshot);

  await Promise.race([
    repository.patchProject('project-1', {
      section: {
        sectionId: 'lesson-1',
        content: '# Generata',
        generatedVisuals: [],
        imageRefs: [],
        quiz: [],
      },
    }),
    rejectAfterTimeout('patchProject did not resolve.'),
  ]);

  const stored = await repository.loadProject('project-1');
  assert.equal(flattenLessons(stored?.learningPlan?.modules)[0]?.content, '# Generata');
});

test('listProjects repairs stale lesson counts from stored snapshots', async () => {
  const repository = new IndexedDbProjectRepository();
  await repository.saveProject(snapshot);
  stores.get('project-meta')?.set('project-1', {
    id: 'project-1',
    title: 'Stale project',
    sourceKind: 'learn-mode',
    createdAt: '2026-05-12T12:00:00.000Z',
    updatedAt: '2026-05-12T12:00:00.000Z',
    lastOpenedAt: '2026-05-12T12:00:00.000Z',
    lessonCount: 0,
    completedCount: 0,
    exerciseCount: 0,
    completedExercises: 0,
    hasSourceFile: false,
    coverLabel: 'Bozza locale',
    syncState: 'local-only',
  });

  const projects = await repository.listProjects();

  assert.equal(projects[0]?.lessonCount, 1);
  assert.equal(projects[0]?.coverLabel, 'Percorso AI');
  assert.equal(
    (stores.get('project-meta')?.get('project-1') as { lessonCount?: number })?.lessonCount,
    1
  );
});
