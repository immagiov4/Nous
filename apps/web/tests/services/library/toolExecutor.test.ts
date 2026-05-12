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
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';
import { buildLibraryTree } from '../../../utils/library/tree.ts';
import {
  buildTestLearningPlan,
  buildTestLesson,
  buildTestProjectMeta,
} from '../../helpers/learningPlan.ts';

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
  buildTestProjectMeta({
    id: 'project-1',
    title: 'TypeScript Base',
    createdAt: '2026-04-02T10:00:00.000Z',
    updatedAt: '2026-04-02T10:00:00.000Z',
    lastOpenedAt: '2026-04-02T10:00:00.000Z',
    lessonCount: 2,
    completedCount: 1,
    coverLabel: 'PDF',
  }),
  buildTestProjectMeta({
    id: 'project-2',
    title: 'React Hooks',
    createdAt: '2026-04-03T10:00:00.000Z',
    updatedAt: '2026-04-03T10:00:00.000Z',
    lastOpenedAt: '2026-04-03T10:00:00.000Z',
    lessonCount: 1,
    completedCount: 0,
    coverLabel: 'PDF',
  }),
  buildTestProjectMeta({
    id: 'project-3',
    title: 'Rust Systems',
    createdAt: '2026-04-04T10:00:00.000Z',
    updatedAt: '2026-04-04T10:00:00.000Z',
    lastOpenedAt: '2026-04-04T10:00:00.000Z',
    lessonCount: 1,
    completedCount: 0,
    coverLabel: 'PDF',
  }),
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
  activeSectionId: flattenLessons(learningPlan.modules)[0]?.id || null,
  createdAt: '2026-04-02T10:00:00.000Z',
  updatedAt: '2026-04-02T10:00:00.000Z',
  lastOpenedAt: '2026-04-02T10:00:00.000Z',
});

const snapshots: ProjectSnapshot[] = [
  buildSnapshot(
    'project-1',
    buildTestLearningPlan(
      [
        buildTestLesson({
          id: 'lesson-1',
          title: 'Tipi primitivi',
          description: 'String, number e boolean',
          isCompleted: true,
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
        }),
        buildTestLesson({
          id: 'lesson-2',
          title: 'Union types',
          description: 'Comporre tipi multipli',
          content: 'Le union types permettono varianti controllate.',
          annotations: [],
          generatedVisuals: [
            {
              id: 'visual-union',
              title: 'mappa_union_types',
              kind: 'svg',
              code: '<svg viewBox="0 0 680 120"></svg>',
              createdAt: '2026-04-02T11:00:00.000Z',
            },
          ],
        }),
      ],
      {
        title: 'TypeScript Base',
        summary: 'Fondamenti del linguaggio',
      }
    )
  ),
  buildSnapshot(
    'project-2',
    buildTestLearningPlan(
      [
        buildTestLesson({
          id: 'lesson-react-1',
          title: 'useEffect',
          description: 'Effetti e sincronizzazione',
          content: 'useEffect gestisce effetti collaterali.',
          annotations: [],
          imageRefs: [{ assetId: 'pdf-img-react', alt: 'Ciclo useEffect' }],
        }),
      ],
      {
        title: 'React Hooks',
        summary: 'State e side effects',
      }
    )
  ),
  buildSnapshot(
    'project-3',
    buildTestLearningPlan(
      [
        buildTestLesson({
          id: 'lesson-rust-1',
          title: 'Ownership',
          description: 'Regole di possesso',
          content: 'Ownership e borrowing governano la memoria.',
          annotations: [],
        }),
      ],
      {
        title: 'Rust Systems',
        summary: 'Ownership e borrowing',
      }
    )
  ),
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
        projectRepositoryMode: 'lan',
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
        projectRepositoryMode: 'lan',
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
        projectRepositoryMode: 'lan',
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
        projectRepositoryMode: 'lan',
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
        projectRepositoryMode: 'lan',
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
        projectRepositoryMode: 'lan',
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

  test('returns artifact summaries and render payloads for scoped projects', async () => {
    snapshots[1] = {
      ...snapshots[1],
      documentAssets: {
        kind: 'pdf',
        parsedAt: '2026-04-03T10:00:00.000Z',
        imageCount: 1,
        usedImages: [
          {
            id: 'pdf-img-react',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,react',
            caption: 'Ciclo degli effetti React',
            textBefore: 'render',
            textCurrent: 'useEffect dopo il commit',
            textAfter: 'cleanup',
            sourceOrder: 1,
          },
        ],
      },
    };

    const result = await executeLibraryAssistantTool({
      dataSource: {
        attachedContextRefs,
        folders,
        loadProjectsById,
        projectRepositoryMode: 'lan',
        projects,
        tree,
      },
      input: {
        renderMode: 'attachments',
        projectIds: ['project-1', 'project-2'],
      },
      toolName: 'getLearningArtifacts',
    });

    expect(result.outputError).toBeUndefined();
    expect(result.output).toMatchObject({
      artifactCount: 2,
      artifacts: [
        expect.objectContaining({
          kind: 'generated-visual',
          lessonTitle: 'Union types',
          title: 'mappa union types',
        }),
        expect.objectContaining({
          kind: 'pdf-image',
          lessonTitle: 'useEffect',
          title: 'Ciclo useEffect',
        }),
      ],
    });
    expect(result.renderPayloads?.map(payload => payload.summary.id)).toEqual([
      'project-1:lesson-2:generated-visual:visual-union',
      'project-2:lesson-react-1:pdf-image:pdf-img-react',
    ]);
  });

  test('filters learning artifacts by lesson id and query', async () => {
    const result = await executeLibraryAssistantTool({
      dataSource: {
        attachedContextRefs: noAttachedContextRefs,
        folders,
        loadProjectsById,
        projectRepositoryMode: 'lan',
        projects,
        tree,
      },
      input: {
        renderMode: 'attachments',
        query: 'union types',
        requests: [
          {
            projectId: 'project-1',
            lessonIds: ['lesson-2'],
          },
        ],
      },
      toolName: 'getLearningArtifacts',
    });

    expect(result.outputError).toBeUndefined();
    expect(result.output).toMatchObject({
      artifactCount: 1,
      artifacts: [expect.objectContaining({ title: 'mappa union types' })],
    });
    expect(result.renderPayloads).toHaveLength(1);
  });

  test('keeps artifact recall metadata separate from chat rendering', async () => {
    const recallResult = await executeLibraryAssistantTool({
      dataSource: {
        attachedContextRefs: noAttachedContextRefs,
        folders,
        loadProjectsById,
        projectRepositoryMode: 'lan',
        projects,
        tree,
      },
      input: {
        kinds: ['generated-visual'],
        lessonQuery: 'Union',
        projectIds: ['project-1'],
      },
      toolName: 'getLearningArtifacts',
    });

    expect(recallResult.outputError).toBeUndefined();
    expect(recallResult.output).toMatchObject({
      artifactCount: 1,
      renderMode: 'metadata-only',
      renderedArtifactCount: 0,
      artifacts: [expect.objectContaining({ title: 'mappa union types' })],
    });
    expect(recallResult.renderPayloads).toBeUndefined();

    const artifactId = (
      recallResult.output as {
        artifacts: Array<{ id: string }>;
      }
    ).artifacts[0].id;
    const renderResult = await executeLibraryAssistantTool({
      dataSource: {
        attachedContextRefs: noAttachedContextRefs,
        folders,
        loadProjectsById,
        projectRepositoryMode: 'lan',
        projects,
        tree,
      },
      input: {
        artifactIds: [artifactId],
        projectIds: ['project-1'],
        renderMode: 'attachments',
      },
      toolName: 'getLearningArtifacts',
    });

    expect(renderResult.output).toMatchObject({
      artifactCount: 1,
      renderMode: 'attachments',
      renderedArtifactCount: 1,
    });
    expect(renderResult.renderPayloads?.map(payload => payload.summary.id)).toEqual([artifactId]);
  });
});
