import * as z from 'zod';
import { CurriculumArtifactRefSchema } from './curriculum';

const ArtifactRefSchema = CurriculumArtifactRefSchema.strip();

const Text = z.string().min(1);
export const DiagnosticSnapshotRefSchema = ArtifactRefSchema.omit({
  artifactId: true,
}).extend({ diagnosticId: Text });

const ObservationSchema = z.object({
  interpretationId: Text,
  taskId: Text,
  attemptId: Text,
  claimId: Text,
  criterionId: Text,
  claim: Text,
  scope: Text,
  expectedEvidence: Text,
  observation: Text,
  assessment: Text,
  limitations: z.array(Text),
  evidenceRef: ArtifactRefSchema,
});

/** References identify retained evidence, not inferred levels or curriculum prerequisites. */
export const PriorKnowledgePlanningInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-collected'), reason: Text }),
  z.object({
    kind: z.literal('collected'),
    assessmentRef: DiagnosticSnapshotRefSchema,
    collectionContextRef: ArtifactRefSchema,
    planningView: z.object({
      nodes: z.array(
        z.object({
          nodeId: Text,
          parentNodeId: Text.nullable(),
          title: Text,
          scope: Text,
          selfReports: z.array(
            z.object({
              selfReportId: Text,
              selfReportRef: ArtifactRefSchema,
            })
          ),
          observations: z.array(ObservationSchema),
        })
      ),
      missingInformation: z.array(
        z.object({
          gapId: Text,
          nodeIds: z.array(Text),
          question: Text,
          reason: Text,
          originRef: ArtifactRefSchema,
        })
      ),
      conflicts: z.array(
        z.object({
          conflictId: Text,
          nodeIds: z.array(Text),
          relatedItemIds: z.array(Text),
          description: Text,
          originRef: ArtifactRefSchema,
        })
      ),
      collectionEnd: z.object({
        eventRef: ArtifactRefSchema,
        reason: Text,
        unresolvedLimitations: z.array(Text),
      }),
    }),
  }),
]);

export type DiagnosticSnapshotRef = z.infer<typeof DiagnosticSnapshotRefSchema>;
export type PriorKnowledgePlanningInput = z.infer<typeof PriorKnowledgePlanningInputSchema>;
