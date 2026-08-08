import { describe, expect, test, vi } from 'vitest';

import {
  buildCoursePlanState,
  createCoursePlanningStages,
} from '../../src/workflows/courseGenerationPlanning.js';

const youtubeUrl = 'https://www.youtube.com/watch?v=abc';
const webUrl = 'https://example.com/distributed-systems';

const researchState = {
  context: {
    assessmentSummary: 'USER: Voglio capire i sistemi distribuiti.',
    language: 'Italiano',
    profile: {
      context: 'Studente di informatica',
      experienceLevel: 'base',
      goals: 'Capire i fondamenti',
      language: 'Italiano',
      learningStyle: 'esempi',
      topic: 'Sistemi distribuiti',
    },
    sourceNames: [],
    sources: [],
    topic: 'Sistemi distribuiti',
  },
  projectRevision: 2,
  request: { mode: 'learn' as const, projectId: 'project-1', userId: 'user-1' },
  research: {
    web: {
      brief: 'Brief fattuale.',
      sources: [{ note: 'Panoramica', title: 'Fonte web', url: webUrl }],
    },
    youtube: {
      candidates: [
        {
          title: 'Distributed Systems',
          url: youtubeUrl,
          youtubeTranscript: {
            segments: [{ endSeconds: 20, startSeconds: 10, text: 'Messaggi e nodi.' }],
          },
        },
      ],
      context: 'Transcript.',
      rationale: 'Transcript disponibile.',
      status: 'completed' as const,
    },
  },
  stage: 'research' as const,
  strategy: 'learn' as const,
};

const rawLesson = (index: number, sourceUrls: string[] = []) => ({
  description: `Obiettivo della lezione ${index}`,
  guidingQuestions: [`Domanda ${index}`],
  instructionPacks: [],
  keyConcepts: [`Concetto ${index}`],
  miniLab: null,
  prerequisites: index === 1 ? [] : [`Lezione ${index - 1}`],
  simplificationRisks: [`Rischio ${index}`],
  sourceUrls,
  title: `Lezione ${index}`,
  type: 'core' as const,
});

const rawPlan = (sourceUrls: string[] = [youtubeUrl, webUrl]) => ({
  lessonCountReason: 'Otto lezioni coprono i fondamenti senza comprimere i passaggi.',
  modules: [
    {
      description: 'Fondamenti',
      lessons: Array.from({ length: 8 }, (_, index) =>
        rawLesson(index + 1, index === 0 ? sourceUrls : [])
      ),
      title: 'Fondamenti',
      type: 'core' as const,
    },
  ],
  summary: 'Un percorso progressivo.',
  title: 'Sistemi distribuiti',
});

describe('course generation planning', () => {
  test('assigns one deterministic identity shared by plan, syllabus and research lessons', () => {
    const result = buildCoursePlanState(rawPlan(), researchState, '2026-07-30T09:00:00.000Z');

    expect(result.plan.modules[0]?.id).toBe('module-1');
    expect(result.plan.modules[0]?.children[0]).toMatchObject({
      id: 'module-1-lesson-1',
      parentId: 'module-1',
    });
    expect(result.syllabus[0]?.id).toBe('module-1');
    expect(result.syllabus[0]?.children?.[0]?.id).toBe('module-1-lesson-1');
    expect(result.researchCoursePlan?.lessons[0]).toMatchObject({
      id: 'module-1-lesson-1',
      moduleId: 'module-1',
      sourceHints: [
        expect.objectContaining({ url: youtubeUrl, youtubeTranscript: expect.any(Object) }),
        expect.objectContaining({ url: webUrl }),
      ],
    });
  });

  test('supplies the exact citable research URLs to the planning model', async () => {
    const generateObject = vi.fn(async () => rawPlan());
    const stages = createCoursePlanningStages({
      generateObject: generateObject as never,
      readSourceMaterials: vi.fn().mockResolvedValue([]),
    });

    await stages.planLearnCourse({
      attemptNumber: 1,
      config: { models: {} as never } as never,
      execution: { nodeInstanceId: 'plan-learn-course', runId: 'run-1' },
      idempotencyKey: 'plan-key',
      input: researchState,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    const prompt = generateObject.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain(webUrl);
    expect(prompt).toContain(youtubeUrl);
  });

  test('samples the beginning, middle and end of every large source', async () => {
    const firstDescriptor = {
      hash: 'a'.repeat(64),
      id: 'source-1',
      kind: 'text',
      mimeType: 'text/plain',
      name: 'first.txt',
    };
    const secondDescriptor = {
      ...firstDescriptor,
      hash: 'b'.repeat(64),
      id: 'source-2',
      name: 'second.txt',
    };
    const generateObject = vi.fn(async () => ({
      ...rawPlan([]),
      modules: [{ ...rawPlan([]).modules[0], lessons: [rawLesson(1)] }],
    }));
    const stages = createCoursePlanningStages({
      generateObject: generateObject as never,
      readSourceMaterials: vi.fn().mockResolvedValue([
        {
          descriptor: firstDescriptor,
          text: `FIRST_START\n${'a'.repeat(6_000)}\nFIRST_MIDDLE\n${'b'.repeat(6_000)}\nFIRST_END`,
        },
        { descriptor: secondDescriptor, text: 'Second source.' },
      ]),
    });

    await stages.planSourceSetCourse({
      attemptNumber: 1,
      config: { models: {} as never } as never,
      execution: { nodeInstanceId: 'plan-source-set-course', runId: 'run-1' },
      idempotencyKey: 'plan-key',
      input: {
        ...researchState,
        context: { ...researchState.context, sources: [firstDescriptor, secondDescriptor] },
        request: { ...researchState.request, mode: 'document' },
        strategy: 'source-set',
      },
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    const prompt = generateObject.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain('FIRST_START');
    expect(prompt).toContain('FIRST_MIDDLE');
    expect(prompt).toContain('FIRST_END');
  });

  test('keeps research only in the draft that still needs refinement', async () => {
    const source = {
      hash: 'a'.repeat(64),
      id: 'source-1',
      kind: 'markdown',
      mimeType: 'text/markdown',
      name: 'source.md',
    };
    const documentState = {
      ...researchState,
      context: { ...researchState.context, sourceNames: [source.name], sources: [source] },
      request: { ...researchState.request, mode: 'document' as const },
      strategy: 'single-source' as const,
    };
    const generateObject = vi.fn(async () => ({
      ...rawPlan([]),
      modules: [{ ...rawPlan([]).modules[0], lessons: [rawLesson(1)] }],
    }));
    const stages = createCoursePlanningStages({
      generateObject: generateObject as never,
      readSourceMaterials: vi
        .fn()
        .mockResolvedValue([{ descriptor: source, text: 'Source text.' }]),
    });
    const context = {
      attemptNumber: 1,
      config: { models: {} as never } as never,
      execution: { nodeInstanceId: 'draft-source-course', runId: 'run-1' },
      idempotencyKey: 'draft-key',
      input: documentState,
      retryFeedback: '',
      signal: new AbortController().signal,
    };

    const draft = await stages.draftSourceCourse(context);
    const refined = await stages.refineSourceCourse({
      ...context,
      execution: { nodeInstanceId: 'refine-source-course', runId: 'run-1' },
      idempotencyKey: 'refine-key',
      input: draft,
    });

    expect(draft).toHaveProperty('research');
    expect(refined).not.toHaveProperty('research');
    expect(refined.plan).toEqual(draft.plan);
  });

  test('rejects source URLs that were not returned by authoritative research', () => {
    expect(() =>
      buildCoursePlanState(
        rawPlan(['https://www.youtube.com/watch?v=hallucinated']),
        researchState,
        '2026-07-30T09:00:00.000Z'
      )
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: 'course_plan_source_invalid',
          kind: 'corrective',
        }),
      })
    );
  });

  test('rejects a learn plan outside the established lesson range', () => {
    const tooShort = {
      ...rawPlan(),
      modules: [{ ...rawPlan().modules[0], lessons: [rawLesson(1)] }],
    };

    expect(() =>
      buildCoursePlanState(tooShort, researchState, '2026-07-30T09:00:00.000Z')
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({ code: 'course_plan_size_invalid', kind: 'corrective' }),
      })
    );
  });

  test('does not misuse parentId as module membership for document lessons', () => {
    const documentState = {
      ...researchState,
      context: {
        ...researchState.context,
        sourceNames: ['source.md'],
        sources: [
          {
            hash: 'a'.repeat(64),
            id: 'source-1',
            kind: 'markdown',
            mimeType: 'text/markdown',
            name: 'source.md',
          },
        ],
      },
      request: { ...researchState.request, mode: 'document' as const },
      strategy: 'single-source' as const,
    };

    const result = buildCoursePlanState(
      {
        ...rawPlan([]),
        modules: [{ ...rawPlan([]).modules[0], lessons: [rawLesson(1)] }],
      },
      documentState,
      '2026-07-30T09:00:00.000Z'
    );

    expect(result.plan.modules[0]?.children[0]).not.toHaveProperty('parentId');
  });
});
