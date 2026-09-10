import { randomUUID } from 'node:crypto';
import {
  DIAGNOSTIC_STAGE_EVENT,
  DIAGNOSTIC_SUBMISSION_SIGNAL,
  type DiagnosticStage,
} from '@shared/priorKnowledgeDiagnostic';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { projectCourseInterviewEvents } from '../../src/workflows/courseInterviewApi.js';
import {
  CourseInterviewWorkflowConfigSchema,
  type CourseInterviewWorkflowServices,
  createCourseInterviewWorkflow,
} from '../../src/workflows/courseInterviewWorkflow.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import { materializeWorkflowStart } from '../../src/workflows/materialization.js';
import { saveDiagnosticSnapshot } from '../../src/workflows/persistence/postgresDiagnosticSnapshotStore.js';
import { createPriorKnowledgeDiagnosticModel } from '../../src/workflows/priorKnowledgeDiagnosticModel.js';
import {
  type DiagnosticSnapshot,
  projectPriorKnowledge,
  resolveDiagnosticArtifact,
  resolveDiagnosticPlanningEvidence,
} from '../../src/workflows/priorKnowledgeDiagnosticSnapshot.js';
import { DiagnosticCollectionSchema } from '../../src/workflows/priorKnowledgeDiagnosticState.js';
import { runWorkflowStepClaim } from '../../src/workflows/workflowStepRunner.js';
import {
  claimNextStep,
  createPostgresWorkflowIntegrationContext,
  createStore,
  setupPostgresWorkflowIntegrationContext,
  teardownPostgresWorkflowIntegrationContext,
} from './postgresWorkflowStore.integration.fixture.js';

const context = createPostgresWorkflowIntegrationContext();
const profile = {
  context: 'Study',
  experienceLevel: 'Unverified',
  goals: 'Understand sorted search',
  language: 'English',
  learningStyle: 'Examples',
  topic: 'Binary search',
};

async function createScenario() {
  const { sql, userId, projectId } = context;
  if (!sql) throw new Error('Isolated integration database is required.');
  const [{ incarnation_id: incarnationId }] = await sql<
    { incarnation_id: string }[]
  >`select incarnation_id from public.projects where user_id=${userId} and id=${projectId}`;
  const config = { maxAttempts: 3, timeoutMs: 60_000, models: getGlobalModelConfig() };
  const registry = createWorkflowRegistry();
  const definition = registry.register({
    current: createCourseInterviewWorkflow(
      config,
      12,
      CourseInterviewWorkflowConfigSchema,
      'commit',
      'diagnostic'
    ),
    previous: [createCourseInterviewWorkflow(config, 12)],
  }).current;
  const store = createStore(sql);
  const retained: DiagnosticSnapshot[] = [];
  let generationRef: DiagnosticSnapshot['ref'] | undefined;
  let savedProfile: unknown;
  const model = createPriorKnowledgeDiagnosticModel({
    generateObject: async input => {
      if (input.name === 'prior_knowledge_tree')
        return input.schema.parse({
          title: 'Starting point',
          topics: [{ title: 'Order', scope: 'One comparison', children: [] }],
        });
      const collection = DiagnosticCollectionSchema.parse(JSON.parse(input.prompt).collection);
      const rounds = collection.passes.filter(pass => pass.stage.kind === 'round');
      const interpretations = rounds.flatMap(pass =>
        pass.attempts
          .filter(attempt => attempt.response.kind !== 'not-submitted')
          .map(attempt => ({
            attemptId: attempt.attemptId,
            criterionId: pass.tasks.find(task => task.taskId === attempt.taskId)!.criteria[0]
              .criterionId,
            observation: 'Used the order relation.',
            assessment: 'Supports exclusion in one comparison.',
            limitations: ['Does not establish implementation ability.'],
          }))
      );
      const evaluation = {
        interpretations,
        missingInformation: [
          {
            nodeIds: [collection.nodes[0].nodeId],
            question: 'Can the learner implement the update?',
            reason: 'Not tested by this task.',
          },
        ],
        conflicts: rounds.length
          ? [
              {
                nodeIds: [collection.nodes[0].nodeId],
                relatedItemIds: [collection.nodes[0].nodeId, rounds[0].tasks[0].taskId],
                description: 'Declaration and observed explanation differ in scope.',
              },
            ]
          : [],
      };
      if (rounds.length === 2)
        return input.schema.parse({
          kind: 'complete',
          title: 'Starting point',
          feedback: 'Begin with interval updates.',
          reason: 'No further adequate task changes the starting point.',
          unresolvedLimitations: ['Implementation remains unobserved.'],
          evaluation,
        });
      return input.schema.parse({
        kind: 'round',
        title: 'Explain the comparison',
        evaluation,
        tasks: [
          {
            nodeIds: [collection.nodes[0].nodeId],
            claim: { statement: 'Exclude candidates', scope: 'One sorted comparison' },
            criteria: ['Use the order relation'],
            learnerPrompt: 'Which half can you exclude and why?',
            responseFormatDefinition: { format: 'text' },
            selectionReason: 'Locate the starting point.',
          },
          ...(rounds.length
            ? []
            : [
                {
                  nodeIds: [collection.nodes[0].nodeId],
                  claim: {
                    statement: 'Identify a boundary',
                    scope: 'Recognise a candidate interval',
                  },
                  criteria: ['Select the stated interval'],
                  learnerPrompt: 'Choose the candidate interval.',
                  responseFormatDefinition: {
                    format: 'choice',
                    options: [
                      { id: 'left', text: 'Left half' },
                      { id: 'right', text: 'Right half' },
                    ],
                  },
                  selectionReason: 'Clarify a pertinent doubt.',
                },
              ]),
        ],
      });
    },
  });
  const services: CourseInterviewWorkflowServices = {
    assessTurn: async () => ({
      kind: 'proposal',
      message: 'Approve this course?',
      proposal: profile,
    }),
    discardUnclaimedDraftProject: async () => {},
    saveCourseProfileBeforeCheckpoint: async () => {},
    saveCourseProfile: async input => {
      savedProfile = input.profile;
    },
    startCourseGeneration: async input => {
      generationRef = input.diagnosticRef;
      return { runId: 'generated-course' };
    },
    diagnostic: {
      model,
      readIncarnation: async () => incarnationId,
      saveSnapshot: async (transaction, snapshot) => {
        await saveDiagnosticSnapshot(transaction, snapshot);
        retained.push(snapshot);
      },
    },
  };
  const input = {
    userId,
    projectId,
    mode: 'learn' as const,
    hasReliableSourceContext: false,
    initialMessage: 'Teach binary search.',
  };
  const created = await store.createRun({
    id: randomUUID(),
    userId,
    projectId,
    workflowId: definition.id,
    definitionHash: definition.definitionHash,
    definitionHashVersion: definition.definitionHashVersion,
    requestKey: randomUUID(),
    config,
    input,
    materialization: materializeWorkflowStart(definition, input, { resolvedConfig: config }),
  });
  const runId = created.run.id;
  async function advanceToWait() {
    for (let executed = 0; executed < 40; executed++) {
      const claim = await claimNextStep(store, definition, 'diagnostic-integration');
      if (!claim) return store.getRunState({ userId, runId });
      expect(await runWorkflowStepClaim({ claim, registry, services, store })).toMatchObject({
        status: 'checkpointed',
      });
    }
    throw new Error('Synthetic diagnostic did not settle.');
  }

  return {
    sql,
    userId,
    projectId,
    store,
    runId,
    definition,
    retained,
    advanceToWait,
    get savedProfile() {
      return savedProfile;
    },
    get generationRef() {
      return generationRef;
    },
  };
}

describe
  .skipIf(!context.enabled)
  .sequential('Diagnostic interview through durable signals and immutable evidence', () => {
    let scenario: Awaited<ReturnType<typeof createScenario>>;
    beforeAll(async () => {
      await setupPostgresWorkflowIntegrationContext(context);
      scenario = await createScenario();
    });
    afterAll(() => teardownPostgresWorkflowIntegrationContext(context));
    test('approves course preferences before collection', async () => {
      const { advanceToWait, store, userId, runId, definition } = scenario;
      const state = await advanceToWait();
      expect(state?.waits[0].signalType).toBe('course-decision');
      await store.signals.receive({
        userId,
        runId,
        waitId: state!.waits[0].waitId,
        signalType: 'course-decision',
        requestKey: randomUUID(),
        payload: {
          kind: 'approve',
          coursePlanningControls: { depth: 'less', granularity: 'more' },
          languageProficiency: { language: 'English', level: 'B2' },
        },
        resolveDefinition: () => definition,
      });
    });
    test.each([
      0, 1, 2,
    ])('accepts pass %i atomically and rejects foreign or conflicting signals', async pass => {
      const { advanceToWait, store, userId, runId, definition, sql } = scenario;
      const state = await advanceToWait();
      const event = projectCourseInterviewEvents(state!)
        .filter(event => event.eventType === DIAGNOSTIC_STAGE_EVENT)
        .at(-1)!;
      const { collectionId, stage } = event.payload as {
        collectionId: string;
        stage: DiagnosticStage;
      };
      expect(stage.kind).toBe(pass === 0 ? 'self-assessment' : 'round');
      expect(JSON.stringify(event.payload)).not.toContain('expectedEvidence');
      const answers =
        stage.kind === 'self-assessment'
          ? stage.topics.map(topic => ({
              itemId: topic.id,
              response: { kind: 'self-report', value: 'uncertain' },
            }))
          : stage.kind === 'round'
            ? stage.questions.map((question, index) => ({
                itemId: question.id,
                response: index
                  ? { kind: 'not-submitted' }
                  : { kind: 'text', text: '  The order excludes every smaller candidate.  ' },
              }))
            : [];
      const signal = {
        userId,
        runId,
        waitId: state!.waits[0].waitId,
        signalType: DIAGNOSTIC_SUBMISSION_SIGNAL,
        requestKey: randomUUID(),
        payload: { collectionId, stageId: stage.id, requestId: randomUUID(), answers },
        resolveDefinition: () => definition,
      };
      await expect(store.signals.receive({ ...signal, userId: randomUUID() })).rejects.toThrow();
      await expect(
        store.signals.receive({ ...signal, payload: { ...signal.payload, stageId: 'other-stage' } })
      ).rejects.toThrow();
      await store.signals.receive(signal);
      expect(await store.signals.receive(signal)).toMatchObject({ status: 'replayed' });
      const [{ snapshot: accepted }] = await sql<{ snapshot: DiagnosticSnapshot }[]>`
        select snapshot from public.prior_knowledge_diagnostic_snapshots
        where user_id=${userId} and snapshot->'collection'->'passes' @> ${sql.json([{ submission: signal.payload }])}
      `;
      expect(accepted.collection.passes.at(-1)?.submission).toEqual(signal.payload);
      const receivedAt = accepted.collection.passes.at(-1)?.receivedAt;
      expect(receivedAt).toBeTruthy();
      await expect(
        store.signals.receive({
          ...signal,
          payload: { ...signal.payload, requestId: randomUUID() },
        })
      ).rejects.toThrow();
      await expect(
        store.signals.receive({ ...signal, requestKey: randomUUID() })
      ).rejects.toThrow();
      expect(
        (await store.diagnosticSnapshots.load(userId, accepted.ref))?.collection.passes.at(-1)
          ?.receivedAt
      ).toBe(receivedAt);
    });
    test('resolves evidence and retains it after workflow cleanup', async () => {
      const { advanceToWait, store, userId, runId, retained, sql } = scenario;
      const state = await advanceToWait();
      const { savedProfile, generationRef } = scenario;
      expect(state?.run.status).toBe('completed');
      expect(savedProfile).toMatchObject({
        coursePlanningControls: { depth: 'less', granularity: 'more' },
        languageProficiency: { language: 'English', level: 'B2' },
      });
      expect(generationRef).toEqual(retained.at(-1)!.ref);
      const snapshot = await store.diagnosticSnapshots.load(userId, generationRef!);
      expect(snapshot).not.toBeNull();
      const planning = projectPriorKnowledge(snapshot!);
      if (planning.kind !== 'collected') throw new Error('Expected collected evidence.');
      const node = planning.planningView.nodes[0];
      expect(resolveDiagnosticArtifact(snapshot!, node.selfReports[0].selfReportRef)).toMatchObject(
        {
          response: { kind: 'self-report', value: 'uncertain' },
        }
      );
      expect(resolveDiagnosticArtifact(snapshot!, node.observations[0].evidenceRef)).toMatchObject({
        attempt: { response: { text: '  The order excludes every smaller candidate.  ' } },
        task: { claim: { scope: 'One sorted comparison' } },
      });
      expect(planning.planningView.conflicts.length).toBeGreaterThan(0);
      const omittedTask = snapshot!.collection.passes
        .flatMap(pass => pass.tasks)
        .find(task => task.responseFormatDefinition.format === 'choice');
      expect(
        resolveDiagnosticPlanningEvidence(snapshot!).find(
          entry => entry.ref.artifactId === omittedTask?.taskId
        )?.content
      ).toMatchObject({
        task: { taskId: omittedTask?.taskId },
        attempts: [{ response: { kind: 'not-submitted' } }],
      });
      await expect(
        sql.begin(async transaction => {
          await transaction`set local role authenticated`;
          await transaction`select snapshot from public.prior_knowledge_diagnostic_snapshots`;
        })
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        store.diagnosticSnapshots.load(randomUUID(), generationRef!)
      ).resolves.toBeNull();
      expect(() =>
        resolveDiagnosticArtifact(snapshot!, {
          ...node.observations[0].evidenceRef,
          incarnationId: randomUUID(),
        })
      ).toThrow();
      await sql.begin(transaction => saveDiagnosticSnapshot(transaction, snapshot!));
      await expect(
        sql.begin(transaction =>
          saveDiagnosticSnapshot(transaction, {
            ...snapshot!,
            recordedAt: '2020-01-01T00:00:00.000Z',
          })
        )
      ).rejects.toThrow();
      await sql`delete from public.workflow_runs where id=${runId}`;
      expect(await store.diagnosticSnapshots.load(userId, generationRef!)).toEqual(snapshot);
    });
  });
