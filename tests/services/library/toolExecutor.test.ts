import { describe, expect, test, vi } from 'vitest';

import { executeLibraryAssistantTool } from '../../../services/library/toolExecutor.ts';
import type {
  LearningPlan,
  LibraryContextRef,
  LibraryFolder,
  LibraryPlacement,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../../types.ts';
import { buildLibraryTree } from '../../../utils/library/tree.ts';

const folders: LibraryFolder[] = [
  {
    id: 'folder-frontend',
    name: 'Frontend',
    parentFolderId: null,
    createdAt: '2026-04-02T10:00:00.000Z',
    updatedAt: '2026-04-02T10:00:00.000Z',
    order: 1,
  },
];

const projects: SavedProjectMeta[] = [
  {
    id: 'project-1',
    title: 'TypeScript Base',
    sourceKind: 'document',
    createdAt: '2026-04-02T10:00:00.000Z',
    updatedAt: '2026-04-02T10:00:00.000Z',
    lastOpenedAt: '2026-04-02T10:00:00.000Z',
    lessonCount: 2,
    completedCount: 1,
    hasSourceFile: true,
    coverLabel: 'PDF',
    syncState: 'local-only',
  },
  {
    id: 'project-2',
    title: 'React Hooks',
    sourceKind: 'document',
    createdAt: '2026-04-03T10:00:00.000Z',
    updatedAt: '2026-04-03T10:00:00.000Z',
    lastOpenedAt: '2026-04-03T10:00:00.000Z',
    lessonCount: 1,
    completedCount: 0,
    hasSourceFile: true,
    coverLabel: 'PDF',
    syncState: 'local-only',
  },
  {
    id: 'project-3',
    title: 'Rust Systems',
    sourceKind: 'document',
    createdAt: '2026-04-04T10:00:00.000Z',
    updatedAt: '2026-04-04T10:00:00.000Z',
    lastOpenedAt: '2026-04-04T10:00:00.000Z',
    lessonCount: 1,
    completedCount: 0,
    hasSourceFile: true,
    coverLabel: 'PDF',
    syncState: 'local-only',
  },
];

const placements: LibraryPlacement[] = [
  {
    projectId: 'project-1',
    folderId: 'folder-frontend',
    order: 1,
    updatedAt: '2026-04-02T10:00:00.000Z',
  },
  {
    projectId: 'project-2',
    folderId: null,
    order: 2,
    updatedAt: '2026-04-03T10:00:00.000Z',
  },
  {
    projectId: 'project-3',
    folderId: null,
    order: 3,
    updatedAt: '2026-04-04T10:00:00.000Z',
  },
];

const buildSnapshot = (id: string, learningPlan: LearningPlan): ProjectSnapshot => ({
  id,
  version: '1',
  sourceKind: 'document',
  state: 'READING',
  source: null,
  learningPlan,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: learningPlan.sections[0]?.id || null,
  createdAt: '2026-04-02T10:00:00.000Z',
  updatedAt: '2026-04-02T10:00:00.000Z',
  lastOpenedAt: '2026-04-02T10:00:00.000Z',
});

const snapshots: ProjectSnapshot[] = [
  buildSnapshot('project-1', {
    title: 'TypeScript Base',
    summary: 'Fondamenti del linguaggio',
    sections: [
      {
        id: 'lesson-1',
        title: 'Tipi primitivi',
        description: 'String, number e boolean',
        isCompleted: true,
        type: 'core',
        content:
          'Introduzione <mark data-lumina-annotation-id="annotation-1">tipi primitivi</mark> in TypeScript.',
        annotations: [
          {
            id: 'annotation-1',
            note: 'Questo passaggio mi interessa per chiarire le differenze con JavaScript.',
            createdAt: '2026-04-02T10:00:00.000Z',
            updatedAt: '2026-04-02T10:00:00.000Z',
          },
        ],
      },
      {
        id: 'lesson-2',
        title: 'Union types',
        description: 'Comporre tipi multipli',
        isCompleted: false,
        type: 'core',
        content: 'Le union types permettono varianti controllate.',
        annotations: [],
      },
    ],
  }),
  buildSnapshot('project-2', {
    title: 'React Hooks',
    summary: 'State e side effects',
    sections: [
      {
        id: 'lesson-react-1',
        title: 'useEffect',
        description: 'Effetti e sincronizzazione',
        isCompleted: false,
        type: 'core',
        content: 'useEffect gestisce effetti collaterali.',
        annotations: [],
      },
    ],
  }),
  buildSnapshot('project-3', {
    title: 'Rust Systems',
    summary: 'Ownership e borrowing',
    sections: [
      {
        id: 'lesson-rust-1',
        title: 'Ownership',
        description: 'Regole di possesso',
        isCompleted: false,
        type: 'core',
        content: 'Ownership e borrowing governano la memoria.',
        annotations: [],
      },
    ],
  }),
];

const tree = buildLibraryTree({
  folders,
  placements,
  projects,
});

const attachedContextRefs: LibraryContextRef[] = [
  {
    id: 'folder-frontend',
    kind: 'folder',
    label: 'Frontend',
  },
  {
    id: 'project-2',
    kind: 'project',
    label: 'React Hooks',
  },
];

const noAttachedContextRefs: LibraryContextRef[] = [];

const loadProjectsById = vi.fn(async (ids: string[]) =>
  snapshots.filter(snapshot => ids.includes(snapshot.id))
);

describe('executeLibraryAssistantTool', () => {
  test('resolves mixed folder and project attachments into a combined scope', async () => {
    const result = await executeLibraryAssistantTool({
      dataSource: {
        attachedContextRefs,
        folders,
        loadProjectsById,
        projects,
        tree,
      },
      input: {},
      toolName: 'getProjectOverviews',
    });

    expect(result.outputError).toBeUndefined();
    expect(result.output).toMatchObject({
      projects: [
        expect.objectContaining({ id: 'project-1', title: 'TypeScript Base' }),
        expect.objectContaining({ id: 'project-2', title: 'React Hooks' }),
      ],
    });
  });

  test('defaults project structures to the whole current scope when projectIds are omitted', async () => {
    const result = await executeLibraryAssistantTool({
      dataSource: {
        attachedContextRefs,
        folders,
        loadProjectsById,
        projects,
        tree,
      },
      input: {},
      toolName: 'getProjectStructures',
    });

    expect(result.outputError).toBeUndefined();
    expect(result.output).toMatchObject({
      projects: [
        expect.objectContaining({ id: 'project-1', title: 'TypeScript Base' }),
        expect.objectContaining({ id: 'project-2', title: 'React Hooks' }),
      ],
    });
  });

  test('returns lesson details with extracted highlight text and notes', async () => {
    const result = await executeLibraryAssistantTool({
      dataSource: {
        attachedContextRefs,
        folders,
        loadProjectsById,
        projects,
        tree,
      },
      input: {
        requests: [
          {
            projectId: 'project-1',
            lessonIds: ['lesson-1'],
          },
        ],
      },
      toolName: 'getLessonDetails',
    });

    expect(result.outputError).toBeUndefined();
    expect(result.output).toMatchObject({
      lessonsByProject: [
        {
          projectId: 'project-1',
          lessons: [
            {
              id: 'lesson-1',
              noteCount: 1,
              annotations: [
                expect.objectContaining({
                  annotationId: 'annotation-1',
                  highlightedText: 'tipi primitivi',
                  note: 'Questo passaggio mi interessa per chiarire le differenze con JavaScript.',
                }),
              ],
            },
          ],
        },
      ],
    });
  });

  test('rejects project requests outside the allowed scope', async () => {
    const result = await executeLibraryAssistantTool({
      dataSource: {
        attachedContextRefs,
        folders,
        loadProjectsById,
        projects,
        tree,
      },
      input: {
        projectIds: ['project-3'],
      },
      toolName: 'getProjectStructures',
    });

    expect(result.outputError).toBeUndefined();
    expect(result.output).toMatchObject({
      error: 'Corsi fuori dallo scope allegato: Rust Systems',
    });
  });

  test('treats no attached scope as full-library access', async () => {
    const result = await executeLibraryAssistantTool({
      dataSource: {
        attachedContextRefs: noAttachedContextRefs,
        folders,
        loadProjectsById,
        projects,
        tree,
      },
      input: {
        projectIds: ['project-3'],
      },
      toolName: 'getProjectStructures',
    });

    expect(result.outputError).toBeUndefined();
    expect(result.output).toMatchObject({
      projects: [expect.objectContaining({ id: 'project-3', title: 'Rust Systems' })],
    });
  });

  test('uses a non-scope error message in whole-library mode for unknown courses', async () => {
    const result = await executeLibraryAssistantTool({
      dataSource: {
        attachedContextRefs: noAttachedContextRefs,
        folders,
        loadProjectsById,
        projects,
        tree,
      },
      input: {
        projectIds: ['project-999'],
      },
      toolName: 'getProjectStructures',
    });

    expect(result.outputError).toBeUndefined();
    expect(result.output).toMatchObject({
      error: 'Il corso richiesto non e presente nella libreria corrente.',
    });
  });
});
