import * as z from 'zod';

import type { LessonResearchSummary } from './lessonGenerationTypes.js';

const ResearchIdentifierSchema = z.string().min(1);

export const YouTubeCandidateDecisionSchema = z.object({
  decision: z.enum(['rejected', 'selected-source']),
  reason: z.string(),
  url: ResearchIdentifierSchema,
});

export const LessonResearchSummarySchema = z.object({
  avoidOversimplifying: z.array(z.string()),
  controversies: z.array(z.string()),
  difficultSteps: z.array(z.string()),
  factualSummary: z.string(),
  keyExamples: z.array(z.string()),
  recentDevelopments: z.array(z.string()),
  sources: z.array(
    z.object({
      note: z.string(),
      title: ResearchIdentifierSchema,
      url: ResearchIdentifierSchema,
    })
  ),
  youtubeCandidateDecisions: z.array(YouTubeCandidateDecisionSchema).optional(),
}) satisfies z.ZodType<LessonResearchSummary>;

// New model responses always classify the supplied video candidates. The durable
// schema keeps the field optional so historical workflow snapshots remain readable.
export const LessonResearchModelResponseSchema = LessonResearchSummarySchema.extend({
  youtubeCandidateDecisions: z.array(YouTubeCandidateDecisionSchema),
});
