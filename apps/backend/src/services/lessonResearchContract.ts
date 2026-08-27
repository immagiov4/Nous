import * as z from 'zod';

import type { LessonResearchSummary } from './lessonGenerationTypes.js';

const createLessonResearchSchemaSet = (identifierSchema: z.ZodString) => {
  const youtubeCandidateDecisionSchema = z.object({
    decision: z.enum(['rejected', 'selected-source']),
    reason: z.string(),
    url: identifierSchema,
  });
  const lessonResearchSummarySchema = z.object({
    avoidOversimplifying: z.array(z.string()),
    controversies: z.array(z.string()),
    difficultSteps: z.array(z.string()),
    factualSummary: z.string(),
    keyExamples: z.array(z.string()),
    recentDevelopments: z.array(z.string()),
    sources: z.array(
      z.object({
        note: z.string(),
        title: identifierSchema,
        url: identifierSchema,
      })
    ),
    youtubeCandidateDecisions: z.array(youtubeCandidateDecisionSchema).optional(),
  });
  return { lessonResearchSummarySchema, youtubeCandidateDecisionSchema };
};

const CurrentLessonResearchSchemas = createLessonResearchSchemaSet(z.string().min(1).regex(/\S/));
const PreviousLessonResearchSchemas = createLessonResearchSchemaSet(z.string().min(1));

export const YouTubeCandidateDecisionSchema =
  CurrentLessonResearchSchemas.youtubeCandidateDecisionSchema;

export const LessonResearchSummarySchema =
  CurrentLessonResearchSchemas.lessonResearchSummarySchema satisfies z.ZodType<LessonResearchSummary>;

// Historical workflow definitions retain their original schema so persisted runs
// continue resolving by the definition hash recorded when they started.
export const PreviousLessonResearchSummarySchema =
  PreviousLessonResearchSchemas.lessonResearchSummarySchema satisfies z.ZodType<LessonResearchSummary>;

export const PreviousYouTubeCandidateDecisionSchema =
  PreviousLessonResearchSchemas.youtubeCandidateDecisionSchema;

// New model responses always classify the supplied video candidates. The durable
// schema keeps the field optional so historical workflow snapshots remain readable.
export const LessonResearchModelResponseSchema = LessonResearchSummarySchema.extend({
  youtubeCandidateDecisions: z.array(YouTubeCandidateDecisionSchema),
});
