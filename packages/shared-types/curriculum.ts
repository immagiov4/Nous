import * as z from 'zod';

const identifier = z.string().min(1);
const description = z.string().min(1);

/** Identifies a course independently of positional lesson IDs or project recreation. */
export const CurriculumRefSchema = z.strictObject({
  userId: identifier,
  projectId: identifier,
  incarnationId: identifier,
  curriculumId: identifier,
});
export type CurriculumRef = z.infer<typeof CurriculumRefSchema>;

/** The owning subsystem must resolve this reference to an immutable retained artifact. */
export const CurriculumArtifactRefSchema = CurriculumRefSchema.omit({
  curriculumId: true,
}).extend({ artifactId: identifier, revisionId: identifier });
export type CurriculumArtifactRef = z.infer<typeof CurriculumArtifactRefSchema>;

const ConceptDefinitionSchema = z.strictObject({
  userId: identifier,
  conceptId: identifier,
  definition: description,
  scope: description,
  origin: CurriculumArtifactRefSchema,
});
export type ConceptDefinition = z.infer<typeof ConceptDefinitionSchema>;

export const CurriculumEntityRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('concept'),
    curriculum: CurriculumRefSchema,
    conceptId: identifier,
  }),
  z.strictObject({
    kind: z.literal('objective'),
    curriculum: CurriculumRefSchema,
    objectiveId: identifier,
  }),
]);
export type CurriculumEntityRef = z.infer<typeof CurriculumEntityRefSchema>;

const motivation = { reason: description, origin: CurriculumArtifactRefSchema };
const supportRef = z.strictObject({
  kind: z.enum(['diagnostic-mapping', 'cross-course-alignment']),
  mappingId: identifier,
});
export type CurriculumSupportRef = z.infer<typeof supportRef>;

/** Local IDs in the aggregate are qualified by its `ref`; external references carry their scope. */
export const CourseCurriculumSchema = z.strictObject({
  formatVersion: z.literal(1),
  ref: CurriculumRefSchema,
  planningInputRef: CurriculumArtifactRefSchema,
  conceptIds: z.array(identifier),
  objectives: z.array(
    z.strictObject({
      objectiveId: identifier,
      owner: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('course') }),
        z.strictObject({ kind: z.literal('lesson'), lessonId: identifier }),
      ]),
      performance: description,
      conditions: description,
      successCriterion: description,
      origin: CurriculumArtifactRefSchema,
    })
  ),
  objectiveConceptLinks: z.array(
    z.strictObject({
      objectiveId: identifier,
      conceptId: identifier,
      aspect: description,
      ...motivation,
    })
  ),
  lessonConceptUses: z.array(
    z.strictObject({
      useId: identifier,
      lessonId: identifier,
      conceptId: identifier,
      role: z.enum(['assumed', 'oriented', 'introduced', 'developed']),
      scope: description,
      ...motivation,
    })
  ),
  lessonObjectiveLinks: z.array(
    z.strictObject({
      lessonId: identifier,
      objectiveId: identifier,
      contribution: description,
    })
  ),
  prerequisites: z.array(
    z.strictObject({
      requirementId: identifier,
      forObjectiveId: identifier,
      conceptId: identifier,
      requiredCapability: description,
      ...motivation,
    })
  ),
  prerequisitePreparations: z.array(
    z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('planned-in-course'),
        requirementId: identifier,
        dependentLessonId: identifier,
        providerLessonId: identifier,
        useIds: z.array(identifier).min(1),
        objectiveIds: z.array(identifier).min(1),
        ...motivation,
      }),
      z.strictObject({
        kind: z.literal('entry-assumption'),
        requirementId: identifier,
        dependentLessonId: identifier,
        supportRefs: z.array(supportRef).min(1),
        limitations: description,
        ...motivation,
      }),
      z.strictObject({
        kind: z.literal('unresolved'),
        requirementId: identifier,
        dependentLessonId: identifier,
        ...motivation,
      }),
    ])
  ),
  activityTargets: z.array(
    z.strictObject({
      activityPlanId: identifier,
      lessonId: identifier,
      objectiveId: identifier,
      expectedPerformance: description,
      ...motivation,
    })
  ),
});
export type CourseCurriculum = z.infer<typeof CourseCurriculumSchema>;
