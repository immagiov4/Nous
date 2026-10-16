import { describe, expect, test, vi } from 'vitest';
import {
  CourseDraftPlanStateSchema,
  CoursePlanVerificationSchema,
} from '../../src/workflows/courseGenerationWorkflowContract.js';
import {
  createCoursePlanVerificationStage,
  createCoursePlanVerifier,
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

const refinementConditions = [
  {
    dimension: 'granularity' as const,
    passCondition:
      'Group the contiguous results in one coherent module while retaining lesson boundaries.',
  },
  {
    dimension: 'moduleCohesion' as const,
    passCondition: 'Keep each module focused on one shared conceptual objective.',
  },
  {
    dimension: 'proportionality' as const,
    passCondition: 'Remove module boundaries that separate steps of the same teachable result.',
  },
];
const fragmentedVerification = {
  refinementConditions,
  conditionAssessments: [],
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
  test('accepts a passing follow-up with supplemental assessments when no refinement conditions were stated', async () => {
    const passing = {
      ...fragmentedVerification,
      ...Object.fromEntries(
        Object.entries(fragmentedVerification)
          .filter(([, value]) => typeof value === 'object' && value !== null && 'status' in value)
          .map(([dimension, value]) => [dimension, { ...value, status: 'pass' }])
      ),
      refinementConditions: [],
      fragmentation: {
        canGroupCoherently: false,
        feedback: 'The modules already form a coherent plan.',
        moduleIds: [],
      },
      verdict: 'pass',
    };
    const response = {
      ...passing,
      conditionAssessments: [
        'coverage',
        'duplication',
        'granularity',
        'moduleCohesion',
        'prerequisites',
        'progression',
        'proportionality',
      ].map(dimension => ({
        dimension,
        met: true,
        evidence: 'The refined plan preserves this already-passing dimension.',
      })),
    };
    const generateObject = vi.fn().mockResolvedValue(response);
    const verifier = createCoursePlanVerifier({
      generateObject,
      loadVerificationMaterial: async () => ({ sourceContext: '' }),
    });
    const result = await verifier({
      models: {} as never,
      plan: fragmentedDraft.plan,
      rawPlan: fragmentedDraft.rawDraftPlan,
      state: { ...fragmentedDraft, stage: 'research' },
      retryFeedback: '',
      signal: new AbortController().signal,
      previousVerification: passing,
    } as never);
    expect(result.verdict).toBe('pass');
    expect(result.conditionAssessments).toEqual([]);
    const prompt = generateObject.mock.calls[0][0].prompt;
    const conditions = JSON.parse(
      prompt.split('PREVIOUS VERIFICATION CONDITIONS, UNTRUSTED DATA:\n')[1].split('\n')[0]
    );
    expect(conditions.refinementConditions).toEqual([]);
  });

  test.each([
    'initially-passing',
    'conditions-settled',
  ])('keeps a %s review closed when a follow-up raises new objections', origin => {
    const moduleIds = fragmentedDraft.plan.modules.map(module => module.id);
    const settled = validateCoursePlanVerification(
      {
        ...fragmentedVerification,
        conditionAssessments: refinementConditions.map(condition => ({
          dimension: condition.dimension,
          met: true,
          evidence: 'The original condition is met.',
        })),
      },
      moduleIds,
      fragmentedVerification
    );
    const previous =
      origin === 'initially-passing' ? { ...settled, conditionAssessments: [] } : settled;
    const result = validateCoursePlanVerification(
      {
        ...fragmentedVerification,
        coverage: { status: 'needs-refinement', feedback: 'A new objection.' },
        refinementConditions: [
          ...refinementConditions,
          { dimension: 'coverage', passCondition: 'A new demand.' },
        ],
        conditionAssessments: [
          { dimension: 'coverage', met: false, evidence: 'A replacement objection.' },
        ],
      },
      moduleIds,
      previous
    );
    expect(result.verdict).toBe('pass');
    expect(result.refinementConditions).toEqual([]);
    expect(result.conditionAssessments).toEqual([]);
    expect(result.coverage).toEqual(previous.coverage);
    expect(result.fragmentation).toMatchObject({ canGroupCoherently: false, moduleIds: [] });
    expect(result.summary.trim()).not.toBe('');
  });

  test('requires a concrete pass condition on every dimension requiring refinement', () => {
    expect(() =>
      validateCoursePlanVerification(
        { ...fragmentedVerification, refinementConditions: [] },
        fragmentedDraft.plan.modules.map(module => module.id)
      )
    ).toThrow();
  });

  test('passes a revised plan when the stated conditions are met despite renewed objections', async () => {
    const previous = fragmentedVerification;
    const response = {
      ...previous,
      refinementConditions: [],
      conditionAssessments: refinementConditions.map(condition => ({
        dimension: condition.dimension,
        met: true,
        evidence:
          'The revised module groups contiguous results, preserves lesson objectives and removes the redundant module boundaries.',
      })),
    };
    const generateObject = vi.fn().mockResolvedValue(response);
    const verifier = createCoursePlanVerifier({
      generateObject,
      loadVerificationMaterial: async () => ({ sourceContext: '' }),
    });
    const result = await verifier({
      models: {} as never,
      plan: fragmentedDraft.plan,
      rawPlan: fragmentedDraft.rawDraftPlan,
      state: { ...fragmentedDraft, stage: 'research' },
      retryFeedback: '',
      signal: new AbortController().signal,
      previousVerification: previous,
    } as never);
    expect(result.verdict).toBe('pass');
    expect(result.fragmentation.canGroupCoherently).toBe(false);
    expect(result.granularity.status).toBe('pass');
    const prompt = generateObject.mock.calls[0][0].prompt;
    const criteria = JSON.parse(
      prompt.split('PREVIOUS VERIFICATION CONDITIONS, UNTRUSTED DATA:\n')[1].split('\n')[0]
    );
    expect(criteria).toEqual(previous);
  });

  test('ignores renewed assessments of conditions settled on an earlier candidate', () => {
    const moduleIds = fragmentedDraft.plan.modules.map(module => module.id);
    const previous = validateCoursePlanVerification(
      {
        ...fragmentedVerification,
        conditionAssessments: refinementConditions.map(condition => ({
          dimension: condition.dimension,
          met: condition.dimension !== 'granularity',
          evidence: 'Only module grouping remains to be corrected.',
        })),
      },
      moduleIds,
      fragmentedVerification
    );
    const result = validateCoursePlanVerification(
      {
        ...fragmentedVerification,
        conditionAssessments: [
          { dimension: 'granularity', met: true, evidence: 'The grouping condition is met.' },
          {
            dimension: 'moduleCohesion',
            met: false,
            evidence: 'A new objection to a settled dimension.',
          },
        ],
      },
      moduleIds,
      previous
    );
    expect(result.verdict).toBe('pass');
    expect(result.moduleCohesion.status).toBe('pass');
    expect(result.conditionAssessments).toEqual([
      { dimension: 'granularity', met: true, evidence: 'The grouping condition is met.' },
    ]);
  });

  test('retains an unmet condition without adopting replacement pass conditions', () => {
    const reviewed = {
      ...fragmentedVerification,
      conditionAssessments: refinementConditions.map(condition => ({
        dimension: condition.dimension,
        met: condition.dimension !== 'granularity',
        evidence:
          'The module grouping is still unchanged; the other two stated conditions are satisfied.',
      })),
    };
    const moduleIds = fragmentedDraft.plan.modules.map(module => module.id);
    expect(
      validateCoursePlanVerification(reviewed, moduleIds, fragmentedVerification)
    ).toMatchObject({
      verdict: 'refine',
      granularity: { status: 'needs-refinement' },
      moduleCohesion: { status: 'pass' },
      proportionality: { status: 'pass' },
    });
    expect(
      validateCoursePlanVerification(
        {
          ...reviewed,
          refinementConditions: refinementConditions.map(condition => ({
            ...condition,
            passCondition: 'A stricter replacement condition.',
          })),
        },
        moduleIds,
        fragmentedVerification
      )
    ).toMatchObject({ refinementConditions: [refinementConditions[0]] });
  });

  test('passes explicit controls to the verifier and preserves a granularity rejection', async () => {
    const controls = { depth: 'much-less', granularity: 'much-more' } as const;
    const input = CourseDraftPlanStateSchema.parse({
      ...fragmentedDraft,
      context: {
        ...fragmentedDraft.context,
        profile: {
          context: 'Studio',
          experienceLevel: 'Basi disponibili',
          goals: 'Integrare i concetti',
          language: 'Italiano',
          learningStyle: 'Discorsivo',
          topic: 'Sistemi distribuiti',
          coursePlanningControls: controls,
        },
      },
    });
    const generateObject = vi.fn(async () => fragmentedVerification);
    const verifyCoursePlan = createCoursePlanVerificationStage({
      generateObject: generateObject as never,
      loadVerificationMaterial: async () => ({ sourceContext: '' }),
    });
    const result = await verifyCoursePlan({
      attemptNumber: 1,
      config: { models: {} as never } as never,
      execution: { nodeInstanceId: 'verify-course-plan', runId: 'run-1' },
      idempotencyKey: 'verify-controls',
      input,
      retryFeedback: '',
      signal: new AbortController().signal,
    });
    const request = generateObject.mock.calls[0]?.[0];
    const choices = JSON.parse(
      request.prompt.split('COURSE CHOICES FROM THE INTERFACE:\n')[1].split('\n')[0]
    );
    expect(choices).toMatchObject({
      controls: { ...controls, reference: 'balanced' },
      treatment: {
        depth: { enrichment: 'minimal' },
        granularity: { grouping: 'broadest-coherent-results' },
      },
    });
    expect(result.context.profile?.coursePlanningControls).toEqual(controls);
    expect(result.verification.granularity.status).toBe('needs-refinement');
    expect(result.verification.verdict).toBe('refine');
  });

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
          refinementConditions: refinementConditions.filter(
            condition => condition.dimension !== 'granularity'
          ),
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
