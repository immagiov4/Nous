import { describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import type { ProjectSnapshot, ProjectStore } from '../../src/projects/types.js';
import { CodexAppServerError } from '../../src/services/codexAppServer.js';
import {
  buildLessonEvidenceMaterials,
  resolveLessonEvidence,
} from '../../src/services/lessonEvidence.js';
import { retryLessonGenerationCorrection } from '../../src/services/lessonGenerationCorrection.js';
import { resolveLessonResearchRequest } from '../../src/services/lessonGenerationModel.js';
import { resolveLessonSourceMaterials } from '../../src/services/lessonGenerationPreparation.js';
import { resolveLessonVisualModelConfig } from '../../src/services/lessonVisualModelConfig.js';
import { validateResearchSourceRouting } from '../../src/services/researchSourceRouting.js';
import {
  createLessonGenerationStageServices,
  type LessonGenerationStageDependencies,
} from '../../src/workflows/lessonGenerationStageServices.js';
import {
  createLessonGenerationWorkflow,
  createPreviousEvidenceLessonGenerationWorkflow,
} from '../../src/workflows/lessonGenerationWorkflow.js';
import {
  LessonContextStateSchema,
  LessonDraftStateSchema,
  LessonResearchStateSchema,
  LessonReviewedStateSchema,
  LessonSourcesStateSchema,
  LessonYouTubeStateSchema,
} from '../../src/workflows/lessonGenerationWorkflowContract.js';
import { indexWorkflowNodes } from '../../src/workflows/workflowNodeIndex.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';
import { researchRoutingScenarios } from '../services/researchSourceRouting.scenarios.js';

const project: ProjectSnapshot = {
  createdAt: '2026-07-29T20:00:00.000Z',
  id: 'project-1',
  lastOpenedAt: '2026-07-29T20:00:00.000Z',
  learningPlan: {
    modules: [
      {
        children: [
          {
            description: 'Comunicazione senza orologio globale.',
            id: 'lesson-1',
            kind: 'lesson',
            sourceReferences: [{ chunkIds: ['chunk-1'], sourceId: 'source-1' }],
            title: 'Comunicazioni a messaggi',
            type: 'prerequisite',
          },
        ],
        id: 'module-1',
        title: 'Modulo 1',
      },
    ],
    title: 'Sistemi distribuiti',
  },
  source: {
    kind: 'document',
    sources: [{ id: 'source-1', name: 'sistemi-distribuiti.pdf' }],
  },
  sourceKind: 'document',
  updatedAt: '2026-07-29T20:00:00.000Z',
  userProfile: { language: 'Italiano' },
  version: '4.1',
};

const modelConfig = getGlobalModelConfig();
const config = {
  maxAttempts: 3,
  models: modelConfig,
  timeoutMs: 90_000,
  visual: resolveLessonVisualModelConfig(modelConfig),
};

const unused = vi.fn(async () => {
  throw new Error('Unexpected dependency call.');
});

const dependencies = (
  overrides: Partial<LessonGenerationStageDependencies> = {}
): LessonGenerationStageDependencies => ({
  availableResearchChannels: ['web', 'youtube'],
  generateAids: unused,
  generateContent: unused,
  generateResearch: unused,
  loadProject: vi.fn().mockResolvedValue(project),
  loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 3, snapshot: project }),
  planYouTube: unused,
  researchYouTube: unused,
  resolveSourceMaterials: vi.fn().mockResolvedValue({
    existingDossier: null,
    existingSources: [],
    sourceContext: 'CHUNK chunk-1\nContenuto originale.',
  }),
  reviewContent: unused,
  selectCoverage: unused,
  selectEvidence: vi.fn(async input => {
    const materials = buildLessonEvidenceMaterials(input);
    return resolveLessonEvidence(materials, {
      materials: materials.map(material => ({
        materialId: material.materialId,
        reason: 'No evidence required by this stage fixture.',
        passages: [],
        overlaps: [],
      })),
    });
  }),
  store: {} as ProjectStore,
  ...overrides,
});

const stageContext = <Input>(input: Input, signal: AbortSignal = new AbortController().signal) => ({
  attemptNumber: 1,
  config,
  execution: { nodeInstanceId: 'node-1', runId: 'run-1' },
  idempotencyKey: 'step-key',
  input,
  retryFeedback: '',
  signal,
});

const lessonSourcesState = (keyConcepts: string[] = ['concetto']) =>
  LessonSourcesStateSchema.parse({
    documentAssetOwners: [],
    documentSourceHash: null,
    existingDossierJson: null,
    existingSources: [],
    lessonInputData: {
      description: 'Descrizione',
      imageCandidates: [],
      instructionPacks: [],
      language: 'Italiano',
      pedagogicalContext: '',
      previousLessonTitles: [],
      sectionTitle: 'Titolo',
      sourceContext: 'Fonte',
    },
    originalSources: [],
    pdfImages: [],
    request: {
      forceRegenerate: true,
      projectId: 'project-1',
      sectionId: 'lesson-1',
      userId: 'user-1',
    },
    requiresCoverageAssessment: false,
    sourceFingerprint: 'a'.repeat(64),
    stage: 'sources',
    targetFingerprint: 'b'.repeat(64),
    warnings: [],
    youtubePlanning: { courseTitle: 'Corso', keyConcepts },
  });

describe('lesson generation production stages', () => {
  test('carries fresh web research notes and identities into selected evidence and drafting', async () => {
    const webSource = {
      title: 'Source documentation',
      url: 'https://example.org/reference',
      note: 'A request identifier links the response to its request.',
    };
    const generateContent = vi.fn().mockResolvedValue({
      contentBlocks: [
        { type: 'markdown', markdown: 'A request identifier links the response to its request.' },
      ],
      generatedVisuals: [],
      imageRefs: [],
    });
    const services = createLessonGenerationStageServices(
      dependencies({
        generateContent,
        generateResearch: vi.fn().mockResolvedValue({
          avoidOversimplifying: [],
          controversies: [],
          difficultSteps: [],
          factualSummary: 'Request-response correlation.',
          keyExamples: [],
          recentDevelopments: [],
          sources: [webSource],
          youtubeCandidateDecisions: [],
        }),
        selectEvidence: vi.fn(async input =>
          resolveLessonEvidence(buildLessonEvidenceMaterials(input), {
            materials: buildLessonEvidenceMaterials(input).map(material => ({
              materialId: material.materialId,
              reason:
                material.kind === 'source'
                  ? 'Attributed evidence for the lesson.'
                  : 'Covered by the attributed note.',
              passages:
                material.kind === 'source'
                  ? [{ firstUnit: 0, lastUnit: 0, claims: ['Request-response correlation.'] }]
                  : [],
              overlaps: [],
            })),
          })
        ),
      })
    );
    const state = LessonYouTubeStateSchema.parse({
      ...lessonSourcesState(),
      discoveredYoutubeSources: [],
      research: { context: '', youtube: null },
      stage: 'youtube',
    });
    state.lessonInputData.sourceContext = '';
    const researched = await services.researchLesson({
      ...stageContext(state),
      selectEvidence: true,
    });
    const selected = await services.selectLessonEvidence(stageContext(researched));
    await services.draftLesson(stageContext(selected));
    expect(researched.lessonSources).toEqual([webSource]);
    expect(generateContent.mock.calls[0]?.[0].evidencePacket.passages).toEqual([
      expect.objectContaining({
        sourceIndex: 0,
        sourceContent: 'attributed-note',
        source: { title: webSource.title, url: webSource.url },
        units: [{ text: webSource.note, startOffset: 0, endOffset: webSource.note.length }],
      }),
    ]);
  });
  test.each([
    true,
    false,
  ])('selects evidence only for the evidence-capable durable definition: %s', async current => {
    const definition = current
      ? createLessonGenerationWorkflow(config)
      : createPreviousEvidenceLessonGenerationWorkflow(config);
    const node = [...indexWorkflowNodes(definition).values()].find(
      entry => entry.node.id === 'research-lesson'
    )?.node;
    if (node?.kind !== 'step') throw new Error('Missing research step.');
    const stageDependencies = dependencies({
      generateResearch: vi.fn().mockResolvedValue({
        avoidOversimplifying: [],
        controversies: [],
        difficultSteps: [],
        factualSummary: 'Sintesi.',
        keyExamples: [],
        recentDevelopments: [],
        sources: [],
        youtubeCandidateDecisions: [],
      }),
    });
    const services = createLessonGenerationStageServices(stageDependencies);
    const state = LessonYouTubeStateSchema.parse({
      ...lessonSourcesState(),
      discoveredYoutubeSources: [],
      research: { context: '', youtube: null },
      stage: 'youtube',
    });
    const researched = await node.run({ ...stageContext(state), services } as never);
    const selectionNode = [...indexWorkflowNodes(definition).values()].find(
      entry => entry.node.id === 'select-lesson-evidence'
    )?.node;
    if (selectionNode?.kind === 'step') {
      vi.mocked(stageDependencies.selectEvidence).mockRejectedValueOnce(
        retryLessonGenerationCorrection({
          code: 'lesson_evidence_selection_invalid',
          feedback: 'Repair the retained source references.',
          message: 'Invalid evidence selection.',
        })
      );
      await expect(
        selectionNode.run({ ...stageContext(researched), services } as never)
      ).rejects.toMatchObject({ failure: { kind: 'corrective' } });
    }
    const result =
      selectionNode?.kind === 'step'
        ? await selectionNode.run({
            ...stageContext(researched),
            retryFeedback: 'Repair the retained source references.',
            attemptNumber: 2,
            services,
          } as never)
        : researched;
    expect(Boolean(selectionNode)).toBe(current);
    expect(stageDependencies.selectEvidence).toHaveBeenCalledTimes(current ? 2 : 0);
    expect(stageDependencies.generateResearch).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(stageDependencies.generateResearch).mock.calls[0][0].retryFeedback
    ).toBeUndefined();
    if (current) {
      expect(vi.mocked(stageDependencies.selectEvidence).mock.calls[1][0].retryFeedback).toBe(
        'Repair the retained source references.'
      );
    }
    expect(Object.hasOwn(result as object, 'evidencePacketJson')).toBe(current);
    expect(result).toMatchObject({ stage: 'research', lessonSources: [] });
  });
  test.each([
    'recover',
    'exhaust',
  ] as const)('uses configured attempts for optional web research: %s', async outcome => {
    const providerError = new CodexAppServerError('Unavailable', 'process');
    const summary = {
      avoidOversimplifying: [],
      controversies: [],
      difficultSteps: [],
      factualSummary: 'Verified facts',
      keyExamples: [],
      recentDevelopments: [],
      sources: [],
    };
    const generateResearch = vi.fn().mockRejectedValue(providerError);
    if (outcome === 'recover')
      generateResearch.mockRejectedValueOnce(providerError).mockResolvedValue(summary);
    const services = createLessonGenerationStageServices(dependencies({ generateResearch }));
    const input = LessonYouTubeStateSchema.parse({
      ...lessonSourcesState(),
      discoveredYoutubeSources: [],
      research: { context: '', youtube: null },
      stage: 'youtube',
      researchRouting: {
        suppliedSourcesSufficient: true,
        rationale: 'Optional current context',
        channels: [
          { type: 'web', selected: true, rationale: 'Current examples' },
          { type: 'youtube', selected: false, rationale: 'Text only' },
        ],
      },
    });
    const attempts = outcome === 'recover' ? 2 : config.maxAttempts;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber += 1) {
        const result = services.researchLesson({ ...stageContext(input), attemptNumber });
        if (attemptNumber < attempts) await expect(result).rejects.toBe(providerError);
        else
          await expect(result).resolves.toMatchObject({
            research: { summary: outcome === 'recover' ? summary : null },
          });
      }
      expect(generateResearch).toHaveBeenCalledTimes(attempts);
      expect(warn).toHaveBeenCalledTimes(outcome === 'recover' ? 0 : 1);
    } finally {
      warn.mockRestore();
    }
  });
  test('preserves corrective routing failures and forwards feedback to the next lesson decision', async () => {
    let selected = false;
    const planner = vi.fn(async input =>
      validateResearchSourceRouting(
        {
          suppliedSourcesSufficient: false,
          rationale: 'Required facts',
          channels: [{ type: 'web', selected, rationale: 'Current sources' }],
        },
        input.availableChannels,
        input.sourceContext
      )
    );
    const services = createLessonGenerationStageServices(
      dependencies({ availableResearchChannels: ['web'], planResearchSources: planner })
    );
    const node = [...indexWorkflowNodes(createLessonGenerationWorkflow(config)).values()].find(
      entry => entry.node.id === 'plan-lesson-research-sources'
    )?.node;
    if (node?.kind !== 'step') throw new Error('Missing routing step');
    const context = { ...stageContext(lessonSourcesState()), services };
    const error = await node.run(context as never).catch(error => error);
    expect(error.failure).toMatchObject({
      kind: 'corrective',
      code: 'research_source_routing_invalid',
    });
    selected = true;
    await expect(
      node.run({ ...context, attemptNumber: 2, retryFeedback: error.failure.feedback } as never)
    ).resolves.toMatchObject({ researchRouting: { channels: [{ type: 'web', selected: true }] } });
    expect(planner.mock.calls[1][0].retryFeedback).toBe(error.failure.feedback);
  });
  test('passes only configured capabilities to the lesson planner', async () => {
    const planner = vi.fn().mockResolvedValue({
      suppliedSourcesSufficient: false,
      rationale: 'Current sources required',
      channels: [{ type: 'web', selected: true, rationale: 'Current facts' }],
    });
    const services = createLessonGenerationStageServices(
      dependencies({
        availableResearchChannels: ['web'],
        planResearchSources: planner,
      })
    );
    await services.planResearchSources(stageContext(lessonSourcesState()));
    expect(planner).toHaveBeenCalledWith(expect.objectContaining({ availableChannels: ['web'] }));
  });
  test.each([
    true,
    false,
  ])('propagates necessary YouTube failures with supplied sufficiency %s', async suppliedSourcesSufficient => {
    const providerError = new CodexAppServerError('Unavailable', 'process');
    const planYouTube = vi.fn().mockRejectedValue(providerError);
    const services = createLessonGenerationStageServices(
      dependencies({
        planYouTube,
        researchYouTube: vi.fn().mockRejectedValue(providerError),
        logger: { warn: vi.fn() },
      })
    );
    const input = lessonSourcesState();
    input.researchRouting = {
      suppliedSourcesSufficient,
      rationale: 'Video evidence.',
      channels: [
        { type: 'web', selected: false, rationale: 'No web evidence needed.' },
        { type: 'youtube', selected: true, rationale: 'Demonstration required.' },
      ],
    };
    await expect(services.planYouTubeResearch(stageContext(input))).rejects.toBe(providerError);
    const planning = services.planYouTubeResearch({
      ...stageContext(input),
      attemptNumber: config.maxAttempts,
    });
    if (suppliedSourcesSufficient)
      await expect(planning).resolves.toMatchObject({ youtubeSearchPlan: null });
    else await expect(planning).rejects.toBe(providerError);
    planYouTube.mockResolvedValue({
      specificQuery: 'specific',
      fallbackQuery: 'fallback',
      focusConcept: 'concept',
    });
    const planned = await services.planYouTubeResearch({
      ...stageContext(input),
      attemptNumber: 2,
    });
    await expect(services.researchSpecificYouTube(stageContext(planned))).rejects.toBe(
      providerError
    );
    const specific = services.researchSpecificYouTube({
      ...stageContext(planned),
      attemptNumber: config.maxAttempts,
    });
    if (suppliedSourcesSufficient)
      await expect(specific).resolves.toMatchObject({ youtubeSearchOutcome: null });
    else await expect(specific).rejects.toBe(providerError);
    const fallback = services.researchFallbackYouTube({
      ...stageContext({ ...planned, stage: 'youtube-search', youtubeSearchOutcome: null }),
      attemptNumber: config.maxAttempts,
    });
    if (suppliedSourcesSufficient)
      await expect(fallback).resolves.toMatchObject({ youtubeSearchOutcome: null });
    else await expect(fallback).rejects.toBe(providerError);
    planYouTube.mockRejectedValue(new CodexAppServerError('Invalid response', 'protocol'));
    await expect(services.planYouTubeResearch(stageContext(input))).rejects.toThrow(
      'Invalid response'
    );
  });
  test.each(
    researchRoutingScenarios
  )('$name applies the structured decision before lesson retrieval', async scenario => {
    const researchRouting = {
      suppliedSourcesSufficient: scenario.suppliedSourcesSufficient,
      rationale: scenario.learningContext,
      channels: (['web', 'youtube'] as const).map(type => ({
        type,
        selected: scenario.selected.includes(type),
        rationale: scenario.name,
      })),
    };
    const planner = vi.fn().mockResolvedValue(researchRouting);
    const services = createLessonGenerationStageServices(
      dependencies({ planResearchSources: planner })
    );
    const input = lessonSourcesState();
    input.lessonInputData.sectionTitle = scenario.topic;
    input.lessonInputData.sourceContext = scenario.sourceContext;
    input.lessonInputData.coverageGaps = ['Required prerequisite evidence'];
    const routed = await services.planResearchSources(stageContext(input));
    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({ coverageGaps: input.lessonInputData.coverageGaps })
    );
    const definition = createLessonGenerationWorkflow(config);
    const route = [...indexWorkflowNodes(definition).values()].find(
      entry => entry.node.id === 'route-youtube-research'
    )?.node;
    if (route?.kind !== 'routeBy') throw new Error('Missing YouTube route.');
    expect(route.select(routed)).toBe(
      scenario.selected.includes('youtube') ? 'research' : 'bypass'
    );
    expect(
      resolveLessonResearchRequest({
        config: modelConfig,
        refreshResearch: true,
        sourceContext: scenario.sourceContext,
        researchRouting: routed.researchRouting,
      }).webSearch
    ).toBe(scenario.selected.includes('web'));
    expect(planner).toHaveBeenCalledTimes(1);
  });

  test('full regeneration discards the saved dossier and its derived sources', async () => {
    const services = createLessonGenerationStageServices(
      dependencies({
        resolveSourceMaterials: vi.fn().mockResolvedValue({
          existingDossier: {
            factualSummary: 'Dossier precedente',
            sectionId: 'lesson-1',
            sources: [{ title: 'Fonte precedente', url: 'https://example.com/old' }],
            title: 'Titolo precedente',
          },
          existingSources: [{ title: 'Fonte precedente', url: 'https://example.com/old' }],
          sourceContext: 'CHUNK chunk-1\nContenuto originale.',
        }),
      })
    );

    const outcome = await services.prepareLesson(
      stageContext({
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      })
    );

    expect(outcome.kind).toBe('generate');
    if (outcome.kind !== 'generate') throw new Error('Expected generation context.');
    expect(outcome.state.existingDossierJson).toBeNull();
    expect(outcome.state.existingSources).toEqual([]);
    expect(outcome.state.requiresCoverageAssessment).toBe(true);
  });

  test('assesses source coverage for a core lesson before research routing', async () => {
    const coreProject = structuredClone(project);
    const section = coreProject.learningPlan?.modules?.[0]?.children?.[0];
    if (!section) throw new Error('Missing test lesson.');
    section.type = 'core';
    const services = createLessonGenerationStageServices(
      dependencies({
        loadProject: vi.fn().mockResolvedValue(coreProject),
        loadProjectWithRevision: vi.fn().mockResolvedValue({
          revision: 1,
          snapshot: coreProject,
        }),
        resolveSourceMaterials: vi.fn().mockResolvedValue({
          existingDossier: null,
          existingSources: [],
          sourceContext: 'CHUNK chunk-1\nContenuto originale.',
        }),
      })
    );

    const outcome = await services.prepareLesson(
      stageContext({
        forceRegenerate: false,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      })
    );

    expect(outcome.kind).toBe('generate');
    if (outcome.kind !== 'generate') throw new Error('Expected generation context.');
    expect(outcome.state.requiresCoverageAssessment).toBe(true);
  });

  test('reads detached original bytes when no document index is available', async () => {
    const store = new InMemoryProjectStore();
    const sourceText = 'Il documento originale descrive la fase luminosa nei tilacoidi.';
    const unmappedProject = structuredClone(project);
    const section = unmappedProject.learningPlan?.modules?.[0]?.children?.[0];
    if (!section) throw new Error('Missing test lesson.');
    section.sourceReferences = [];
    await store.saveProject('user-1', {
      ...unmappedProject,
      documentIndex: undefined,
      source: {
        file: {
          data: Buffer.from(sourceText).toString('base64'),
          mimeType: 'text/plain',
          name: 'appunti-biologia.txt',
        },
        kind: 'document',
      },
    });
    const services = createLessonGenerationStageServices(
      dependencies({
        loadProject: store.loadProject.bind(store),
        loadProjectWithRevision: store.loadProjectWithRevision.bind(store),
        resolveSourceMaterials: resolveLessonSourceMaterials,
        store,
      })
    );

    const outcome = await services.prepareLesson(
      stageContext({
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      })
    );

    expect(outcome.kind).toBe('generate');
    if (outcome.kind !== 'generate') throw new Error('Expected generation context.');
    expect(outcome.state.lessonInputData.sourceContext).toContain(sourceText);
    expect(outcome.state.originalSources).toEqual([
      expect.objectContaining({ title: 'appunti-biologia.txt' }),
    ]);
  });

  test.each([
    undefined,
    { chunks: [{ id: 'chunk-1', sourceId: 'source-1', text: 'Known passage.' }] },
  ])('rejects unresolved selections before reading unrelated stored material', async documentIndex => {
    const unresolvedProject = structuredClone(project);
    unresolvedProject.documentIndex = documentIndex;
    const section = unresolvedProject.learningPlan?.modules?.[0]?.children?.[0];
    if (!section) throw new Error('Missing test lesson.');
    section.sourceReferences = [{ chunkIds: ['chunk-1', 'missing'], sourceId: 'source-1' }];
    const loadProjectSources = vi.fn();
    const services = createLessonGenerationStageServices(
      dependencies({
        loadProjectWithRevision: vi
          .fn()
          .mockResolvedValue({ revision: 3, snapshot: unresolvedProject }),
        resolveSourceMaterials: resolveLessonSourceMaterials,
        store: { loadProjectSources } as unknown as ProjectStore,
      })
    );
    await expect(
      services.prepareLesson(
        stageContext({
          forceRegenerate: true,
          projectId: 'project-1',
          sectionId: 'lesson-1',
          userId: 'user-1',
        })
      )
    ).rejects.toMatchObject({
      failure: {
        code: 'lesson_source_unavailable',
        kind: 'permanent',
        message: 'The lesson source is unavailable.',
      },
    });
    expect(loadProjectSources).not.toHaveBeenCalled();
  });

  test('returns a stable source error when required detached bytes are missing', async () => {
    const unavailableProject = {
      ...project,
      documentIndex: undefined,
      source: { kind: 'document' },
    } satisfies ProjectSnapshot;
    const store = {
      loadProjectSource: vi.fn().mockResolvedValue(null),
      loadProjectSources: vi.fn().mockResolvedValue([]),
      loadProjectSourceArchiveIndex: vi.fn().mockResolvedValue(null),
    } as unknown as ProjectStore;
    const services = createLessonGenerationStageServices(
      dependencies({
        loadProject: vi.fn().mockResolvedValue(unavailableProject),
        loadProjectWithRevision: vi
          .fn()
          .mockResolvedValue({ revision: 3, snapshot: unavailableProject }),
        resolveSourceMaterials: resolveLessonSourceMaterials,
        store,
      })
    );

    const failure = await services
      .prepareLesson(
        stageContext({
          forceRegenerate: true,
          projectId: 'project-1',
          sectionId: 'lesson-1',
          userId: 'user-1',
        })
      )
      .catch(error => error);

    expect(failure.failure).toEqual({
      code: 'lesson_source_unavailable',
      kind: 'permanent',
      message: 'The lesson source is unavailable.',
    });
  });

  test('treats empty archive selectors as intentional source-free research', async () => {
    const archiveProject = structuredClone(project);
    const section = archiveProject.learningPlan?.modules?.[0]?.children?.[0];
    if (!section) throw new Error('Missing archive test lesson.');
    section.sourceArchiveSelectors = [];
    section.sourceReferences = [];
    section.type = 'lesson';
    archiveProject.documentIndex = undefined;
    archiveProject.source = { kind: 'archive', name: 'src.zip' };
    archiveProject.sourceKind = 'archive';
    const generateResearch = vi.fn().mockResolvedValue({
      avoidOversimplifying: [],
      controversies: [],
      difficultSteps: [],
      factualSummary: 'Ricerca completa.',
      keyExamples: [],
      recentDevelopments: [],
      sources: [],
    });
    const services = createLessonGenerationStageServices(
      dependencies({
        generateResearch,
        loadProject: vi.fn().mockResolvedValue(archiveProject),
        loadProjectWithRevision: vi
          .fn()
          .mockResolvedValue({ revision: 3, snapshot: archiveProject }),
        resolveSourceMaterials: resolveLessonSourceMaterials,
      })
    );
    const prepared = await services.prepareLesson(
      stageContext({
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      })
    );
    if (prepared.kind !== 'generate') throw new Error('Expected generation context.');
    const youtubeState = LessonYouTubeStateSchema.parse({
      ...prepared.state,
      discoveredYoutubeSources: [],
      documentAssetOwners: [],
      pdfImages: [],
      research: { context: '', youtube: null },
      stage: 'youtube',
    });

    await services.researchLesson({ ...stageContext(youtubeState), selectEvidence: true });

    expect(prepared.state.lessonInputData.sourceContext).toBe('');
    expect(generateResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        sectionTitle: 'Comunicazioni a messaggi',
        sourceContext: '',
      })
    );
  });

  test('isolates the selected source while preserving every pedagogical context layer', async () => {
    const contextualProject = structuredClone(project);
    const module = contextualProject.learningPlan?.modules?.[0];
    if (!module) throw new Error('Missing contextual test module.');
    module.children = [
      {
        content: 'Il parent spiega le basi della luce.',
        description: 'Le basi',
        id: 'lesson-parent',
        kind: 'lesson',
        title: 'Lezione padre',
      },
      {
        contextPrompt: 'Collega il testo selezionato ai fotoni.',
        description: 'Dettaglio',
        id: 'lesson-deep',
        kind: 'lesson',
        parentId: 'lesson-parent',
        sourceReferences: [{ chunkIds: ['chunk-a'], sourceId: 'source-a' }],
        title: 'Approfondimento',
      },
    ];
    contextualProject.documentIndex = {
      chunks: [
        { id: 'chunk-a', sourceId: 'source-a', text: 'Contenuto selezionato A.' },
        { id: 'chunk-b', sourceId: 'source-b', text: 'Contaminazione dal documento B.' },
      ],
      kind: 'pdf-text-index',
    };
    contextualProject.source = {
      kind: 'document',
      sources: [
        { id: 'source-a', name: 'a.pdf' },
        { id: 'source-b', name: 'b.pdf' },
      ],
    };
    contextualProject.researchCoursePlan = {
      lessons: [{ guidingQuestions: ['Come interagisce la luce?'], id: 'lesson-deep' }],
    };
    contextualProject.syllabus = [
      { children: [{ contextPrompt: 'Syllabus specifico', id: 'lesson-deep' }] },
    ];
    contextualProject.userProfile = { language: 'Italiano', topic: 'Biologia' };
    const services = createLessonGenerationStageServices(
      dependencies({
        loadProject: vi.fn().mockResolvedValue(contextualProject),
        loadProjectWithRevision: vi
          .fn()
          .mockResolvedValue({ revision: 3, snapshot: contextualProject }),
        resolveSourceMaterials: resolveLessonSourceMaterials,
      })
    );

    const outcome = await services.prepareLesson(
      stageContext({
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-deep',
        userId: 'user-1',
      })
    );

    expect(outcome.kind).toBe('generate');
    if (outcome.kind !== 'generate') throw new Error('Expected generation context.');
    expect(outcome.state.lessonInputData.sourceContext).toContain('Contenuto selezionato A.');
    expect(outcome.state.lessonInputData.sourceContext).not.toContain(
      'Contaminazione dal documento B.'
    );
    expect(outcome.state.originalSources).toEqual([
      expect.objectContaining({ sourceId: 'source-a', title: 'a.pdf' }),
    ]);
    const pedagogicalContext = outcome.state.lessonInputData.pedagogicalContext;
    expect(pedagogicalContext).toContain('Collega il testo selezionato ai fotoni.');
    expect(pedagogicalContext).toContain('Il parent spiega le basi della luce.');
    expect(pedagogicalContext).toContain('Biologia');
    expect(pedagogicalContext).toContain('Syllabus specifico');
    expect(pedagogicalContext).toContain('Come interagisce la luce?');
  });

  test('prepares source provenance and an explicit coverage decision without provider work', async () => {
    const services = createLessonGenerationStageServices(dependencies());

    const outcome = await services.prepareLesson(
      stageContext({
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      })
    );

    expect(outcome.kind).toBe('generate');
    if (outcome.kind !== 'generate') throw new Error('Expected generation context.');
    expect(outcome.state.originalSources).toEqual([
      expect.objectContaining({
        chunkIds: ['chunk-1'],
        sourceId: 'source-1',
        title: 'sistemi-distribuiti.pdf',
      }),
    ]);
    expect(outcome.state.requiresCoverageAssessment).toBe(true);
    expect(outcome.state.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(outcome.state.targetFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(outcome.state.lessonInputData.sourceContext).toContain('Contenuto originale');
  });

  test('preserves the legacy YouTube planner input for projects without a plan title', async () => {
    const legacyProject = structuredClone(project);
    if (!legacyProject.learningPlan) throw new Error('Missing test learning plan.');
    delete legacyProject.learningPlan.title;
    legacyProject.title = 'Legacy project title';
    const planYouTube = vi.fn().mockResolvedValue({
      fallbackQuery: 'query generale',
      focusConcept: 'concetto',
      specificQuery: 'query specifica',
    });
    const services = createLessonGenerationStageServices(
      dependencies({
        loadProject: vi.fn().mockResolvedValue(legacyProject),
        loadProjectWithRevision: vi
          .fn()
          .mockResolvedValue({ revision: 3, snapshot: legacyProject }),
        planYouTube,
      })
    );

    const prepared = await services.prepareLesson(
      stageContext({
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      })
    );
    if (prepared.kind !== 'generate') throw new Error('Expected generation context.');
    expect(prepared.state.youtubePlanning.courseTitle).toBe('');

    await services.planYouTubeResearch(stageContext(prepared.state));

    expect(planYouTube).toHaveBeenCalledOnce();
    expect(planYouTube.mock.calls[0]?.[0]).not.toHaveProperty('keyConcepts');
  });

  test('skips coverage provider work when the preparation state says it is unnecessary', async () => {
    const selectCoverage = vi.fn();
    const services = createLessonGenerationStageServices(dependencies({ selectCoverage }));
    const context = LessonContextStateSchema.parse({
      documentSourceHash: null,
      existingDossierJson: null,
      existingSources: [],
      lessonInputData: {
        description: 'Descrizione',
        imageCandidates: [],
        instructionPacks: [],
        language: 'Italiano',
        pedagogicalContext: '',
        previousLessonTitles: [],
        sectionTitle: 'Titolo',
        sourceContext: 'Fonte',
      },
      originalSources: [],
      request: {
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      },
      requiresCoverageAssessment: false,
      sourceFingerprint: 'a'.repeat(64),
      stage: 'context',
      targetFingerprint: 'b'.repeat(64),
      warnings: [],
      youtubePlanning: { courseTitle: 'Corso', keyConcepts: [] },
    });

    const result = await services.assessSourceCoverage(stageContext(context));

    expect(result.stage).toBe('coverage');
    expect(selectCoverage).not.toHaveBeenCalled();
  });

  test('passes prerequisite gaps to research while leaving ordinary lessons unclassified', async () => {
    const selectCoverage = vi.fn().mockResolvedValue({
      missingTopics: ['Ruolo della clorofilla'],
      needsResearch: true,
    });
    const services = createLessonGenerationStageServices(dependencies({ selectCoverage }));
    const prerequisite = LessonContextStateSchema.parse({
      documentSourceHash: null,
      existingDossierJson: null,
      existingSources: [],
      lessonInputData: {
        description: 'Descrizione',
        imageCandidates: [],
        instructionPacks: [],
        language: 'Italiano',
        pedagogicalContext: '',
        previousLessonTitles: [],
        sectionTitle: 'Titolo',
        sourceContext: 'Fonte parziale',
      },
      originalSources: [],
      request: {
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      },
      requiresCoverageAssessment: true,
      sourceFingerprint: 'a'.repeat(64),
      stage: 'context',
      targetFingerprint: 'b'.repeat(64),
      warnings: [],
      youtubePlanning: { courseTitle: 'Corso', keyConcepts: [] },
    });

    const result = await services.assessSourceCoverage(stageContext(prerequisite));

    expect(result.lessonInputData.coverageGaps).toEqual(['Ruolo della clorofilla']);
    expect(selectCoverage).toHaveBeenCalledOnce();
  });

  test.each([
    {
      discoveredCounts: [1],
      expectedQueries: ['query specifica'],
      fallbackQuery: 'query generale',
      name: 'keeps the specific result',
      specificQuery: 'query specifica',
    },
    {
      discoveredCounts: [0, 1],
      expectedQueries: ['query specifica', 'query generale'],
      fallbackQuery: 'query generale',
      name: 'falls back after zero results',
      specificQuery: 'query specifica',
    },
    {
      discoveredCounts: [0],
      expectedQueries: ['query identica'],
      fallbackQuery: 'query identica',
      name: 'does not repeat an identical query',
      specificQuery: 'query identica',
    },
  ])('$name', async ({ discoveredCounts, expectedQueries, fallbackQuery, specificQuery }) => {
    const researchYouTube = vi.fn();
    const planYouTube = vi.fn().mockResolvedValue({
      fallbackQuery,
      focusConcept: 'concetto',
      specificQuery,
    });
    discoveredCounts.forEach(count => {
      researchYouTube.mockResolvedValueOnce({
        context: count ? 'Transcript' : '',
        discoveredVideoCount: count,
        rationale: count ? 'Trovato.' : 'Nessun video.',
        videoCandidates: count
          ? [
              {
                segments: [{ endSeconds: 60, startSeconds: 0, text: 'Contenuto.' }],
                title: 'Video',
                url: 'https://www.youtube.com/watch?v=abcdefghijk',
              },
            ]
          : [],
      });
    });
    const services = createLessonGenerationStageServices(
      dependencies({
        planYouTube,
        researchYouTube,
      })
    );
    const sources = lessonSourcesState();

    const signal = new AbortController().signal;
    const context = stageContext(sources, signal);
    const plan = await services.planYouTubeResearch(context);
    const specific = await services.researchSpecificYouTube(stageContext(plan, signal));
    const searched =
      specific.youtubeSearchOutcome?.discoveredVideoCount === 0 &&
      specific.youtubeSearchPlan?.fallbackQuery !== specific.youtubeSearchPlan?.specificQuery
        ? await services.researchFallbackYouTube(stageContext(specific, signal))
        : specific;
    await services.finalizeYouTubeResearch(stageContext(searched, signal));

    expect(planYouTube).toHaveBeenCalledOnce();
    expect(researchYouTube.mock.calls.map(call => call[0])).toEqual(expectedQueries);
    expect(researchYouTube.mock.calls.map(call => call[2])).toEqual(
      expectedQueries.map(() => signal)
    );
  });

  test('persists model image references without requiring a placement anchor', async () => {
    const generatedDraft = {
      contentBlocks: [
        { markdown: 'Prima.\n\n{{PDF_IMAGE:pdf-1}}\n\nDopo.', type: 'markdown' as const },
      ],
      generatedVisuals: [],
      imageRefs: [{ alt: 'Diagramma', assetId: 'pdf-1', caption: 'Diagramma' }],
    };
    const services = createLessonGenerationStageServices(
      dependencies({
        generateContent: vi.fn(async () => generatedDraft),
        reviewContent: vi.fn(async () => generatedDraft),
      })
    );
    const research = LessonResearchStateSchema.parse({
      ...lessonSourcesState(),
      discoveredYoutubeSources: [],
      lessonSources: [],
      research: { context: '', summary: null, youtube: null },
      stage: 'research',
    });

    const written = LessonDraftStateSchema.parse(
      await services.draftLesson(stageContext(research))
    );
    const reviewed = LessonReviewedStateSchema.parse(
      await services.reviewLesson(stageContext(written))
    );

    for (const result of [written, reviewed]) {
      expect(result.draft.contentBlocks).toEqual(generatedDraft.contentBlocks);
      expect(result.draft.imageRefs).toEqual([
        { ...generatedDraft.imageRefs[0], anchorHeading: '' },
      ]);
    }
    expect(generatedDraft.imageRefs[0]).not.toHaveProperty('anchorHeading');
  });

  test('passes only selected YouTube transcripts to lesson writing', async () => {
    const selectedUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
    const rejectedUrl = 'https://www.youtube.com/watch?v=lmnopqrstuv';
    const generateContent = vi.fn().mockResolvedValue({
      contentBlocks: [{ markdown: '## Lezione\n\nContenuto.', type: 'markdown' }],
      generatedVisuals: [],
      imageRefs: [],
    });
    const services = createLessonGenerationStageServices(
      dependencies({
        generateContent,
        generateResearch: vi.fn().mockResolvedValue({
          avoidOversimplifying: [],
          controversies: [],
          difficultSteps: [],
          factualSummary: 'Sintesi.',
          keyExamples: [],
          recentDevelopments: [],
          sources: [],
          youtubeCandidateDecisions: [
            { decision: 'selected-source', reason: 'Pertinente.', url: selectedUrl },
            { decision: 'rejected', reason: 'Fuori tema.', url: rejectedUrl },
          ],
        }),
      })
    );
    const youtubeState = LessonYouTubeStateSchema.parse({
      discoveredYoutubeSources: [
        {
          title: 'Video selezionato',
          url: selectedUrl,
          youtubeTranscript: {
            segments: [{ endSeconds: 60, startSeconds: 0, text: 'Contenuto pertinente.' }],
          },
        },
        {
          title: 'Video rifiutato',
          url: rejectedUrl,
          youtubeTranscript: {
            segments: [{ endSeconds: 60, startSeconds: 0, text: 'Contenuto fuori tema.' }],
          },
        },
      ],
      documentAssetOwners: [],
      documentSourceHash: null,
      existingDossierJson: null,
      existingSources: [],
      lessonInputData: {
        description: 'Descrizione',
        imageCandidates: [],
        instructionPacks: [],
        language: 'Italiano',
        pedagogicalContext: '',
        previousLessonTitles: [],
        sectionTitle: 'Titolo',
        sourceContext: 'Fonte',
      },
      originalSources: [],
      pdfImages: [],
      request: {
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      },
      requiresCoverageAssessment: false,
      research: {
        context: 'Transcript candidati',
        youtube: {
          context: 'Transcript candidati',
          discoveredVideoCount: 2,
          rationale: 'Due candidati.',
          videoCandidates: [
            {
              segments: [{ endSeconds: 60, startSeconds: 0, text: 'Contenuto pertinente.' }],
              title: 'Video selezionato',
              url: selectedUrl,
            },
            {
              segments: [{ endSeconds: 60, startSeconds: 0, text: 'Contenuto fuori tema.' }],
              title: 'Video rifiutato',
              url: rejectedUrl,
            },
          ],
        },
      },
      sourceFingerprint: 'a'.repeat(64),
      stage: 'youtube',
      targetFingerprint: 'b'.repeat(64),
      warnings: [],
      youtubePlanning: { courseTitle: 'Corso', keyConcepts: [] },
    });

    const researchState = await services.researchLesson({
      ...stageContext(youtubeState),
      selectEvidence: true,
    });
    await services.draftLesson(stageContext(researchState));

    const writtenSources = generateContent.mock.calls[0]?.[0]?.sources ?? [];
    expect(researchState.lessonSources.map(source => source.url)).toEqual([selectedUrl]);
    expect(writtenSources.map(source => source.url)).toEqual([selectedUrl]);
    expect(JSON.stringify(writtenSources)).not.toContain(rejectedUrl);
  });

  test('keeps optional YouTube failure outside the terminal lesson failure path', async () => {
    const warn = vi.fn();
    const providerError = Object.assign(new Error('secret provider response'), {
      code: 'RATE_LIMIT',
      responseHeaders: { 'retry-after': '7' },
      status: 429,
    });
    const services = createLessonGenerationStageServices(
      dependencies({
        logger: { warn },
        planYouTube: vi.fn().mockResolvedValue({
          fallbackQuery: 'orologi logici',
          focusConcept: 'happens-before',
          specificQuery: 'happens before spiegazione',
        }),
        researchYouTube: vi.fn().mockRejectedValue(providerError),
      })
    );
    const sources = lessonSourcesState(['happens-before']);

    const plan = await services.planYouTubeResearch(stageContext(sources));
    const searched = await services.researchSpecificYouTube(stageContext(plan));
    const result = await services.finalizeYouTubeResearch(stageContext(searched));

    expect(result.research).toEqual({ context: '', youtube: null });
    expect(result.discoveredYoutubeSources).toEqual([]);
    expect(result.warnings).toEqual([
      { code: 'lesson_youtube_research_unavailable', stage: 'youtube' },
    ]);
    expect(warn).toHaveBeenCalledWith('Optional lesson YouTube research failed.', {
      diagnostic: { code: 'RATE_LIMIT', status: 429, type: 'Error' },
      projectId: 'project-1',
      retryAfterMs: 7_000,
      sectionId: 'lesson-1',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret provider response');
  });

  test('propagates cancellation instead of converting it into an optional warning', async () => {
    const controller = new AbortController();
    const warn = vi.fn();
    const researchYouTube = vi.fn().mockImplementation(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    });
    const services = createLessonGenerationStageServices(
      dependencies({
        logger: { warn },
        planYouTube: vi.fn().mockResolvedValue({
          fallbackQuery: 'orologi logici',
          focusConcept: 'happens-before',
          specificQuery: 'happens before spiegazione',
        }),
        researchYouTube,
      })
    );
    const plan = await services.planYouTubeResearch(stageContext(lessonSourcesState()));

    await expect(
      services.researchSpecificYouTube({
        ...stageContext(plan),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(warn).not.toHaveBeenCalled();
  });

  test('drops generation-only source payload after lesson review', async () => {
    const services = createLessonGenerationStageServices(
      dependencies({ reviewContent: vi.fn(async ({ draft }) => draft) })
    );
    const draft = LessonDraftStateSchema.parse({
      discoveredYoutubeSources: [],
      documentAssetOwners: [],
      documentSourceHash: null,
      draft: {
        contentBlocks: [{ markdown: '## Lezione\n\nContenuto.', type: 'markdown' }],
        generatedVisuals: [],
        imageRefs: [],
      },
      existingDossierJson: null,
      existingSources: [],
      lessonInputData: {
        description: 'Descrizione',
        imageCandidates: [],
        instructionPacks: [],
        language: 'Italiano',
        pedagogicalContext: '',
        previousLessonTitles: [],
        sectionTitle: 'Titolo',
        sourceContext: 'GENERATION_ONLY_SOURCE_PAYLOAD',
      },
      lessonSources: [],
      originalSources: [],
      pdfImages: [],
      request: {
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      },
      requiresCoverageAssessment: false,
      research: { context: 'GENERATION_ONLY_RESEARCH_CONTEXT', summary: null, youtube: null },
      sourceFingerprint: 'a'.repeat(64),
      stage: 'draft',
      targetFingerprint: 'b'.repeat(64),
      warnings: [],
      youtubePlanning: { courseTitle: 'Corso', keyConcepts: [] },
    });

    const result = await services.reviewLesson(stageContext(draft));

    expect(result.lessonInputData).toEqual({
      description: 'Descrizione',
      imageCandidates: [],
      sectionTitle: 'Titolo',
    });
    expect(result.research).toEqual({ summary: null, youtube: null });
    expect(result).not.toHaveProperty('discoveredYoutubeSources');
    expect(result).not.toHaveProperty('originalSources');
    expect(result).not.toHaveProperty('youtubePlanning');
    expect(JSON.stringify(result)).not.toContain('GENERATION_ONLY_');
  });

  test('keeps an exhausted learning-aid request as a durable degraded result', async () => {
    const warn = vi.fn();
    const services = createLessonGenerationStageServices(
      dependencies({
        generateAids: vi.fn().mockRejectedValue(new Error('private provider response')),
        logger: { warn },
      })
    );
    const reviewed = LessonReviewedStateSchema.parse({
      discoveredYoutubeSources: [],
      documentAssetOwners: [],
      documentSourceHash: null,
      draft: {
        contentBlocks: [{ markdown: '## Lezione\n\nContenuto.', type: 'markdown' }],
        generatedVisuals: [],
        imageRefs: [],
      },
      existingDossierJson: null,
      existingSources: [],
      lessonInputData: {
        description: 'Descrizione',
        imageCandidates: [],
        instructionPacks: [],
        language: 'Italiano',
        pedagogicalContext: '',
        previousLessonTitles: [],
        sectionTitle: 'Titolo',
        sourceContext: 'Fonte',
      },
      lessonSources: [],
      originalSources: [],
      pdfImages: [],
      request: {
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      },
      requiresCoverageAssessment: false,
      research: { context: '{}', summary: null, youtube: null },
      sourceFingerprint: 'a'.repeat(64),
      stage: 'review',
      targetFingerprint: 'b'.repeat(64),
      warnings: [],
      youtubePlanning: { courseTitle: 'Corso', keyConcepts: [] },
    });

    const result = await services.generateLearningAids(stageContext(reviewed));

    expect(result.learningAids).toEqual([]);
    expect(result.warnings).toEqual([{ code: 'lesson_learning_aids_unavailable', stage: 'aids' }]);
    expect(warn).toHaveBeenCalledWith(
      'Optional lesson learning-aid generation failed.',
      expect.objectContaining({ errorName: 'Error', projectId: 'project-1' })
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private provider response');
  });

  test('returns completed content before resolving sources when regeneration is not requested', async () => {
    const completedProject = structuredClone(project);
    const lesson = completedProject.learningPlan?.modules?.[0]?.children?.[0];
    if (!lesson) throw new Error('Missing test lesson.');
    const assetId = 'a'.repeat(64);
    Object.assign(lesson, {
      content: 'Lezione esistente',
      contentBlocks: [{ markdown: 'Lezione esistente', type: 'markdown' }],
      generationWarnings: [
        {
          code: 'lesson_pdf_image_extraction_incomplete',
          pageNumber: 4,
          sourceId: 'source-1',
          stage: 'sources',
        },
      ],
      imageRefs: [{ alt: 'Diagramma', assetId: 'pdf-1' }],
      quiz: [
        {
          correctIndex: 1,
          exerciseType: 'recall',
          options: ['A', 'B', 'C', 'D'],
          question: 'Qual è la risposta?',
        },
      ],
    });
    completedProject.documentAssets = {
      imageCount: 1,
      kind: 'pdf',
      parsedAt: '2026-07-29T20:00:00.000Z',
      usedImages: [
        {
          asset: {
            byteSize: 10,
            hash: assetId,
            id: assetId,
            mediaType: 'image/png',
          },
          id: 'pdf-1',
          sourceOrder: 0,
          textAfter: '',
          textBefore: '',
        },
      ],
    };
    completedProject.researchDossiersBySectionId = {
      'lesson-1': {
        sectionId: 'lesson-1',
        sources: [],
        title: 'Comunicazioni a messaggi',
      },
    };
    const resolveSourceMaterials = vi.fn();
    const services = createLessonGenerationStageServices(
      dependencies({
        loadProjectWithRevision: vi
          .fn()
          .mockResolvedValue({ revision: 4, snapshot: completedProject }),
        resolveSourceMaterials,
      })
    );

    const outcome = await services.prepareLesson(
      stageContext({
        forceRegenerate: false,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      })
    );

    expect(outcome).toMatchObject({
      kind: 'already-completed',
      result: {
        alreadyCompleted: true,
        content: 'Lezione esistente',
        documentAssets: completedProject.documentAssets,
        imageRefs: [{ alt: 'Diagramma', assetId: 'pdf-1' }],
        projectRevision: 4,
        quiz: [expect.objectContaining({ question: 'Qual è la risposta?' })],
        researchDossier: completedProject.researchDossiersBySectionId['lesson-1'],
        warnings: [
          {
            code: 'lesson_pdf_image_extraction_incomplete',
            pageNumber: 4,
            sourceId: 'source-1',
            stage: 'sources',
          },
        ],
      },
    });
    expect(resolveSourceMaterials).not.toHaveBeenCalled();
  });
});
