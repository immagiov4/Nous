import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import type { ProjectSnapshot, ProjectStore } from '../../src/projects/types.js';
import { resolveLessonSourceMaterials } from '../../src/services/lessonGenerationPreparation.js';
import { resolveLessonVisualModelConfig } from '../../src/services/lessonVisualModelConfig.js';
import {
  createLessonGenerationStageServices,
  type LessonGenerationStageDependencies,
} from '../../src/workflows/lessonGenerationStageServices.js';
import {
  LessonContextStateSchema,
  LessonDraftStateSchema,
  LessonReviewedStateSchema,
  LessonSourcesStateSchema,
  LessonYouTubeStateSchema,
} from '../../src/workflows/lessonGenerationWorkflowContract.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';

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

  test('reads detached original bytes when no document index is available', async () => {
    const store = new InMemoryProjectStore();
    const sourceText = 'Il documento originale descrive la fase luminosa nei tilacoidi.';
    await store.saveProject('user-1', {
      ...project,
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

    await services.researchLesson(stageContext(youtubeState));

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

    const researchState = await services.researchLesson(stageContext(youtubeState));
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
