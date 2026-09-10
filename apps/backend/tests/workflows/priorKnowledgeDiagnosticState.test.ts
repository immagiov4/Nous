import assert from 'node:assert/strict';
import { test } from 'vitest';
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
  assert.deepEqual(selfReport.passes[0].submission.answers, [
    { itemId: 'arrays', response: { kind: 'self-report', value: 'uncertain' } },
    { itemId: 'order', response: { kind: 'not-submitted' } },
  ]));
test('Self-report creates no performance attempts', () =>
  assert.equal(selfReport.passes[0].attempts.length, 0));
test('Accepting a submission preserves the original collection', () =>
  assert.equal(collection.passes[0].submission, undefined));
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
test('A submitted response can support its administered criterion', () =>
  validateDiagnosticEvaluation(submitted, evaluation));
test('Conflicts link submitted self-report and task items', () => {
  const conflict = {
    nodeIds: ['arrays'],
    relatedItemIds: ['arrays', 'answered'],
    description: 'The self-report and administered response differ.',
  };
  validateDiagnosticEvaluation(submitted, { ...evaluation, conflicts: [conflict] });
  for (const invalidId of [answered.attemptId, interpretation.criterionId, 'invented']) {
    assert.throws(() =>
      validateDiagnosticEvaluation(submitted, {
        ...evaluation,
        conflicts: [{ ...conflict, relatedItemIds: [invalidId] }],
      })
    );
  }
});
test('An omitted response cannot support an interpretation', () =>
  assert.throws(() =>
    validateDiagnosticEvaluation(submitted, {
      ...evaluation,
      interpretations: [
        { ...interpretation, attemptId: omitted.attemptId, criterionId: 'omitted-criterion' },
      ],
    })
  ));
test('An interpretation cannot cite a criterion from another task', () =>
  assert.throws(() =>
    validateDiagnosticEvaluation(submitted, {
      ...evaluation,
      interpretations: [{ ...interpretation, criterionId: 'omitted-criterion' }],
    })
  ));
test('Self-report IDs cannot stand in for performance attempts', () =>
  assert.throws(() =>
    validateDiagnosticEvaluation(submitted, {
      ...evaluation,
      interpretations: [{ ...interpretation, attemptId: 'arrays' }],
    })
  ));
test('Missing information must refer to known nodes', () =>
  assert.throws(() =>
    validateDiagnosticEvaluation(submitted, {
      ...evaluation,
      missingInformation: [{ nodeIds: ['invented'], question: 'Ignoto', reason: 'Ignoto' }],
    })
  ));
test('A submission cannot target another collection', () =>
  assert.throws(() =>
    acceptDiagnosticSubmission(
      awaitingRound,
      { collectionId: 'other', stageId: 'round', requestId: 'wrong', answers: [] },
      '2026-09-10T12:01:00Z'
    )
  ));
