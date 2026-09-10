import { expect, test } from 'vitest';
import {
  type DiagnosticSnapshot,
  projectPriorKnowledge,
  resolveDiagnosticArtifact,
  resolveDiagnosticPlanningEvidence,
} from '../../src/workflows/priorKnowledgeDiagnosticSnapshot.js';
import {
  acceptDiagnosticSubmission,
  DiagnosticCollectionSchema,
  validateDiagnosticEvaluation,
} from '../../src/workflows/priorKnowledgeDiagnosticState.js';

const profile = {
  context: 'Studio autonomo',
  experienceLevel: 'Da verificare',
  goals: 'Ricerca binaria',
  language: 'Italiano',
  learningStyle: 'Discorsivo',
  topic: 'Ricerca binaria',
};
const collection = DiagnosticCollectionSchema.parse({
  schemaVersion: 1,
  collectionId: 'collection',
  interviewRunId: 'interview',
  projectId: 'course',
  profile,
  context: { hasReliableSourceContext: false, messages: [] },
  modelOutputs: [
    {
      outputId: 'tree',
      model: 'test',
      providerAttemptRef: 'provider:tree',
      recordedAt: '2026-09-10T12:00:00Z',
      value: '{}',
    },
  ],
  nodes: [
    { nodeId: 'arrays', parentNodeId: null, title: 'Array', scope: 'Indici' },
    { nodeId: 'order', parentNodeId: null, title: 'Ordine', scope: 'Confronti' },
  ],
  passes: [
    {
      stage: {
        kind: 'self-assessment',
        id: 'self',
        title: 'Punto di partenza',
        topics: [
          { id: 'arrays', title: 'Array', parentId: null },
          { id: 'order', title: 'Ordine', parentId: null },
        ],
      },
      tasks: [],
      attempts: [],
    },
  ],
  evaluations: [],
});
const selfReport = acceptDiagnosticSubmission(
  collection,
  {
    collectionId: 'collection',
    stageId: 'self',
    requestId: 'self-request',
    answers: [
      { itemId: 'order', response: { kind: 'not-submitted' } },
      { itemId: 'arrays', response: { kind: 'self-report', value: 'uncertain' } },
    ],
  },
  '2026-09-10T12:00:00Z'
);
test('Uncertainty and omission remain distinct, in administered order', () =>
  expect(selfReport.passes[0].submission.answers).toEqual([
    { itemId: 'arrays', response: { kind: 'self-report', value: 'uncertain' } },
    { itemId: 'order', response: { kind: 'not-submitted' } },
  ]));
test('Self-report creates no performance attempts', () =>
  expect(selfReport.passes[0].attempts).toHaveLength(0));
test('Accepting a submission preserves the original collection', () =>
  expect(collection.passes[0].submission).toBeUndefined());
const tasks = ['answered', 'omitted'].map(taskId => ({
  taskId,
  nodeIds: ['order'],
  claim: { claimId: `${taskId}-claim`, statement: 'Escludere candidati', scope: 'Un confronto' },
  criteria: [
    { criterionId: `${taskId}-criterion`, expectedEvidence: 'Usare la relazione di ordine' },
  ],
  learnerPrompt: 'Quali candidati puoi escludere?',
  responseFormatDefinition: { format: 'text' },
  selectionReason: 'Verificare il punto di partenza',
}));
const awaitingRound = DiagnosticCollectionSchema.parse({
  ...selfReport,
  passes: [
    ...selfReport.passes,
    {
      stage: {
        kind: 'round',
        id: 'round',
        title: 'Un confronto',
        questions: tasks.map(task => ({
          id: task.taskId,
          topic: 'Ordine',
          prompt: task.learnerPrompt,
          format: 'text',
        })),
      },
      tasks,
      attempts: [],
    },
  ],
});
const submitted = acceptDiagnosticSubmission(
  awaitingRound,
  {
    collectionId: 'collection',
    stageId: 'round',
    requestId: 'round-request',
    answers: [
      {
        itemId: 'answered',
        response: {
          kind: 'text',
          text: 'Posso escludere i valori minori del centro se cerco un valore maggiore.',
        },
      },
      { itemId: 'omitted', response: { kind: 'not-submitted' } },
    ],
  },
  '2026-09-10T12:01:00Z'
);
const [answered, omitted] = submitted.passes.at(-1).attempts;
const interpretation = {
  attemptId: answered.attemptId,
  criterionId: 'answered-criterion',
  observation: 'Confronto esplicitato',
  assessment: 'Sostiene il criterio somministrato',
  limitations: ['Non verifica gli aggiornamenti degli indici'],
};
const evaluation = {
  interpretations: [interpretation],
  missingInformation: [
    { nodeIds: ['arrays'], question: 'Aggiornamento degli indici', reason: 'Non somministrato' },
  ],
  conflicts: [],
};
test('planning uses the final cumulative evaluation while historical evidence still resolves', () => {
  const snapshot: DiagnosticSnapshot = {
    ref: {
      userId: 'user',
      projectId: 'course',
      incarnationId: 'incarnation',
      diagnosticId: 'collection',
      revisionId: 'final',
    },
    recordedAt: '2026-09-10T12:02:00Z',
    collection: {
      ...submitted,
      collectionEnd: { eventRef: 'final', reason: 'Enough evidence', unresolvedLimitations: [] },
      evaluations: [
        {
          revisionId: 'before',
          recordedAt: '2026-09-10T12:01:00Z',
          evaluator: 'model',
          evaluation: {
            ...evaluation,
            conflicts: [
              { nodeIds: ['arrays'], relatedItemIds: ['answered'], description: 'Open conflict' },
            ],
          },
        },
        {
          revisionId: 'final',
          recordedAt: '2026-09-10T12:02:00Z',
          evaluator: 'model',
          evaluation: { ...evaluation, missingInformation: [] },
        },
      ],
    },
  };
  const result = projectPriorKnowledge(snapshot);
  if (result.kind !== 'collected') throw new Error('Expected collected');
  expect(result.planningView.nodes[1].observations).toHaveLength(1);
  expect(result.planningView.nodes[0].selfReports).toHaveLength(1);
  expect(result.planningView.nodes[1].selfReports).toHaveLength(0);
  const rawEvidence = resolveDiagnosticPlanningEvidence(snapshot);
  expect(rawEvidence.map(entry => entry.content)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ nodeId: 'order', response: { kind: 'not-submitted' } }),
      expect.objectContaining({
        nodeId: 'arrays',
        response: { kind: 'self-report', value: 'uncertain' },
      }),
    ])
  );
  expect(result.planningView.missingInformation).toEqual([]);
  expect(result.planningView.conflicts).toEqual([]);
  expect(result.planningView.nodes[1].observations[0].interpretationId).toBe(
    'final:interpretation:0'
  );
  expect(
    resolveDiagnosticArtifact(snapshot, {
      ...result.planningView.nodes[1].observations[0].evidenceRef,
      artifactId: 'before:interpretation:0',
    })
  ).toBeTruthy();
});
test('A submitted response can support its administered criterion', () =>
  expect(() => validateDiagnosticEvaluation(submitted, evaluation)).not.toThrow());
test('Conflicts link submitted self-report and task items', () => {
  const conflict = {
    nodeIds: ['arrays'],
    relatedItemIds: ['arrays', 'answered'],
    description: 'The self-report and administered response differ.',
  };
  validateDiagnosticEvaluation(submitted, { ...evaluation, conflicts: [conflict] });
  for (const invalidId of [answered.attemptId, interpretation.criterionId, 'invented']) {
    expect(() =>
      validateDiagnosticEvaluation(submitted, {
        ...evaluation,
        conflicts: [{ ...conflict, relatedItemIds: [invalidId] }],
      })
    ).toThrow();
  }
});
test('An omitted response cannot support an interpretation', () =>
  expect(() =>
    validateDiagnosticEvaluation(submitted, {
      ...evaluation,
      interpretations: [
        { ...interpretation, attemptId: omitted.attemptId, criterionId: 'omitted-criterion' },
      ],
    })
  ).toThrow());
test('An interpretation cannot cite a criterion from another task', () =>
  expect(() =>
    validateDiagnosticEvaluation(submitted, {
      ...evaluation,
      interpretations: [{ ...interpretation, criterionId: 'omitted-criterion' }],
    })
  ).toThrow());
test('Self-report IDs cannot stand in for performance attempts', () =>
  expect(() =>
    validateDiagnosticEvaluation(submitted, {
      ...evaluation,
      interpretations: [{ ...interpretation, attemptId: 'arrays' }],
    })
  ).toThrow());
test('Missing information must refer to known nodes', () =>
  expect(() =>
    validateDiagnosticEvaluation(submitted, {
      ...evaluation,
      missingInformation: [{ nodeIds: ['invented'], question: 'Ignoto', reason: 'Ignoto' }],
    })
  ).toThrow());
test('A submission cannot target another collection', () =>
  expect(() =>
    acceptDiagnosticSubmission(
      awaitingRound,
      { collectionId: 'other', stageId: 'round', requestId: 'wrong', answers: [] },
      '2026-09-10T12:01:00Z'
    )
  ).toThrow());
