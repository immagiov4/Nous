import {
  type CourseControlPosition,
  type CourseLanguageProficiency,
  type CoursePlanningControls,
  resolveCoursePlanningControls,
} from './coursePlanningControls';

interface CoursePlanningPreferences {
  readonly coursePlanningControls?: CoursePlanningControls;
  readonly languageProficiency?: CourseLanguageProficiency;
  readonly teachingPreferences?: string;
}

const DEPTH_TREATMENTS = {
  'much-less': {
    enrichment: 'minimal',
    instruction:
      'Explain each required relation completely, without repeating its justification in another section. Keep examples only when needed to understand the core. Once the learner can understand the required result, stop: omit alternative examples, restatements and further local cases that merely reinforce an already complete explanation.',
  },
  less: {
    enrichment: 'reduced',
    instruction:
      'Use less optional elaboration than the reference. Keep only selected local clarifications while preserving the complete required explanation.',
  },
  auto: {
    enrichment: 'reference',
    instruction:
      'Match the reference treatment of the current lesson focus: the relevant source material when available, otherwise a balanced explanation for the objective and available knowledge.',
  },
  more: {
    enrichment: 'expanded',
    instruction:
      'Add useful local explanations, cases or connections beyond the reference treatment, within the current lesson focus and available prerequisites.',
  },
  'much-more': {
    enrichment: 'extensive',
    instruction:
      'Explore the useful local explanations, cases and connections more fully than the more setting. Stop when the current focus is exhausted; do not reach this setting by teaching later objectives or adding prerequisites.',
  },
} as const satisfies Record<CourseControlPosition, { enrichment: string; instruction: string }>;

const LESSON_GROUPINGS = {
  'much-less': {
    grouping: 'smallest-coherent-steps',
    instruction:
      'Separate the material into the smallest steps that still achieve meaningful local results. Split a reference lesson when its results can be learned separately without losing necessary connections.',
  },
  less: {
    grouping: 'smaller-steps',
    instruction:
      'Use smaller local results than the reference grouping. Separate related material where this makes each lesson less substantial while preserving meaningful results and their connections.',
  },
  auto: {
    grouping: 'reference',
    instruction:
      'Follow the relevant source organization when available; otherwise group material into balanced, coherent local learning results.',
  },
  more: {
    grouping: 'broader-results',
    instruction:
      'Treat more related material together than the reference grouping. Combine compatible local results into fuller lessons, preserving prerequisite order and explaining their connections.',
  },
  'much-more': {
    grouping: 'broadest-coherent-results',
    instruction:
      'Integrate compatible local results into the fullest lessons that remain coherent and learnable with the available prerequisites. Go beyond the more setting where coherence permits; do not merely lengthen unchanged lessons.',
  },
} as const satisfies Record<CourseControlPosition, { grouping: string; instruction: string }>;

export const COURSE_CONTROL_LESSON_GROUPING_RULE =
  'Every lesson achieves a coherent local learning result at the selected granularity. Prerequisite order can be respected within a lesson as well as between lessons; a prerequisite relationship alone does not require separate lessons. Source headings identify content, not mandatory lesson boundaries. Keep the full required coverage while splitting or combining meaningful results as requested.';

export const COURSE_CONTROL_GRANULARITY_REVIEW_RULE =
  'When course controls are supplied, granularity must assess the requested grouping, not just whether the draft is teachable. Compare its actual lesson boundaries with the source organization, or a balanced organization when no source exists. For smaller steps, inspect whether a lesson contains results that can be learned separately; for fuller lessons, inspect whether adjacent results can form a coherent lesson with prerequisites explained in order. Cite the concrete results to separate or combine in granularity.feedback and require refinement when a useful requested change remains unapplied. Distinct topics, source headings, or the statement that one result requires another do not by themselves justify unchanged boundaries. If unchanged boundaries are appropriate, identify the specific dependency or coherence constraint that prevents the requested change. Do not force different lesson counts or remove required content.';

export const COURSE_CONTROL_DEPTH_REVIEW_RULE =
  'When course depth is supplied in the pedagogical context, assess the actual optional enrichment against its selected treatment. Correctness alone does not make a passage necessary. At minimal or reduced enrichment, remove redundant justifications, alternative examples and optional cases beyond the requested treatment while retaining the complete required explanation. At expanded or extensive enrichment, retain useful local additions only inside the current lesson objective and available prerequisites. Cite what is required and what is optional in the evidence. Applying this explicit preference is a required correction, not an unsolicited stylistic rewrite.';

/** Converts ordinal interface choices into independent, explicit generation directives. */
export function resolveCoursePlanningTreatment(controls: CoursePlanningControls) {
  return {
    depth: DEPTH_TREATMENTS[controls.depth],
    granularity: LESSON_GROUPINGS[controls.granularity],
  };
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
  const treatment = controls ? resolveCoursePlanningTreatment(controls) : undefined;

  return `COURSE CHOICES FROM THE INTERFACE:
${JSON.stringify({ controls, languageProficiency, treatment })}
These explicit choices take precedence over conflicting conversational preferences, within the course objective and system rules.
Apply each selected treatment instruction to its own dimension. These choices express relative preferences, not numerical multipliers, knowledge levels, or target lesson counts.
When reference is source, Auto matches the relevant material's depth and organization. When reference is balanced, Auto uses a balanced treatment for the objective and available prior knowledge. Other choices reduce or increase that baseline.
Depth controls optional explanations, cases, and connections around the current lesson's focal content. Required content is retained at every setting. Enrichment must stay within the course objective and rely on available prerequisites. Do not anticipate later lessons, add missing prerequisites, expand old foundations, or wander through chains of related topics. Prior presentation does not establish mastery.
The current lesson title, description and specific objective delimit what to teach now. Full-course source material and the final course goal provide context, not permission to teach every source unit in this lesson. Source fidelity applies only to content inside the current lesson boundary. This boundary takes precedence over the requested amount of enrichment, including much-more; when no further local enrichment is useful, finish the lesson.
Granularity controls how much material is treated together in a lesson. Smaller steps and fuller lessons must retain the same destination, coverage, necessary connections, and prerequisite order. End at a meaningful local result. Fuller lessons do not imply deeper treatment or more exercises; preserve exercise policies.
A distinct teachable core means a coherent local result, not a fixed source subsection or an indivisible concept. It can combine related concepts for fuller lessons or separate independently meaningful results for smaller steps. Existing mandatory planning limits still apply; suggested source-size ranges remain guidance rather than required lesson counts. Explain in lessonCountReason how the selected grouping changes or preserves the reference organization, including any constraint that prevents a useful change; do not invent a difference just to satisfy the preference.
List a lesson prerequisite only when it is supported by the supplied prior-knowledge context or introduced in an earlier lesson. A concept taught within the current lesson belongs in its content and guiding questions, not in its prerequisites. A concept appearing in the course goal or source material is not evidence that the learner already knows it. When the required result needs an unfamiliar concept, teach the necessary explanation within the course scope before asking the learner to use it.
In plan review, assess coherence against these choices without penalizing small coherent lessons merely for their size. In lesson writing, honor the chosen grouping in the plan and apply depth locally.
When refining a reviewed plan, address every concrete finding in the supplied review, including separate findings within the same dimension. Check the resulting lesson boundaries against each requested split or combination before returning. If a finding conflicts with the course objective, available prerequisites or required coverage, explain that specific constraint in lessonCountReason; do not silently leave a requested correction unapplied.
Language proficiency, when supplied, is a course-local CEFR declaration for its stated language. Adapt linguistic complexity without lowering subject goals or inferring subject expertise.`;
}
