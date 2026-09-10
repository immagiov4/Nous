import type { CurriculumArtifactRef } from '@shared/curriculum.js';
import {
  DiagnosticSnapshotRefSchema,
  type PriorKnowledgePlanningInput,
} from '@shared/priorKnowledgePlanning.js';
import * as z from 'zod';
import {
  type DiagnosticCollection,
  DiagnosticCollectionSchema,
  validateDiagnosticEvaluation,
} from './priorKnowledgeDiagnosticState.js';

/** Self-contained evidence survives removal of operational workflow logs. */
export const DiagnosticSnapshotSchema = z.object({
  ref: DiagnosticSnapshotRefSchema,
  recordedAt: z.iso.datetime(),
  collection: DiagnosticCollectionSchema,
});
export type DiagnosticSnapshot = z.infer<typeof DiagnosticSnapshotSchema>;

export function diagnosticArtifactRef(
  snapshot: DiagnosticSnapshot,
  artifactId: string
): CurriculumArtifactRef {
  const { diagnosticId: _, ...scope } = snapshot.ref;
  return { ...scope, artifactId };
}

function selfReports(collection: DiagnosticCollection) {
  return collection.passes.flatMap(pass => {
    if (pass.stage.kind !== 'self-assessment' || !pass.submission) return [];
    return pass.submission.answers.map((answer, index) => ({
      selfReportId: `${pass.submission!.requestId}:self-report:${index}`,
      nodeId: answer.itemId,
      response: answer.response,
      stage: pass.stage,
      sourceEventRef: pass.submission!.requestId,
      recordedAt: pass.receivedAt,
    }));
  });
}

function observations(collection: DiagnosticCollection) {
  const tasks = new Map(
    collection.passes.flatMap(pass => pass.tasks.map(task => [task.taskId, task] as const))
  );
  const attempts = new Map(
    collection.passes.flatMap(pass =>
      pass.attempts.map(attempt => [attempt.attemptId, attempt] as const)
    )
  );
  return collection.evaluations.flatMap(revision => {
    validateDiagnosticEvaluation(collection, revision.evaluation);
    return revision.evaluation.interpretations.map((interpretation, index) => {
      const attempt = attempts.get(interpretation.attemptId)!;
      const task = tasks.get(attempt.taskId)!;
      const criterion = task.criteria.find(
        candidate => candidate.criterionId === interpretation.criterionId
      )!;
      return {
        interpretationId: `${revision.revisionId}:interpretation:${index}`,
        interpretation,
        attempt,
        task,
        criterion,
        evaluator: revision.evaluator,
        recordedAt: revision.recordedAt,
        originRef: revision.revisionId,
      };
    });
  });
}

/** Structural projection only: no ranking, mastery propagation or conflict resolution. */
export function projectPriorKnowledge(snapshot: DiagnosticSnapshot): PriorKnowledgePlanningInput {
  const { collection } = snapshot;
  if (!collection.collectionEnd)
    throw new Error('Planning requires a completed diagnostic snapshot.');
  const reports = selfReports(collection);
  const evidence = observations(collection);
  const artifact = (id: string) => diagnosticArtifactRef(snapshot, id);
  return {
    kind: 'collected',
    assessmentRef: snapshot.ref,
    collectionContextRef: artifact('collection-context'),
    planningView: {
      nodes: collection.nodes.map(node => ({
        ...node,
        selfReports: reports
          .filter(report => report.nodeId === node.nodeId)
          .map(report => ({
            selfReportId: report.selfReportId,
            selfReportRef: artifact(report.selfReportId),
          })),
        observations: evidence
          .filter(entry => entry.task.nodeIds.includes(node.nodeId))
          .map(entry => ({
            interpretationId: entry.interpretationId,
            taskId: entry.task.taskId,
            attemptId: entry.attempt.attemptId,
            claimId: entry.task.claim.claimId,
            criterionId: entry.criterion.criterionId,
            claim: entry.task.claim.statement,
            scope: entry.task.claim.scope,
            expectedEvidence: entry.criterion.expectedEvidence,
            observation: entry.interpretation.observation,
            assessment: entry.interpretation.assessment,
            limitations: entry.interpretation.limitations,
            evidenceRef: artifact(entry.interpretationId),
          })),
      })),
      missingInformation: collection.evaluations.flatMap(revision =>
        revision.evaluation.missingInformation.map((gap, index) => ({
          ...gap,
          gapId: `${revision.revisionId}:gap:${index}`,
          originRef: artifact(revision.revisionId),
        }))
      ),
      conflicts: collection.evaluations.flatMap(revision =>
        revision.evaluation.conflicts.map((conflict, index) => ({
          ...conflict,
          conflictId: `${revision.revisionId}:conflict:${index}`,
          originRef: artifact(revision.revisionId),
        }))
      ),
      collectionEnd: {
        eventRef: artifact(collection.collectionEnd.eventRef),
        reason: collection.collectionEnd.reason,
        unresolvedLimitations: collection.collectionEnd.unresolvedLimitations,
      },
    },
  };
}

/** Resolves the entire scoped tuple; IDs from another owner, course or revision are rejected. */
export function resolveDiagnosticArtifact(
  snapshot: DiagnosticSnapshot,
  ref: CurriculumArtifactRef
) {
  const expected = diagnosticArtifactRef(snapshot, ref.artifactId);
  if (
    Object.keys(expected).some(
      key => expected[key as keyof typeof expected] !== ref[key as keyof typeof ref]
    )
  ) {
    throw new Error('Diagnostic artifact scope does not match the retained snapshot.');
  }
  const { collection } = snapshot;
  if (ref.artifactId === 'collection-context')
    return { profile: collection.profile, ...collection.context };
  const node = collection.nodes.find(node => node.nodeId === ref.artifactId);
  if (node) return node;
  for (const pass of collection.passes) {
    const task = pass.tasks.find(task => task.taskId === ref.artifactId);
    if (task)
      return {
        task,
        attempts: pass.attempts.filter(attempt => attempt.taskId === task.taskId),
        receivedAt: pass.receivedAt,
      };
    const attempt = pass.attempts.find(attempt => attempt.attemptId === ref.artifactId);
    if (attempt)
      return {
        attempt,
        task: pass.tasks.find(task => task.taskId === attempt.taskId),
        receivedAt: pass.receivedAt,
      };
  }
  const report = selfReports(collection).find(report => report.selfReportId === ref.artifactId);
  if (report) return { ...report, context: collection.context, profile: collection.profile };
  const evidence = observations(collection).find(
    entry => entry.interpretationId === ref.artifactId
  );
  if (evidence) return { ...evidence, context: collection.context, profile: collection.profile };
  const output = collection.modelOutputs.find(output => output.outputId === ref.artifactId);
  if (output) return output;
  throw new Error('Diagnostic artifact does not exist in the retained snapshot.');
}

/** Includes administered tasks and omissions even when no interpretation cites them. */
export function resolveDiagnosticPlanningEvidence(snapshot: DiagnosticSnapshot) {
  const view = projectPriorKnowledge(snapshot);
  if (view.kind !== 'collected') throw new Error('Expected collected diagnostic evidence.');
  const artifactIds = new Set([
    'collection-context',
    ...snapshot.collection.passes.flatMap(pass => pass.tasks.map(task => task.taskId)),
    ...snapshot.collection.nodes.map(node => node.nodeId),
    ...view.planningView.nodes.flatMap(node => [
      ...node.selfReports.map(report => report.selfReportRef.artifactId),
      ...node.observations.map(observation => observation.evidenceRef.artifactId),
    ]),
    ...view.planningView.conflicts.flatMap(conflict => conflict.relatedItemIds),
  ]);
  return [...artifactIds].map(id => {
    const ref = diagnosticArtifactRef(snapshot, id);
    return { ref, content: resolveDiagnosticArtifact(snapshot, ref) };
  });
}
