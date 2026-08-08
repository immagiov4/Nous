import type { ProjectAssetRef } from '@shared/projectAsset';
import { NoObjectGeneratedError } from 'ai';
import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import {
  type ArtifactDraftWorkflowConfig,
  type ArtifactDraftWorkflowInput,
  type ArtifactDraftWorkflowServices,
  createArtifactDraftWorkflow,
} from '../../src/workflows/artifactDraftWorkflow.js';
import { buildLessonVisualContextFingerprint } from '../../src/workflows/lessonVisualContext.js';
import type { LessonVisualWorkflowResult } from '../../src/workflows/lessonVisualWorkflow.js';

const ASSET_ONE = 'a'.repeat(64);
const ASSET_TWO = 'b'.repeat(64);
const RUN_ID = '11111111-1111-4111-8111-111111111111';

const invalidStructuredOutput = () =>
  new NoObjectGeneratedError({
    finishReason: 'stop',
    response: { id: 'response', modelId: 'model', timestamp: new Date() },
    text: '{"visual_type":',
    usage: {
      inputTokenDetails: {
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        noCacheTokens: undefined,
      },
      inputTokens: undefined,
      outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
      outputTokens: undefined,
      totalTokens: undefined,
    },
  });

const config: ArtifactDraftWorkflowConfig = {
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
};

const input: ArtifactDraftWorkflowInput = {
  generationNotes: 'Usa esempi concreti.',
  lessonMarkdown: '## Intreccio\n\nTrama e ordito si incrociano.',
  projectId: 'project-1',
  requestText: 'Mostra in un immagine come si incrociano trama e ordito.',
  sectionDescription: 'Riconoscere trama e ordito.',
  sectionId: 'lesson-1',
  sectionTitle: 'Intreccio',
  userId: 'user-1',
};

const assetRef = (id: string): ProjectAssetRef => ({
  byteSize: 4,
  hash: id,
  id,
  mediaType: 'image/png',
});

const makeServices = (
  overrides: Partial<ArtifactDraftWorkflowServices> = {}
): ArtifactDraftWorkflowServices => ({
  assets: {
    adoptNodeAssets: vi.fn(async (_transaction, adoption) => adoption.assetIds.map(assetRef)),
    stage: vi.fn(async () => assetRef(ASSET_ONE)),
  },
  finalizeRetryResult: vi.fn(async ({ input: rendered }) => ({
    ...rendered,
    projectRevision: 1,
  })),
  generateArtifact: vi.fn(async () => ({
    code: '<svg viewBox="0 0 680 200"></svg>',
    imageRequests: [],
    kind: 'svg',
  })),
  generateEmbeddedImage: vi.fn(async () => ({
    bytes: new Uint8Array([1]),
    mediaType: 'image/png',
  })),
  generateRaster: vi.fn(async () => ({
    bytes: new Uint8Array([1]),
    mediaType: 'image/png',
  })),
  now: () => '2026-07-30T10:00:00.000Z',
  persistRetryResult: vi.fn(async () => undefined),
  planArtifactDraft: vi.fn(async () => ({
    altText: 'Trama e ordito intrecciati',
    anchorHeading: 'Intreccio',
    complexity: 'simple',
    concept: 'Incrocio tra trama e ordito',
    coverage: 'complete_synthesis',
    coverageRationale: 'Mostra il concetto richiesto.',
    factualRequirements: ['Fili perpendicolari'],
    interactionLevel: 'none',
    pedagogicalGoal: 'Riconoscere le due direzioni',
    reason: 'Il rapporto spaziale è utile.',
    requiresDepiction: false,
    slotId: 'artifact-draft',
    title: 'Trama e ordito',
    visualDirection: 'Schema essenziale',
    visualType: 'structural_svg',
  })),
  reviseArtifact: vi.fn(async ({ visual }) => visual),
  undoRetryResult: vi.fn(async () => undefined),
  ...overrides,
});

const workflowNodes = () => {
  const root = createArtifactDraftWorkflow(config).root;
  if (root.kind !== 'sequence') throw new TypeError('Expected the artifact draft sequence.');
  const [plan, route, adopt] = root.nodes;
  if (plan?.kind !== 'step' || route?.kind !== 'routeBy' || adopt?.kind !== 'step') {
    throw new TypeError('Expected planning, rendering route and final adoption.');
  }
  return { adopt, plan, route };
};

describe('artifact draft workflow', () => {
  test('plans an explicit raster request durably without an unnecessary planner call', async () => {
    const { plan, route } = workflowNodes();
    const services = makeServices();
    const planned = await plan.run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'root/plan-artifact-draft', runId: RUN_ID },
      idempotencyKey: 'plan-key',
      input: { ...input, requestedVisualKind: 'image' },
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });

    expect(planned).toMatchObject({
      kind: 'render',
      plan: {
        altText: input.sectionDescription,
        concept: input.requestText,
        title: input.sectionTitle,
        visualType: 'illustrative_image',
      },
      projectId: input.projectId,
      sectionId: input.sectionId,
    });
    expect(services.planArtifactDraft).not.toHaveBeenCalled();
    expect(route.select(planned)).toBe('render');
  });

  test('forwards durable corrective feedback to the planner retry', async () => {
    const { plan } = workflowNodes();
    const planArtifactDraft = vi.fn(async () => null);
    const services = makeServices({ planArtifactDraft });

    await plan.run({
      attemptNumber: 2,
      config,
      execution: { nodeInstanceId: 'root/plan-artifact-draft', runId: RUN_ID },
      idempotencyKey: 'plan-key',
      input,
      retryFeedback: 'Il JSON precedente non rispettava lo schema.',
      services,
      signal: new AbortController().signal,
    });

    expect(planArtifactDraft).toHaveBeenCalledWith(
      expect.objectContaining({ retryFeedback: 'Il JSON precedente non rispettava lo schema.' })
    );
  });

  test('turns malformed planner output into a corrective durable retry', async () => {
    const { plan } = workflowNodes();
    const services = makeServices({
      planArtifactDraft: vi.fn().mockRejectedValue(invalidStructuredOutput()),
    });

    const failure = await plan
      .run({
        attemptNumber: 1,
        config,
        execution: { nodeInstanceId: 'root/plan-artifact-draft', runId: RUN_ID },
        idempotencyKey: 'plan-key',
        input,
        retryFeedback: '',
        services,
        signal: new AbortController().signal,
      })
      .catch(error => error);

    expect(failure).toMatchObject({
      failure: {
        code: 'artifact_draft_plan_invalid',
        kind: 'corrective',
      },
    });
  });

  test('represents a valid no-visual decision without invoking the renderer', async () => {
    const { plan, route } = workflowNodes();
    const services = makeServices({ planArtifactDraft: vi.fn(async () => null) });
    const planned = await plan.run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'root/plan-artifact-draft', runId: RUN_ID },
      idempotencyKey: 'plan-key',
      input,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });

    expect(planned).toEqual({
      kind: 'none',
      projectId: input.projectId,
      sectionId: input.sectionId,
      userId: input.userId,
    });
    expect(route.select(planned)).toBe('none');
  });

  test('preserves provider retry timing and a safe diagnostic when planning fails', async () => {
    const { plan } = workflowNodes();
    const providerError = Object.assign(new Error('secret provider response'), {
      code: 'RATE_LIMIT',
      responseHeaders: { 'retry-after': '7' },
      status: 429,
    });
    const services = makeServices({
      planArtifactDraft: vi.fn().mockRejectedValue(providerError),
    });

    const failure = await plan
      .run({
        attemptNumber: 1,
        config,
        execution: { nodeInstanceId: 'root/plan-artifact-draft', runId: RUN_ID },
        idempotencyKey: 'plan-key',
        input,
        retryFeedback: '',
        services,
        signal: new AbortController().signal,
      })
      .catch(error => error);

    expect(failure).toMatchObject({
      failure: {
        code: 'artifact_draft_planning_failed',
        details: { diagnostic: { code: 'RATE_LIMIT', status: 429, type: 'Error' } },
        kind: 'operational',
        retryAfterMs: 7_000,
      },
    });
    expect(JSON.stringify(failure)).not.toContain('secret provider response');
  });

  test('adopts every rendered asset in the final commit and returns only the typed visual', async () => {
    const { adopt } = workflowNodes();
    const adoptNodeAssets = vi.fn(async (_transaction, adoption) =>
      adoption.assetIds.map(assetRef)
    );
    const services = makeServices({
      assets: { adoptNodeAssets, stage: vi.fn(async () => assetRef(ASSET_ONE)) },
    });
    const contextFingerprint = buildLessonVisualContextFingerprint(input);
    const rendered: LessonVisualWorkflowResult = {
      assetOwners: [
        { assetIds: [ASSET_ONE], nodeInstanceId: 'render/raster' },
        { assetIds: [ASSET_TWO], nodeInstanceId: 'render/embedded/image-1' },
      ],
      target: {
        contextFingerprint,
        plan: {
          complexity: 'simple',
          concept: 'Incrocio',
          coverage: 'complete_synthesis',
          coverageRationale: 'Completo',
          factualRequirements: [],
          interactionLevel: 'none',
          pedagogicalGoal: 'Mostrare',
          reason: 'Utile',
          requiresDepiction: false,
          slotId: 'artifact-draft',
          visualDirection: '',
          visualType: 'structural_svg',
        },
        projectId: input.projectId,
        sectionId: input.sectionId,
        userId: input.userId,
      },
      visual: {
        anchorHeading: 'Intreccio',
        createdAt: '2026-07-30T10:00:00.000Z',
        id: `lesson-visual:${RUN_ID}:artifact-draft`,
        render: { code: '<svg></svg>', kind: 'svg' },
        slotId: 'artifact-draft',
        title: 'Trama e ordito',
      },
    };
    const execution = { nodeInstanceId: 'root/adopt-artifact-draft-assets', runId: RUN_ID };
    const output = await adopt.run({
      attemptNumber: 1,
      config,
      execution,
      idempotencyKey: 'adopt-key',
      input: rendered,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });
    await adopt.commit?.({
      config,
      execution,
      input: rendered,
      output,
      services,
      transaction: {} as TransactionSql,
    });

    expect(output).toEqual({ visual: rendered.visual });
    expect(adoptNodeAssets).toHaveBeenCalledTimes(2);
    expect(adoptNodeAssets).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        assetIds: [ASSET_ONE],
        nodeInstanceId: 'render/raster',
        projectId: input.projectId,
        runId: RUN_ID,
        userId: input.userId,
      })
    );
    expect(adoptNodeAssets).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ assetIds: [ASSET_TWO] })
    );
  });
});
