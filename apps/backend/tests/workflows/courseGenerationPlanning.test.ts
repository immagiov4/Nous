import { COURSE_CONTROL_POSITIONS } from '@shared/coursePlanningControls';
import { describe, expect, test, vi } from 'vitest';

import {
  buildCourseDraftPlanState,
  buildCoursePlanOutput,
  buildCoursePlanState,
  createCoursePlanningStages,
  requirePassingRefinedVerification,
} from '../../src/workflows/courseGenerationPlanning.js';
import { CoursePlanVerificationStateSchema } from '../../src/workflows/courseGenerationWorkflowContract.js';
import { createCoursePlanVerifier } from '../../src/workflows/coursePlanVerification.js';
import { WorkflowStepError } from '../../src/workflows/retryPolicy.js';
import type { WorkflowProviderEffectExecutor } from '../../src/workflows/types.js';

const immediateProviderEffect: WorkflowProviderEffectExecutor = {
  run: async ({ operation, outputSchema }) => outputSchema.parse(await operation()),
};

const createPersistedProviderEffect = () => {
  const requestedKeys: string[] = [];
  const results = new Map<string, unknown>();
  const providerEffect: WorkflowProviderEffectExecutor = {
    run: async ({ key, operation, outputSchema }) => {
      requestedKeys.push(key);
      const persisted = results.get(key);
      if (persisted !== undefined) return outputSchema.parse(persisted);
      const output = outputSchema.parse(await operation());
      results.set(key, output);
      return output;
    },
  };
  return { providerEffect, requestedKeys };
};

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

const verification = {
  refinementConditions: [],
  conditionAssessments: [],
  coverage: { feedback: 'Copertura adeguata.', status: 'pass' as const },
  duplication: { feedback: 'Nessuna duplicazione.', status: 'pass' as const },
  fragmentation: {
    canGroupCoherently: false,
    feedback: 'La struttura non e frammentata.',
    moduleIds: [],
  },
  granularity: { feedback: 'Granularita adeguata.', status: 'pass' as const },
  moduleCohesion: { feedback: 'Moduli coesi.', status: 'pass' as const },
  prerequisites: { feedback: 'Prerequisiti coerenti.', status: 'pass' as const },
  progression: { feedback: 'Progressione coerente.', status: 'pass' as const },
  proportionality: { feedback: 'Proporzioni adeguate.', status: 'pass' as const },
  summary: 'Il piano puo essere raffinato.',
  verdict: 'pass' as const,
};

describe('course generation planning', () => {
  test.each([
    'One concept at a time. Keep technical details.',
    '',
  ])('carries explicit course teaching preferences into the lesson instructions: %j', teachingPreferences => {
    const state = {
      ...researchState,
      context: {
        ...researchState.context,
        profile: { ...researchState.context.profile, teachingPreferences },
      },
    };
    const output = buildCoursePlanOutput(rawPlan(), state, '2026-09-08T12:00:00Z');
    expect(output.plan.generationNotes).toBe(teachingPreferences);
    expect(
      buildCoursePlanOutput(rawPlan(), researchState, '2026-09-08T12:00:00Z').plan.generationNotes
    ).toBeUndefined();
  });
  test('rejects whitespace-only required raw course text', () => {
    expect(() =>
      buildCoursePlanState(
        {
          ...rawPlan(),
          title: '   ',
        },
        researchState,
        '2026-07-30T09:00:00.000Z'
      )
    ).toThrow();
  });

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
      verifyRefinedPlan: vi.fn(async () => verification),
    });

    await stages.draftCoursePlan({
      attemptNumber: 1,
      config: { models: {} as never } as never,
      execution: { nodeInstanceId: 'draft-course-plan', runId: 'run-1' },
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
    const generatedPlan = {
      ...rawPlan([]),
      modules: [{ ...rawPlan([]).modules[0], lessons: [rawLesson(1)] }],
    };
    const generateObject = vi.fn(async () => generatedPlan);
    const stages = createCoursePlanningStages({
      generateObject: generateObject as never,
      readSourceMaterials: vi.fn().mockResolvedValue([
        {
          descriptor: firstDescriptor,
          text: `FIRST_START\n${'a'.repeat(6_000)}\nFIRST_MIDDLE\n${'b'.repeat(6_000)}\nFIRST_END`,
        },
        { descriptor: secondDescriptor, text: 'Second source.' },
      ]),
      verifyRefinedPlan: vi.fn(async () => verification),
    });

    await stages.draftCoursePlan({
      attemptNumber: 1,
      config: { models: {} as never } as never,
      execution: { nodeInstanceId: 'draft-course-plan', runId: 'run-1' },
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

  test.each(
    COURSE_CONTROL_POSITIONS
  )('preserves %s controls and the original draft through refinement', async granularity => {
    const controls = { depth: 'less' as const, granularity };
    const source = {
      hash: 'a'.repeat(64),
      id: 'source-1',
      kind: 'markdown',
      mimeType: 'text/markdown',
      name: 'source.md',
    };
    const documentState = {
      ...researchState,
      context: {
        ...researchState.context,
        profile: { ...researchState.context.profile, coursePlanningControls: controls },
        sourceNames: [source.name],
        sources: [source],
      },
      request: { ...researchState.request, mode: 'document' as const },
      strategy: 'single-source' as const,
    };
    const draftGeneratedPlan = {
      ...rawPlan([]),
      modules: [{ ...rawPlan([]).modules[0], lessons: [rawLesson(1)] }],
    };
    const refinedGeneratedPlan = {
      ...draftGeneratedPlan,
      summary: 'Progressione raffinata dai fondamenti alle conseguenze operative.',
    };
    const generateObject = vi
      .fn()
      .mockResolvedValueOnce(draftGeneratedPlan)
      .mockResolvedValueOnce(refinedGeneratedPlan);
    const verifyRefinedPlan = vi.fn(async () => verification);
    const stages = createCoursePlanningStages({
      generateObject: generateObject as never,
      readSourceMaterials: vi
        .fn()
        .mockResolvedValue([{ descriptor: source, text: 'Source text.' }]),
      verifyRefinedPlan,
    });
    const context = {
      attemptNumber: 1,
      config: { models: {} as never } as never,
      execution: { nodeInstanceId: 'draft-course-plan', runId: 'run-1' },
      idempotencyKey: 'draft-key',
      input: documentState,
      providerEffect: immediateProviderEffect,
      retryFeedback: '',
      signal: new AbortController().signal,
    };

    const draft = await stages.draftCoursePlan(context);
    const verified = CoursePlanVerificationStateSchema.parse({
      ...draft,
      stage: 'plan-verification',
      verification,
    });
    const refined = await stages.refineCoursePlan({
      ...context,
      execution: { nodeInstanceId: 'refine-course-plan', runId: 'run-1' },
      idempotencyKey: 'refine-key',
      input: verified,
    });

    expect(draft).toHaveProperty('research');
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(draft.rawDraftPlan).toEqual(draftGeneratedPlan);
    expect(refined.plan).toEqual(draft.plan);
    expect(refined.verification).toEqual(verification);
    expect(verifyRefinedPlan).toHaveBeenCalledOnce();
    expect(verifyRefinedPlan.mock.calls[0]?.[0].previousVerification).toEqual(
      verified.verification
    );
    expect(refined.refinedPlan.plan.summary).toBe(refinedGeneratedPlan.summary);
    expect(refined.refinedVerification).toEqual(verification);
    expect(refined.rawRefinedPlan).toEqual(refinedGeneratedPlan);
    expect(refined.context.profile?.coursePlanningControls).toEqual(controls);
    expect(
      verifyRefinedPlan.mock.calls[0]?.[0].state.context.profile.coursePlanningControls
    ).toEqual(controls);
    for (const [request] of generateObject.mock.calls) {
      const choices = JSON.parse(
        request.prompt.split('COURSE CHOICES FROM THE INTERFACE:\n')[1].split('\n')[0]
      );
      expect(choices.controls).toEqual({ ...controls, reference: 'source' });
    }
  });

  test('retries refinement when the refined candidate still fails semantic verification', () => {
    const rejectedRawPlan = rawPlan();
    const rejectedPlan = buildCoursePlanOutput(
      rejectedRawPlan,
      researchState,
      '2026-07-30T09:00:00.000Z'
    ).plan;
    const rejectedVerification = {
      ...verification,
      granularity: { feedback: 'La struttura resta frammentata.', status: 'needs-refinement' },
      refinementConditions: [
        {
          dimension: 'granularity' as const,
          passCondition: 'Group the contiguous results in one coherent module.',
        },
      ],
      verdict: 'refine' as const,
    };
    let thrown: unknown;

    try {
      requirePassingRefinedVerification({
        plan: rejectedPlan,
        rawPlan: rejectedRawPlan,
        verification: rejectedVerification,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkflowStepError);
    const failure = (thrown as WorkflowStepError).failure;
    expect(failure).toMatchObject({
      code: 'course_plan_refinement_incomplete',
      kind: 'corrective',
    });
    expect(JSON.parse(failure.feedback ?? '')).toEqual({
      rejectedCandidate: {
        modules: rejectedPlan.modules.map((module, rawModuleIndex) => ({
          id: module.id,
          rawModuleIndex,
          title: module.title,
        })),
        rawPlan: rejectedRawPlan,
      },
      verification: rejectedVerification,
    });
  });

  test.each([
    false,
    true,
  ])('closes satisfied conditions across corrective refinement attempts with an invalid review: %s', async invalidReview => {
    const initialVerification = {
      ...verification,
      granularity: { status: 'needs-refinement' as const, feedback: 'Narrow the activity scope.' },
      prerequisites: { status: 'needs-refinement' as const, feedback: 'Declare entry knowledge.' },
      refinementConditions: [
        { dimension: 'granularity' as const, passCondition: 'Name one core activity.' },
        { dimension: 'prerequisites' as const, passCondition: 'Declare IP network knowledge.' },
      ],
      verdict: 'refine' as const,
    };
    const reviewModel = vi.fn().mockResolvedValueOnce({
      ...verification,
      verdict: 'refine',
      conditionAssessments: [
        { dimension: 'granularity', met: false, evidence: 'The activity remains broad.' },
        { dimension: 'prerequisites', met: true, evidence: 'IP networks are declared.' },
      ],
    });
    if (invalidReview) reviewModel.mockResolvedValueOnce(verification);
    reviewModel.mockResolvedValueOnce({
      ...verification,
      conditionAssessments: [
        { dimension: 'granularity', met: true, evidence: 'One core activity is named.' },
      ],
    });
    const stages = createCoursePlanningStages({
      generateObject: vi.fn().mockResolvedValue(rawPlan()) as never,
      readSourceMaterials: vi.fn().mockResolvedValue([]),
      verifyRefinedPlan: createCoursePlanVerifier({
        generateObject: reviewModel as never,
        loadVerificationMaterial: async () => ({ sourceContext: '' }),
      }),
    });
    const input = CoursePlanVerificationStateSchema.parse({
      ...buildCourseDraftPlanState(rawPlan(), researchState, '2026-07-30T09:00:00.000Z'),
      stage: 'plan-verification',
      verification: initialVerification,
    });
    const context = {
      config: { models: {} as never } as never,
      execution: { nodeInstanceId: 'refine-course-plan', runId: 'run-1' },
      idempotencyKey: 'refine-key',
      input,
      providerEffect: immediateProviderEffect,
      signal: new AbortController().signal,
    };
    let failure = await stages
      .refineCoursePlan({
        ...context,
        attemptNumber: 1,
        retryFeedback: '',
      })
      .catch(error => error);
    expect(failure).toBeInstanceOf(WorkflowStepError);
    if (invalidReview) {
      failure = await stages
        .refineCoursePlan({
          ...context,
          attemptNumber: 2,
          retryFeedback: (failure as WorkflowStepError).failure.feedback ?? '',
          retryFeedbackSourceAttemptNumber: 1,
        })
        .catch(error => error);
      expect((failure as WorkflowStepError).failure.code).toBe('course_plan_verification_invalid');
    }
    const result = await stages.refineCoursePlan({
      ...context,
      attemptNumber: invalidReview ? 3 : 2,
      retryFeedback: (failure as WorkflowStepError).failure.feedback ?? '',
      retryFeedbackSourceAttemptNumber: invalidReview ? 2 : 1,
    });
    expect(result.refinedVerification.verdict).toBe('pass');
    expect(result.refinedVerification.prerequisites.status).toBe('pass');
    expect(reviewModel).toHaveBeenCalledTimes(invalidReview ? 3 : 2);
  });

  test('persists provider effects per corrective refinement while replaying operational retries', async () => {
    const rejectedVerification = {
      ...verification,
      coverage: { feedback: 'Manca un concetto richiesto.', status: 'needs-refinement' as const },
      refinementConditions: [
        {
          dimension: 'coverage' as const,
          passCondition: 'Include the missing required concept in a lesson objective.',
        },
      ],
      verdict: 'refine' as const,
    };
    const correctedRawPlan = {
      ...rawPlan(),
      summary: 'Il percorso corretto copre anche il concetto precedentemente mancante.',
    };
    const generateObject = vi
      .fn()
      .mockResolvedValueOnce(rawPlan())
      .mockResolvedValueOnce(correctedRawPlan);
    const verifyRefinedPlan = vi
      .fn()
      .mockResolvedValueOnce(rejectedVerification)
      .mockResolvedValueOnce(verification);
    const stages = createCoursePlanningStages({
      generateObject: generateObject as never,
      readSourceMaterials: vi.fn().mockResolvedValue([]),
      verifyRefinedPlan,
    });
    const draft = buildCourseDraftPlanState(rawPlan(), researchState, '2026-07-30T09:00:00.000Z');
    const input = CoursePlanVerificationStateSchema.parse({
      ...draft,
      stage: 'plan-verification',
      verification: rejectedVerification,
    });
    const { providerEffect, requestedKeys } = createPersistedProviderEffect();
    const attemptContext = {
      config: { models: {} as never } as never,
      execution: { nodeInstanceId: 'refine-course-plan', runId: 'run-1' },
      idempotencyKey: 'refine-key',
      input,
      providerEffect,
      signal: new AbortController().signal,
    };

    const firstFailure = await stages
      .refineCoursePlan({ ...attemptContext, attemptNumber: 1, retryFeedback: '' })
      .catch(error => error);
    expect(firstFailure).toBeInstanceOf(WorkflowStepError);

    await expect(
      stages.refineCoursePlan({ ...attemptContext, attemptNumber: 1, retryFeedback: '' })
    ).rejects.toBeInstanceOf(WorkflowStepError);
    expect(generateObject).toHaveBeenCalledOnce();
    expect(verifyRefinedPlan).toHaveBeenCalledOnce();

    const corrected = await stages.refineCoursePlan({
      ...attemptContext,
      attemptNumber: 2,
      retryFeedback: (firstFailure as WorkflowStepError).failure.feedback ?? '',
      retryFeedbackSourceAttemptNumber: 1,
    });
    const operationalReplay = await stages.refineCoursePlan({
      ...attemptContext,
      attemptNumber: 3,
      retryFeedback: (firstFailure as WorkflowStepError).failure.feedback ?? '',
      retryFeedbackSourceAttemptNumber: 1,
    });

    expect(corrected.rawRefinedPlan.summary).toBe(correctedRawPlan.summary);
    expect(corrected.refinedVerification).toEqual(verification);
    expect(operationalReplay.rawRefinedPlan).toEqual(corrected.rawRefinedPlan);
    expect(operationalReplay.refinedVerification).toEqual(corrected.refinedVerification);
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(verifyRefinedPlan).toHaveBeenCalledTimes(2);
    expect(requestedKeys).toEqual([
      'generate-refined-plan',
      'verify-refined-plan:criteria-v1',
      'generate-refined-plan',
      'verify-refined-plan:criteria-v1',
      'generate-refined-plan:correction:1',
      'verify-refined-plan:criteria-v1:correction:1',
      'generate-refined-plan:correction:1',
      'verify-refined-plan:criteria-v1:correction:1',
    ]);
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
