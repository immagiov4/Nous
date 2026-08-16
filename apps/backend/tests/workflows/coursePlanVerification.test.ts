import { describe, expect, test, vi } from 'vitest';
import {
  CourseDraftPlanStateSchema,
  CoursePlanVerificationSchema,
} from '../../src/workflows/courseGenerationWorkflowContract.js';
import {
  createCoursePlanVerificationStage,
  validateCoursePlanVerification,
} from '../../src/workflows/coursePlanVerification.js';

const lesson = (index: number) => ({
  description: `Obiettivo ${index}`,
  id: `module-${index}-lesson-1`,
  isCompleted: false,
  kind: 'lesson' as const,
  title: `Concetto ${index}`,
  type: 'core' as const,
});

const rawLesson = (index: number) => ({
  description: `Obiettivo ${index}`,
  guidingQuestions: [`Domanda ${index}`],
  instructionPacks: [],
  keyConcepts: [`Concetto ${index}`],
  miniLab: null,
  prerequisites: index === 1 ? [] : [`Concetto ${index - 1}`],
  simplificationRisks: [],
  sourceUrls: [],
  title: `Concetto ${index}`,
  type: 'core' as const,
});

const fragmentedDraft = CourseDraftPlanStateSchema.parse({
  context: {
    assessmentSummary: 'Imparare i concetti come percorso coerente.',
    language: 'Italiano',
    profile: null,
    sourceNames: [],
    sources: [],
    topic: 'Sistemi distribuiti',
  },
  plan: {
    applicationExercisePlanningStatus: 'not-run',
    modules: Array.from({ length: 6 }, (_, index) => ({
      children: [lesson(index + 1)],
      description: `Frammento ${index + 1}`,
      id: `module-${index + 1}`,
      title: `Frammento ${index + 1}`,
      type: 'core' as const,
    })),
    summary: 'Sei concetti strettamente collegati separati in sei moduli.',
    title: 'Sistemi distribuiti',
  },
  projectRevision: 1,
  rawDraftPlan: {
    lessonCountReason: 'La bozza separa ogni concetto in un modulo.',
    modules: Array.from({ length: 6 }, (_, index) => ({
      description: `Frammento ${index + 1}`,
      lessons: [rawLesson(index + 1)],
      title: `Frammento ${index + 1}`,
      type: 'core' as const,
    })),
    summary: 'Sei concetti strettamente collegati separati in sei moduli.',
    title: 'Sistemi distribuiti',
  },
  request: { mode: 'learn', projectId: 'project-1', userId: 'user-1' },
  research: {
    web: { brief: 'I concetti formano una progressione unica.', sources: [] },
    youtube: { candidates: [], context: '', rationale: '', status: 'unavailable' },
  },
  researchCoursePlan: null,
  stage: 'plan-draft',
  strategy: 'learn',
  syllabus: [],
});

const fragmentedVerification = {
  coverage: { feedback: 'I concetti principali sono presenti.', status: 'pass' as const },
  duplication: { feedback: 'Nessuna duplicazione.', status: 'pass' as const },
  fragmentation: {
    canGroupCoherently: true,
    feedback: 'I moduli descrivono passaggi contigui che possono formare un modulo coerente.',
    moduleIds: fragmentedDraft.plan.modules.map(module => module.id),
  },
  granularity: {
    feedback: 'La separazione in moduli monolezione frammenta una sola progressione concettuale.',
    status: 'needs-refinement' as const,
  },
  moduleCohesion: { feedback: 'La coesione va ricostruita.', status: 'needs-refinement' as const },
  prerequisites: { feedback: 'Prerequisiti coerenti.', status: 'pass' as const },
  progression: { feedback: 'Ordine recuperabile nel raffinamento.', status: 'pass' as const },
  proportionality: {
    feedback: 'Troppi confini di modulo rispetto ai nuclei insegnabili.',
    status: 'needs-refinement' as const,
  },
  summary: 'Raggruppare i concetti contigui in moduli coesi.',
  verdict: 'refine' as const,
};

describe('course plan verification', () => {
  test('flags a fragmented many-single-lesson module plan for semantic refinement', async () => {
    const generateObject = vi.fn(async () => fragmentedVerification);
    const verifyCoursePlan = createCoursePlanVerificationStage({
      generateObject: generateObject as never,
      loadVerificationMaterial: vi.fn(async () => ({ sourceContext: '' })),
    });

    const result = await verifyCoursePlan({
      attemptNumber: 1,
      config: { maxAttempts: 3, models: {} as never, timeoutMs: 60_000 },
      execution: { nodeInstanceId: 'verify-course-plan', runId: 'run-1' },
      idempotencyKey: 'verify-key',
      input: fragmentedDraft,
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(result.verification).toEqual(fragmentedVerification);
    expect(result.verification.fragmentation).toMatchObject({
      canGroupCoherently: true,
      moduleIds: fragmentedDraft.plan.modules.map(module => module.id),
    });
    expect(result.verification.verdict).toBe('refine');
  });

  test('rejects blank verifier explanations before refinement', () => {
    const candidates = [
      {
        ...fragmentedVerification,
        coverage: { ...fragmentedVerification.coverage, feedback: '   ' },
      },
      {
        ...fragmentedVerification,
        fragmentation: { ...fragmentedVerification.fragmentation, feedback: '\t' },
      },
      { ...fragmentedVerification, summary: '\n' },
    ];

    for (const candidate of candidates) {
      expect(() => CoursePlanVerificationSchema.parse(candidate)).toThrow();
    }
  });

  test('rejects a passing verdict that leaves coherent fragmentation unflagged', () => {
    expect(() =>
      validateCoursePlanVerification(
        CoursePlanVerificationSchema.parse({
          ...fragmentedVerification,
          granularity: { feedback: 'Nessuna modifica.', status: 'pass' },
          verdict: 'pass',
        }),
        fragmentedDraft.plan.modules.map(module => module.id)
      )
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: 'course_plan_verification_invalid',
          kind: 'corrective',
        }),
      })
    );
  });

  test('rejects invented or duplicated fragmented module IDs', () => {
    const moduleIds = fragmentedDraft.plan.modules.map(module => module.id);

    expect(() =>
      validateCoursePlanVerification(
        CoursePlanVerificationSchema.parse({
          ...fragmentedVerification,
          fragmentation: {
            ...fragmentedVerification.fragmentation,
            moduleIds: [moduleIds[0], moduleIds[0], 'invented-module'],
          },
        }),
        moduleIds
      )
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({ code: 'course_plan_verification_invalid' }),
      })
    );
  });
});
