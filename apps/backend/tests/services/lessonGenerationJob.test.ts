import { describe, expect, test, vi } from 'vitest';

import type { GlobalModelConfig } from '../../src/config/modelConfig.js';
import { subscribeToProjectRevisions } from '../../src/projects/projectEvents.js';
import { ProjectRevisionConflictError } from '../../src/projects/projectRevision.js';
import type { GenerationJob } from '../../src/services/generationJobs.js';
import { createLessonGenerationHandler } from '../../src/services/lessonGenerationJob.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';

const snapshot = {
  activeSectionId: 'lesson-other',
  createdAt: '2026-07-26T10:00:00.000Z',
  documentIndex: {
    chunks: [
      { id: 'chunk-1', text: 'La fotosintesi converte energia luminosa.' },
      { id: 'chunk-2', text: 'Contesto non assegnato.' },
    ],
    kind: 'pdf-text-index',
  },
  id: 'project-1',
  isLearnMode: false,
  lastOpenedAt: '2026-07-26T10:00:00.000Z',
  learningPlan: {
    modules: [
      {
        children: [
          {
            description: 'Processo biologico',
            id: 'lesson-1',
            isCompleted: false,
            kind: 'lesson',
            primaryChunkIds: ['chunk-1'],
            title: 'Fotosintesi',
          },
        ],
        id: 'module-1',
        title: 'Biologia',
      },
    ],
    title: 'Biologia',
  },
  source: { file: { name: 'biologia.pdf' }, kind: 'pdf' },
  sourceKind: 'document' as const,
  state: 'library',
  updatedAt: '2026-07-26T10:00:00.000Z',
  version: '4.1',
};

const lessonDraft = {
  contentBlocks: [
    { type: 'markdown' as const, markdown: '## Energia\n\nLa fotosintesi converte la luce.' },
    {
      type: 'inline-quiz' as const,
      quiz: {
        exerciseType: 'application-card',
        question: 'Che cosa cambia senza luce?',
        options: ['A', 'B', 'C', 'D'],
        correctIndex: 0,
      },
    },
  ],
  generatedVisuals: [],
  imageRefs: [],
  learningAids: [
    {
      anchorHeading: 'Energia',
      content: 'Pigmento che assorbe luce.',
      kind: 'definition' as const,
      title: 'Clorofilla',
    },
  ],
  researchSummary: {
    avoidOversimplifying: [],
    controversies: [],
    difficultSteps: ['Distinguere energia e materia.'],
    factualSummary: 'La fotosintesi converte energia luminosa.',
    keyExamples: ['Foglia esposta alla luce.'],
    recentDevelopments: [],
    sources: [],
  },
};

const visualPlan = {
  altText: 'Schema del flusso energetico.',
  anchorHeading: 'Energia',
  complexity: 'moderate' as const,
  concept: 'Flusso energetico',
  coverage: 'complete_synthesis' as const,
  coverageRationale: 'Collega luce, clorofilla e produzione di energia.',
  factualRequirements: ['La luce viene assorbita dalla clorofilla.'],
  interactionLevel: 'none' as const,
  pedagogicalGoal: 'Mostrare la sequenza causale.',
  reason: 'La relazione è più chiara in forma visuale.',
  requiresDepiction: false,
  slotId: 'visual-energy',
  title: 'Flusso della fotosintesi',
  visualDirection: 'Tre nodi collegati da frecce.',
  visualType: 'structural_svg' as const,
};

const emptyYouTubeResearch = async () => ({
  context: '',
  discoveredVideoCount: 0,
  rationale: 'Nessun video.',
  videoCandidates: [],
});

const researchLesson = async () => lessonDraft.researchSummary;

const job: GenerationJob = {
  attemptCount: 1,
  createdAt: '2026-07-26T12:00:00.000Z',
  dedupeKey: 'lesson:project-1:lesson-1',
  id: 'job-1',
  kind: 'lesson',
  payload: { projectId: 'project-1', sectionId: 'lesson-1' },
  projectId: 'project-1',
  stage: 'queued',
  status: 'running',
  updatedAt: '2026-07-26T12:00:00.000Z',
  userId: 'local-user',
};

describe('lesson generation job', () => {
  test('generates from explicitly mapped chunks and persists before completion', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', snapshot);
    const generate = vi.fn(async input => {
      await input.onProgressStage?.('quiz');
      await input.onProgressStage?.('verification');
      return lessonDraft;
    });
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });
    const revisionEvents: unknown[] = [];
    const unsubscribe = subscribeToProjectRevisions('local-user', event =>
      revisionEvents.push(event)
    );

    const stages: string[] = [];
    const result = await run(job, new AbortController().signal, async stage => {
      stages.push(stage);
    });
    unsubscribe();
    const persisted = await store.loadProject('local-user', 'project-1');
    const lesson = persisted?.learningPlan?.modules?.[0]?.children?.[0];

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceContext: expect.stringContaining('La fotosintesi converte energia luminosa.'),
      })
    );
    expect(lesson?.content).toContain('La fotosintesi converte la luce.');
    expect(lesson?.contentBlocks).toHaveLength(2);
    expect(lesson?.learningAids).toHaveLength(1);
    expect(persisted?.activeSectionId).toBe('lesson-other');
    expect(persisted?.state).toBe('library');
    expect(persisted?.researchDossiersBySectionId?.['lesson-1']).toMatchObject({
      sources: [{ title: 'biologia.pdf' }],
    });
    expect(revisionEvents).toHaveLength(1);
    expect(stages).toEqual(['sources', 'structure', 'drafting', 'quiz', 'verification']);
    expect(result).toMatchObject({
      projectId: 'project-1',
      projectRevision: 2,
      sectionId: 'lesson-1',
    });
  });

  test('loads detached original document bytes when no document index is available', async () => {
    const store = new InMemoryProjectStore();
    const sourceText = 'Il documento originale descrive la fase luminosa nei tilacoidi.';
    await store.saveProject('local-user', {
      ...snapshot,
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
    const generate = vi.fn(async () => lessonDraft);
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(job, new AbortController().signal);

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceContext: expect.stringContaining(sourceText),
      })
    );
    expect(
      (await store.loadProject('local-user', 'project-1'))?.researchDossiersBySectionId?.[
        'lesson-1'
      ]
    ).toMatchObject({ sources: [{ title: 'appunti-biologia.txt' }] });
  });

  test('does not include a neighboring chunk or source label from another document', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', {
      ...snapshot,
      documentIndex: {
        chunks: [
          { id: 'chunk-1', sourceId: 'source-a', text: 'Contenuto selezionato A.' },
          { id: 'chunk-2', sourceId: 'source-b', text: 'Contaminazione dal documento B.' },
        ],
        kind: 'pdf-text-index',
      },
      source: {
        file: { name: 'a.pdf' },
        kind: 'pdf',
        sources: [
          {
            file: { data: '', mimeType: 'application/pdf', name: 'a.pdf' },
            id: 'source-a',
            name: 'a.pdf',
          },
          {
            file: { data: '', mimeType: 'application/pdf', name: 'b.pdf' },
            id: 'source-b',
            name: 'b.pdf',
          },
        ],
      },
    });
    const generate = vi.fn(async () => lessonDraft);
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(job, new AbortController().signal);

    const sourceContext = generate.mock.calls[0]?.[0]?.sourceContext || '';
    expect(sourceContext).toContain('Contenuto selezionato A.');
    expect(sourceContext).not.toContain('Contaminazione dal documento B.');
    expect(
      (await store.loadProject('local-user', 'project-1'))?.researchDossiersBySectionId?.[
        'lesson-1'
      ]
    ).toMatchObject({ sources: [{ title: 'a.pdf' }] });
  });

  test('passes sublesson, parent, profile, syllabus, and research-plan context to generation', async () => {
    const store = new InMemoryProjectStore();
    const contextualSnapshot = structuredClone(snapshot);
    const contextualModule = contextualSnapshot.learningPlan.modules[0];
    expect(contextualModule).toBeDefined();
    if (!contextualModule) throw new Error('Expected contextual test module');
    contextualModule.children = [
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
        primaryChunkIds: ['chunk-1'],
        title: 'Approfondimento',
      },
    ];
    Object.assign(contextualSnapshot, {
      researchCoursePlan: {
        lessons: [{ guidingQuestions: ['Come interagisce la luce?'], id: 'lesson-deep' }],
      },
      syllabus: [{ children: [{ contextPrompt: 'Syllabus specifico', id: 'lesson-deep' }] }],
      userProfile: { language: 'Italiano', topic: 'Biologia' },
    });
    await store.saveProject('local-user', contextualSnapshot);
    const generate = vi.fn(async () => lessonDraft);
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(
      {
        ...job,
        dedupeKey: 'lesson:project-1:lesson-deep',
        payload: { projectId: 'project-1', sectionId: 'lesson-deep' },
      },
      new AbortController().signal
    );

    const context = generate.mock.calls[0]?.[0]?.pedagogicalContext || '';
    expect(context).toContain('Collega il testo selezionato ai fotoni.');
    expect(context).toContain('Il parent spiega le basi della luce.');
    expect(context).toContain('Biologia');
    expect(context).toContain('Syllabus specifico');
    expect(context).toContain('Come interagisce la luce?');
  });

  test('extracts mapped PDF image candidates and persists only the selected assets', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', {
      ...snapshot,
      documentIndex: {
        chunks: [
          {
            id: 'chunk-1',
            pageEnd: 4,
            pageStart: 3,
            text: 'La fotosintesi converte energia luminosa.',
          },
        ],
        kind: 'pdf-text-index',
      },
      source: {
        file: {
          data: Buffer.from('pdf bytes for the test double').toString('base64'),
          mimeType: 'application/pdf',
          name: 'biologia.pdf',
        },
        kind: 'pdf',
      },
    });
    const extractedImage = {
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
      hash: '1234567890abcdef1234567890abcdef',
      id: 'pdf-img-001',
      mimeType: 'image/png',
      pageNumber: 3,
      sizeBytes: 5,
      textAfter: 'Fase oscura',
      textBefore: 'Schema della foglia',
      textCurrent: 'Cloroplasto',
    };
    const extractImages = vi.fn(async () => [extractedImage]);
    const generate = vi.fn(async input => ({
      ...lessonDraft,
      imageRefs: [
        {
          alt: 'Schema di un cloroplasto',
          anchorHeading: 'Energia',
          assetId: input.imageCandidates[0]?.id || '',
          caption: 'Il cloroplasto e le fasi della fotosintesi.',
        },
      ],
    }));
    const run = createLessonGenerationHandler({
      captionImage: async () => 'Schema chiaro di un cloroplasto.',
      extractImages,
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(job, new AbortController().signal);

    expect(extractImages).toHaveBeenCalledWith(
      expect.stringMatching(/^data:application\/pdf;base64,/u),
      36,
      [3, 4],
      expect.any(AbortSignal)
    );
    const persisted = await store.loadProject('local-user', 'project-1');
    expect(persisted?.learningPlan?.modules?.[0]?.children?.[0]?.imageRefs).toEqual([
      expect.objectContaining({ assetId: 'pdf-img-1234567890abcdef12345678' }),
    ]);
    expect(persisted?.documentAssets).toMatchObject({
      imageCount: 1,
      kind: 'pdf',
      usedImages: [
        expect.objectContaining({
          dataUrl: extractedImage.dataUrl,
          id: 'pdf-img-1234567890abcdef12345678',
        }),
      ],
    });
  });

  test('preserves PDF assets still referenced by other lessons', async () => {
    const store = new InMemoryProjectStore();
    const multiLessonSnapshot = structuredClone(snapshot);
    const multiLessonModule = multiLessonSnapshot.learningPlan.modules[0];
    expect(multiLessonModule).toBeDefined();
    if (!multiLessonModule) throw new Error('Expected multi-lesson test module');
    multiLessonModule.children.push({
      id: 'lesson-2',
      imageRefs: [{ assetId: 'asset-other' }],
      kind: 'lesson',
      title: 'Altra lezione',
    });
    const currentLesson = multiLessonModule.children[0];
    expect(currentLesson).toBeDefined();
    if (!currentLesson) throw new Error('Expected current test lesson');
    Object.assign(currentLesson, {
      imageRefs: [{ assetId: 'asset-current' }],
    });
    Object.assign(multiLessonSnapshot, {
      documentAssets: {
        imageCount: 2,
        kind: 'pdf',
        parsedAt: '2026-07-26T10:00:00.000Z',
        usedImages: [
          {
            dataUrl: 'data:image/png;base64,Y3VycmVudA==',
            id: 'asset-current',
            mimeType: 'image/png',
            sourceOrder: 1,
            textAfter: '',
            textBefore: '',
          },
          {
            dataUrl: 'data:image/png;base64,b3RoZXI=',
            id: 'asset-other',
            mimeType: 'image/png',
            sourceOrder: 2,
            textAfter: '',
            textBefore: '',
          },
        ],
      },
    });
    await store.saveProject('local-user', multiLessonSnapshot);
    const run = createLessonGenerationHandler({
      generate: async () => lessonDraft,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(job, new AbortController().signal);

    expect((await store.loadProject('local-user', 'project-1'))?.documentAssets).toMatchObject({
      usedImages: [expect.objectContaining({ id: 'asset-other' })],
    });
  });

  test('uses the artifact renderer and preserves a retry plan when rendering fails', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', snapshot);
    const draftWithVisual = {
      ...lessonDraft,
      contentBlocks: [
        lessonDraft.contentBlocks[0],
        { slotId: visualPlan.slotId, type: 'generated-visual' as const },
        lessonDraft.contentBlocks[1],
      ],
      generatedVisuals: [visualPlan],
    };
    const renderVisual = vi.fn(async () => null);
    const run = createLessonGenerationHandler({
      generate: async () => draftWithVisual,
      getConfig: async () =>
        ({ artifactModel: 'artifact-model', aiProvider: 'openrouter' }) as GlobalModelConfig,
      renderVisual,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(job, new AbortController().signal);

    const lesson = (await store.loadProject('local-user', 'project-1'))?.learningPlan?.modules?.[0]
      ?.children?.[0];
    expect(renderVisual).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ artifactModel: 'artifact-model' }),
        plan: visualPlan,
      })
    );
    expect(lesson?.generatedVisuals).toEqual([]);
    expect(lesson?.contentBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          retryPlan: expect.objectContaining({ concept: visualPlan.concept }),
          slotId: visualPlan.slotId,
          type: 'generated-visual',
        }),
      ])
    );
  });

  test('keeps at most three quiz pauses and three generated visual slots', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', snapshot);
    const plans = Array.from({ length: 4 }, (_, index) => ({
      ...visualPlan,
      slotId: `visual-${index + 1}`,
    }));
    const quizBlock = lessonDraft.contentBlocks[1];
    const contentBlocks = plans.flatMap((plan, index) => [
      {
        markdown: `## Passaggio ${index + 1}\n\nSpiegazione didattica ${index + 1}.`,
        type: 'markdown' as const,
      },
      { ...quizBlock, quiz: { ...quizBlock.quiz, question: `Domanda ${index + 1}` } },
      { slotId: plan.slotId, type: 'generated-visual' as const },
    ]);
    const run = createLessonGenerationHandler({
      generate: async () => ({ ...lessonDraft, contentBlocks, generatedVisuals: plans }),
      getConfig: async () => ({}) as GlobalModelConfig,
      renderVisual: async () => ({
        code: '<svg xmlns="http://www.w3.org/2000/svg"><text>Schema</text></svg>',
        kind: 'svg',
      }),
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(job, new AbortController().signal);

    const lesson = (await store.loadProject('local-user', 'project-1'))?.learningPlan?.modules?.[0]
      ?.children?.[0];
    expect(lesson?.contentBlocks?.filter(block => block.type === 'inline-quiz')).toHaveLength(3);
    expect(lesson?.contentBlocks?.filter(block => block.type === 'generated-visual')).toHaveLength(
      3
    );
    expect(lesson?.generatedVisuals).toHaveLength(3);
  });

  test('persists validated YouTube chapters from the transcript source', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', snapshot);
    const generate = vi.fn(async input => ({
      ...lessonDraft,
      contentBlocks: [
        lessonDraft.contentBlocks[0],
        {
          clips: [
            {
              endSeconds: 75,
              sourceIndex: input.sources.findIndex(source => source.url?.includes('youtube.com')),
              startSeconds: 30,
              title: 'La foglia assorbe la luce',
            },
          ],
          type: 'youtube-clips' as const,
        },
        lessonDraft.contentBlocks[1],
      ],
    }));
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: async () => ({
        ...lessonDraft.researchSummary,
        youtubeCandidateDecisions: [
          {
            decision: 'selected-source' as const,
            reason: 'Il transcript mostra il processo descritto dalla lezione.',
            url: 'https://www.youtube.com/watch?v=test',
          },
        ],
      }),
      researchYouTube: async () => ({
        context: 'Transcript',
        discoveredVideoCount: 1,
        rationale: 'Un video con transcript.',
        videoCandidates: [
          {
            ranges: [{ endSeconds: 90, startSeconds: 0 }],
            title: 'Fotosintesi osservata',
            transcript: '[00:30] La foglia assorbe la luce.',
            url: 'https://www.youtube.com/watch?v=test',
          },
        ],
      }),
      store,
    });

    await run(job, new AbortController().signal);
    const persisted = await store.loadProject('local-user', 'project-1');
    const lesson = persisted?.learningPlan?.modules?.[0]?.children?.[0];

    expect(lesson?.contentBlocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'youtube-clips' })])
    );
    expect(persisted?.researchDossiersBySectionId?.['lesson-1']).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ title: 'Fotosintesi osservata' }),
      ]),
    });
  });

  test('uses the planned fallback YouTube query only when the specific query finds no videos', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', snapshot);
    const planYouTube = vi.fn(async () => ({
      fallbackQuery: 'fotosintesi',
      focusConcept: 'fase luminosa',
      specificQuery: 'fase luminosa cloroplasto',
    }));
    const researchYouTube = vi.fn(emptyYouTubeResearch);
    const run = createLessonGenerationHandler({
      generate: async () => lessonDraft,
      getConfig: async () => ({}) as GlobalModelConfig,
      planYouTube,
      research: researchLesson,
      researchYouTube,
      store,
    });

    await run(job, new AbortController().signal);

    expect(planYouTube).toHaveBeenCalledOnce();
    expect(researchYouTube.mock.calls.map(call => call[0])).toEqual([
      'fase luminosa cloroplasto',
      'fotosintesi',
    ]);
  });

  test('only selected YouTube transcripts reach lesson writing and persisted sources', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', snapshot);
    const selectedUrl = 'https://www.youtube.com/watch?v=selected';
    const rejectedUrl = 'https://www.youtube.com/watch?v=rejected';
    const generate = vi.fn(async () => lessonDraft);
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: async () => ({
        ...lessonDraft.researchSummary,
        youtubeCandidateDecisions: [
          { decision: 'selected-source' as const, reason: 'Pertinente.', url: selectedUrl },
          { decision: 'rejected' as const, reason: 'Non pertinente.', url: rejectedUrl },
        ],
      }),
      researchYouTube: async () => ({
        context: 'Transcript candidati',
        discoveredVideoCount: 2,
        rationale: 'Due candidati.',
        videoCandidates: [
          {
            ranges: [{ endSeconds: 60, startSeconds: 0 }],
            title: 'Video selezionato',
            transcript: '[00:00] Contenuto pertinente.',
            url: selectedUrl,
          },
          {
            ranges: [{ endSeconds: 60, startSeconds: 0 }],
            title: 'Video rifiutato',
            transcript: '[00:00] Contenuto fuori tema.',
            url: rejectedUrl,
          },
        ],
      }),
      store,
    });

    await run(job, new AbortController().signal);

    const lessonSources = generate.mock.calls[0]?.[0]?.sources || [];
    expect(lessonSources.some(source => source.url === selectedUrl)).toBe(true);
    expect(lessonSources.some(source => source.url === rejectedUrl)).toBe(false);
    const persistedSources = (await store.loadProject('local-user', 'project-1'))
      ?.researchDossiersBySectionId?.['lesson-1']?.sources as Array<{ url?: string }>;
    expect(persistedSources.some(source => source.url === selectedUrl)).toBe(true);
    expect(persistedSources.some(source => source.url === rejectedUrl)).toBe(false);
  });

  test('passes prerequisite source gaps into targeted research without altering normal lessons', async () => {
    const store = new InMemoryProjectStore();
    const prerequisiteSnapshot = structuredClone(snapshot);
    const lesson = prerequisiteSnapshot.learningPlan.modules[0]?.children[0];
    if (!lesson) throw new Error('Expected prerequisite test lesson.');
    lesson.type = 'prerequisite';
    await store.saveProject('local-user', prerequisiteSnapshot);
    const coverage = vi.fn(async () => ({
      missingTopics: ['Ruolo della clorofilla'],
      needsResearch: true,
    }));
    const research = vi.fn(researchLesson);
    const run = createLessonGenerationHandler({
      coverage,
      generate: async () => lessonDraft,
      getConfig: async () => ({}) as GlobalModelConfig,
      research,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(job, new AbortController().signal);

    expect(coverage).toHaveBeenCalledOnce();
    expect(research).toHaveBeenCalledWith(
      expect.objectContaining({ coverageGaps: ['Ruolo della clorofilla'] })
    );
  });

  test('retries only the final project patch after a revision conflict', async () => {
    class ConflictOnceStore extends InMemoryProjectStore {
      patchCalls = 0;

      override async patchProject(...args: Parameters<InMemoryProjectStore['patchProject']>) {
        this.patchCalls += 1;
        if (this.patchCalls === 1) throw new ProjectRevisionConflictError();
        return super.patchProject(...args);
      }
    }
    const store = new ConflictOnceStore();
    await store.saveProject('local-user', snapshot);
    const generate = vi.fn(async () => lessonDraft);
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(job, new AbortController().signal);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.patchCalls).toBe(2);
  });

  test('preserves a dossier written concurrently before the bounded persistence retry', async () => {
    class ConcurrentPatchStore extends InMemoryProjectStore {
      patchCalls = 0;

      override async patchProject(...args: Parameters<InMemoryProjectStore['patchProject']>) {
        this.patchCalls += 1;
        if (this.patchCalls === 1) {
          await super.patchProject(args[0], args[1], {
            researchDossiersBySectionId: {
              'lesson-other': { factualSummary: 'Concurrent dossier' },
            },
          });
          throw new ProjectRevisionConflictError();
        }
        return super.patchProject(...args);
      }
    }
    const store = new ConcurrentPatchStore();
    await store.saveProject('local-user', snapshot);
    const run = createLessonGenerationHandler({
      generate: async () => lessonDraft,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(job, new AbortController().signal);

    expect(
      (await store.loadProject('local-user', 'project-1'))?.researchDossiersBySectionId
    ).toMatchObject({
      'lesson-1': { factualSummary: 'La fotosintesi converte energia luminosa.' },
      'lesson-other': { factualSummary: 'Concurrent dossier' },
    });
    expect(store.patchCalls).toBe(2);
  });

  test('stops after one project revision retry', async () => {
    class AlwaysConflictingStore extends InMemoryProjectStore {
      patchCalls = 0;

      override async patchProject() {
        this.patchCalls += 1;
        throw new ProjectRevisionConflictError();
      }
    }
    const store = new AlwaysConflictingStore();
    await store.saveProject('local-user', snapshot);
    const generate = vi.fn(async () => lessonDraft);
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await expect(run(job, new AbortController().signal)).rejects.toBeInstanceOf(
      ProjectRevisionConflictError
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.patchCalls).toBe(2);
  });

  test('fails instead of completing when the lesson is removed during generation', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', snapshot);
    const generate = vi.fn(async () => {
      const withoutLesson = structuredClone(snapshot);
      const module = withoutLesson.learningPlan.modules[0];
      expect(module).toBeDefined();
      if (!module) throw new Error('Expected test module');
      module.children = [];
      await store.saveProject('local-user', withoutLesson);
      return lessonDraft;
    });
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await expect(run(job, new AbortController().signal)).rejects.toThrow(
      'Lesson was removed before generated content could be saved.'
    );
    expect(
      (await store.loadProject('local-user', 'project-1'))?.researchDossiersBySectionId?.[
        'lesson-1'
      ]
    ).toBeUndefined();
  });

  test('does not regenerate a force job already persisted before runner recovery', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', snapshot);
    const forceJob = {
      ...job,
      dedupeKey: `${job.dedupeKey}:regenerate:request-1`,
      payload: { ...job.payload, forceRegenerate: true },
    };
    const generate = vi.fn(async () => lessonDraft);
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    await run(forceJob, new AbortController().signal);
    await run(forceJob, new AbortController().signal);

    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('does not regenerate a lesson already completed by another request', async () => {
    const store = new InMemoryProjectStore();
    const completed = structuredClone(snapshot);
    const lesson = completed.learningPlan.modules[0]?.children[0];
    if (lesson) lesson.content = 'Persisted lesson';
    await store.saveProject('local-user', completed);
    const generate = vi.fn();
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      research: researchLesson,
      researchYouTube: emptyYouTubeResearch,
      store,
    });

    const result = await run(job, new AbortController().signal);

    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alreadyCompleted: true, projectRevision: 1 });
  });
});
