import * as z from 'zod';

/** Ordered preferences relative to the reference material, or a balanced course. */
export const COURSE_CONTROL_POSITIONS = ['much-less', 'less', 'auto', 'more', 'much-more'] as const;

export const CourseControlPositionSchema = z.enum(COURSE_CONTROL_POSITIONS);

export const CoursePlanningControlsSchema = z.object({
  depth: CourseControlPositionSchema,
  granularity: CourseControlPositionSchema,
});

export type CourseControlPosition = z.infer<typeof CourseControlPositionSchema>;
export type CoursePlanningControls = z.infer<typeof CoursePlanningControlsSchema>;

export const DEFAULT_COURSE_PLANNING_CONTROLS: Readonly<CoursePlanningControls> = {
  depth: 'auto',
  granularity: 'auto',
};

export const CourseLanguageProficiencySchema = z.object({
  language: z.string().regex(/\S/),
  level: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']),
});

export type CourseLanguageProficiency = z.infer<typeof CourseLanguageProficiencySchema>;

/** Absent controls identify an older course; they are not an explicit Auto choice. */
export function resolveCoursePlanningControls(
  controls: CoursePlanningControls | undefined,
  hasReferenceMaterial: boolean
) {
  if (!controls) {
    return undefined;
  }

  return {
    ...controls,
    reference: hasReferenceMaterial ? ('source' as const) : ('balanced' as const),
  };
}

export type ResolvedCoursePlanningControls = NonNullable<
  ReturnType<typeof resolveCoursePlanningControls>
>;

export const CoursePlanningPreferencesSchema = z.object({
  coursePlanningControls: CoursePlanningControlsSchema.optional(),
  languageProficiency: CourseLanguageProficiencySchema.optional(),
});
