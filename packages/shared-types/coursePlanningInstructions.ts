import {
  type CourseLanguageProficiency,
  type CoursePlanningControls,
  resolveCoursePlanningControls,
} from './coursePlanningControls';

interface CoursePlanningPreferences {
  readonly coursePlanningControls?: CoursePlanningControls;
  readonly languageProficiency?: CourseLanguageProficiency;
  readonly teachingPreferences?: string;
}

/** The same resolved choices accompany planning, review, and persisted lesson instructions. */
export function buildCoursePlanningInstructions(
  profile: CoursePlanningPreferences | null,
  hasReferenceMaterial: boolean
): string {
  const controls = resolveCoursePlanningControls(
    profile?.coursePlanningControls,
    hasReferenceMaterial
  );
  const languageProficiency = profile?.languageProficiency;
  if (!controls && !languageProficiency) return '';

  return `COURSE CHOICES FROM THE INTERFACE:
${JSON.stringify({ controls, languageProficiency })}
These explicit choices take precedence over conflicting conversational preferences, within the course objective and system rules.
The ordered choices are much-less, less, auto, more, much-more. They express relative preferences, not numerical multipliers, knowledge levels, or target lesson counts.
When reference is source, Auto matches the relevant material's depth and organization. When reference is balanced, Auto uses a balanced treatment for the objective and available prior knowledge. Other choices reduce or increase that baseline.
Depth controls optional explanations, cases, and connections around the current lesson's focal content. Required content is retained at every setting. Enrichment must stay within the course objective and rely on available prerequisites. Do not anticipate later lessons, add missing prerequisites, expand old foundations, or wander through chains of related topics. Prior presentation does not establish mastery.
Granularity controls how much material is treated together in a lesson. Smaller steps and fuller lessons must retain the same destination, coverage, necessary connections, and prerequisite order. End at a meaningful local result. Fuller lessons do not imply deeper treatment or more exercises; preserve exercise policies.
In plan review, assess coherence against these choices without penalizing small coherent lessons merely for their size. In lesson writing, honor the chosen grouping in the plan and apply depth locally.
Language proficiency, when supplied, is a course-local CEFR declaration for its stated language. Adapt linguistic complexity without lowering subject goals or inferring subject expertise.`;
}
