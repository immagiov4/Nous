import type { ProjectAssetRef, ProjectLessonVisual } from '@shared/projectAsset';
import { describe, expect, test, vi } from 'vitest';

import type { ProjectSnapshot } from '../../src/projects/types.js';
import {
  ArtifactDraftSourceNotFoundError,
  createArtifactDraftApi,
} from '../../src/workflows/artifactDraftApi.js';
import {
  ARTIFACT_DRAFT_WORKFLOW_ID,
  createArtifactDraftWorkflow,
} from '../../src/workflows/artifactDraftWorkflow.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';

const ASSET_ID = 'a'.repeat(64);
const SOURCE_RUN_ID = '11111111-1111-4111-8111-111111111111';

const asset: ProjectAssetRef = {
  byteSize: 4,
  hash: ASSET_ID,
  id: ASSET_ID,
  mediaType: 'image/png',
};
const sourceVisual: ProjectLessonVisual = {
  createdAt: '2026-08-01T10:00:00.000Z',
  id: `lesson-visual:${SOURCE_RUN_ID}:artifact-draft`,
  render: {
    code: `<style></style><img src="{{PROJECT_ASSET:${ASSET_ID}}}"><script></script>`,
    embeddedAssets: [asset],
    kind: 'html',
  },
  slotId: 'artifact-draft',
  title: 'Intreccio',
};

const project = (generatedVisuals: unknown[] = []): ProjectSnapshot => ({
  createdAt: '2026-08-01T10:00:00.000Z',
  id: 'project-1',
  lastOpenedAt: '2026-08-01T10:00:00.000Z',
  learningPlan: {
    modules: [
      {
        children: [{ generatedVisuals, id: 'lesson-1', kind: 'lesson', title: 'Intreccio' }],
        id: 'module-1',
      },
    ],
  },
  updatedAt: '2026-08-01T10:00:00.000Z',
  version: '4.1',
});

const registry = () => {
  const value = createWorkflowRegistry();
  value.register({
    current: createArtifactDraftWorkflow({
      maxAttempts: 3,
      timeoutMs: 60_000,
      visual: {
        artifact: { model: 'artifact', provider: 'openrouter', reasoningEffort: 'low' },
        artifactInteractive: {
          model: 'interactive',
          provider: 'codex',
          reasoningEffort: 'low',
        },
        image: { model: 'image', provider: 'openrouter' },
        review: { enabled: true, maxRounds: 1 },
      },
    }),
  });
  return value;
};

const workflowRun = (overrides: Record<string, unknown> = {}) =>
  ({
    cancellationRequested: false,
    cleanupStatus: 'not-required',
    createdAt: '2026-08-01T10:00:00.000Z',
    definitionHash: 'hash',
    definitionHashVersion: 1,
    id: 'new-run',
    input: {},
    projectId: 'project-1',
    requestKey: 'request-1',
    resolvedConfig: {},
    status: 'queued',
    stepPolicies: {},
    stepPoliciesVersion: 1,
    updatedAt: '2026-08-01T10:00:00.000Z',
    userId: 'user-1',
    workflowId: ARTIFACT_DRAFT_WORKFLOW_ID,
    ...overrides,
  }) as never;

const startInput = {
  lessonMarkdown: '## Intreccio\n\nTrama e ordito.',
  projectId: 'project-1',
  requestText: 'Modifica il widget.',
  requestKey: 'request-1',
  sectionDescription: 'Riconoscere trama e ordito.',
  sectionId: 'lesson-1',
  sectionTitle: 'Intreccio',
  sourceVisualId: sourceVisual.id,
  userId: 'user-1',
};

const sourceRunInput = {
  lessonMarkdown: startInput.lessonMarkdown,
  projectId: startInput.projectId,
  requestText: 'Crea un widget.',
  sectionDescription: startInput.sectionDescription,
  sectionId: startInput.sectionId,
  sectionTitle: startInput.sectionTitle,
  userId: startInput.userId,
};

const dependencies = (snapshot: ProjectSnapshot, previousRun: unknown = null) => {
  const createRun = vi.fn(async input => ({
    created: true,
    run: workflowRun({ id: input.id, input: input.input }),
  }));
  return {
    createRun,
    input: {
      projectReader: { loadProject: vi.fn().mockResolvedValue(snapshot) },
      registry: registry(),
      resolveVisualConfig: vi.fn().mockResolvedValue({
        artifact: { model: 'artifact', provider: 'openrouter', reasoningEffort: 'low' },
        artifactInteractive: {
          model: 'interactive',
          provider: 'codex',
          reasoningEffort: 'low',
        },
        image: { model: 'image', provider: 'openrouter' },
        review: { enabled: true, maxRounds: 1 },
      }),
      runReader: {
        getRun: vi.fn().mockResolvedValue(previousRun),
        getRunState: vi.fn().mockResolvedValue(null),
      },
      runStore: { createRun },
    },
  };
};

describe('artifact draft API', () => {
  test('copies source asset references from the authoritative project snapshot', async () => {
    const setup = dependencies(project([sourceVisual]));

    await createArtifactDraftApi(setup.input).start(startInput);

    expect(setup.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          requestedVisualKind: 'html',
          sourceVisual,
        }),
      })
    );
  });

  test('resolves an unsaved source from its completed artifact workflow run', async () => {
    const previousRun = workflowRun({
      id: SOURCE_RUN_ID,
      input: sourceRunInput,
      output: { visual: sourceVisual },
      status: 'completed',
    });
    const setup = dependencies(project(), previousRun);

    await createArtifactDraftApi(setup.input).start(startInput);

    expect(setup.input.runReader.getRun).toHaveBeenCalledWith({
      runId: SOURCE_RUN_ID,
      userId: 'user-1',
    });
    expect(setup.createRun.mock.calls[0]?.[0].input).toMatchObject({ sourceVisual });
  });

  test('rejects an unsaved source produced for another lesson', async () => {
    const previousRun = workflowRun({
      id: SOURCE_RUN_ID,
      input: { ...sourceRunInput, sectionId: 'lesson-2' },
      output: { visual: sourceVisual },
      status: 'completed',
    });
    const setup = dependencies(project(), previousRun);

    await expect(createArtifactDraftApi(setup.input).start(startInput)).rejects.toBeInstanceOf(
      ArtifactDraftSourceNotFoundError
    );
    expect(setup.createRun).not.toHaveBeenCalled();
  });

  test('rejects a durable source id that is outside the authenticated project history', async () => {
    const setup = dependencies(project());

    await expect(createArtifactDraftApi(setup.input).start(startInput)).rejects.toBeInstanceOf(
      ArtifactDraftSourceNotFoundError
    );
    expect(setup.createRun).not.toHaveBeenCalled();
  });
});
