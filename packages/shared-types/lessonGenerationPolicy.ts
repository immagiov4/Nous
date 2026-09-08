export const MAX_GENERATED_VISUALS_PER_LESSON = 3;
export const MAX_LESSON_QUIZ_QUESTIONS = 3;
export const MAX_VISUAL_LESSON_CHARS = 12_000;

export const ACTIVE_PAUSE_EXERCISE_TYPES = [
  'concept-check',
  'application-card',
  'prediction',
  'error-diagnosis',
  'classification',
  'compare-contrast',
  'sequence',
  'micro-synthesis',
] as const;

export type ActivePauseExerciseType = (typeof ACTIVE_PAUSE_EXERCISE_TYPES)[number];

export const ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE: ReadonlyArray<{
  instruction: string;
  type: ActivePauseExerciseType;
}> = [
  {
    type: 'concept-check',
    instruction:
      'Concept check: distinguish plausible statements using the meaning of the concept. Do not ask the learner to recognize a term or definition just stated in nearly the same words.',
  },
  {
    type: 'application-card',
    instruction:
      'Quick application: apply a concept to a new, concrete mini-case that can be solved in a few seconds. Change the surface details of the examples already explained while preserving their conceptual structure.',
  },
  {
    type: 'prediction',
    instruction:
      'Prediction: predict the most likely consequence of changing a condition, step, or constraint. Require the causal model just developed, rather than repeating a sentence from the text.',
  },
  {
    type: 'error-diagnosis',
    instruction:
      'Error diagnosis: identify the error, false assumption, or best correction in a short, plausible argument. The error must test a real distinction rather than offer an obviously absurd distractor.',
  },
  {
    type: 'classification',
    instruction:
      'Classification: assign a new example, case, or phenomenon to the appropriate category using the criteria explained. Do not reuse an example already labeled in the text as the question.',
  },
  {
    type: 'compare-contrast',
    instruction:
      'Comparison: choose the difference, similarity, or implication that correctly distinguishes two concepts. Require reconstructing the distinction rather than finding the option that best copies a nearby sentence.',
  },
  {
    type: 'sequence',
    instruction:
      'Sequence: choose the correct order of steps, causes, conditions, or priorities when order conveys information. Avoid sequences solvable by copying the immediately preceding list.',
  },
  {
    type: 'micro-synthesis',
    instruction:
      'Micro-synthesis: combine at least two ideas just developed and choose the most faithful synthesis, label, or connection. Do not turn this into literal recall of a single definition.',
  },
];

export const ACTIVE_PAUSE_PLACEMENT_RULE =
  'Each active pause is a self-contained inline-quiz block placed after markdown containing all necessary information since the previous pause. Relevant generated visuals or YouTube clips between that markdown and the pause do not interrupt the context. A pause consumes the explanatory context: do not place consecutive inline-quiz blocks, group them at the end, or use markers or a separate quiz array.';

export const ACTIVE_PAUSE_REASONING_RULE =
  'Each pause must require conceptual discrimination, application to a new case, inference, prediction, diagnosis, classification, sequencing, or micro-synthesis. If the correct answer can be selected by copying, paraphrasing, or matching the wording of a nearby sentence or definition, turn it into a new case or remove the pause.';

export const EXERCISE_TASK_DISCLOSURE_RULE =
  'Provide the necessary data, conditions, and constraints while leaving the result, classification, diagnosis, or steps being tested for the learner to derive. Do not reveal the specific solution in the title, question, labeled data, or a worked procedure to copy. Preserve explanations of concepts and useful prerequisites: making the task self-contained does not mean solving it for the learner.';

export const ACTIVE_PAUSE_OPTIONS_RULE =
  'Each pause has four textually distinct options and exactly one defensible correct answer under the stated conditions. Each of the three distractors must be wrong for a concrete reason supported by the case and taught material, while remaining plausible to a learner who has not mastered the concept. Being less elegant or less detailed than the key is not enough: remove ambiguity, unstated conditions, and partially true alternatives that still answer the question. Keep options comparable in content, grammar, and detail, without identifying the key through length, added explanations, or wording copied from the question. Avoid artificial absolutes, extreme claims, or alternatives plainly contradicted by the data that can be dismissed without applying the concept. Choosing a plausible distractor does not establish a specific learner misconception.';

export const ACTIVE_PAUSE_FEEDBACK_RULE =
  'Keep correctIndex for scoring after selection. Put the explanation of the specific quiz solution only in quiz.explanation, which the reader reveals after an answer. Use this field to explain why the key is correct and why the alternatives fail in this case, without diagnosing the learner. Do not repeat that solution or option-level rationale in the question, options, or any lesson markdown, including after the quiz. Preserve ordinary teaching explanations and prerequisites in lesson markdown. If a draft places the specific solution there, move it into quiz.explanation rather than deleting it.';

export const ACTIVE_PAUSE_TEXT_FORMAT_RULE =
  'Write questions and options as ordinary text, never entirely wrapped in backticks or code fences; preserve any inline code within the text.';

export const ORIGINAL_IMAGE_PRIORITY_RULE =
  'When the references contain clear, relevant original images specific to the source, such as screenshots, objects, cases, or complex diagrams from the document, prefer them over equivalent generated visuals. If several original images address the same pedagogical need, use only the minimum useful number proportional to the lesson structure and avoid redundant figures. Generate a replacement only when the originals do not address the same pedagogical need or are not sufficiently readable.';

export const ORIGINAL_IMAGE_USAGE_RULES = [
  'Every original image must support a nearby explanation. Do not use it as decoration or a visual interlude.',
  'Reference only the supplied assetIds. If no image is clearly relevant, leave imageRefs empty.',
  'For every selected imageRef, insert {{PDF_IMAGE:assetId}} in a Markdown content block where the image belongs. Replace assetId with the supplied image identifier. Choose its position as part of writing the lesson; metadata alone does not display the image.',
  'Use only images with a clear, self-contained visual caption. Exclude blurred, partial, cropped, hard-to-read, or decorative images, as well as badges, icons, borders, wrappers, or fragments.',
  ORIGINAL_IMAGE_PRIORITY_RULE,
  'Do not use textual context to guess what an unclear figure shows. Captions and nearby text may only disambiguate an already recognizable figure.',
  'The nearby paragraph must say what to observe in the image and why it is useful. Use technical assetIds only inside PDF_IMAGE placeholders, never in the surrounding prose.',
] as const;

export const LESSON_VISUAL_TYPES = [
  'chart_html',
  'flowchart_svg',
  'illustrative_image',
  'interactive_html',
  'mermaid_class',
  'mermaid_erd',
  'structural_svg',
] as const;

export type LessonVisualType = (typeof LESSON_VISUAL_TYPES)[number];

export const GENERATED_VISUAL_RELEVANCE_RULE =
  'Do not generate decorative visuals. Every visual must teach something that text alone makes harder to understand, not merely summarize or paraphrase it. Use only the minimum necessary number of visuals.';

export const INTERACTIVE_VISUAL_VALUE_RULE =
  'Treat interactive_html as an expensive format. Use it only when the user must explore, modify, or compare states and that interaction produces important understanding that text, video, or one or two static images cannot provide equally well. Do not use it for cosmetic demonstrations, trivial controls, or static examples disguised as interactive. If interaction is not essential, choose the simpler format.';

export const VISUAL_FORMAT_SELECTION_RULE =
  'Set requiresDepiction=true when the student must see the appearance of an object, state, scene, graphical result, or visual transformation, including steps that show how a subject changes. In that case use illustrative_image. A visual process is not a flowchart. SVG is allowed only with requiresDepiction=false for abstract relationships among short text labels, generic boxes, and arrows. Nodes cannot contain drawings, silhouettes, pixel art, objects, scenes, or examples of the result. If the visual must show programmable examples, including pixel art, simple shaders, generative patterns, or filter and effect comparisons, use interactive_html even when controls are unnecessary. The format may be a passive HTML and JavaScript demonstration. Use interactive_html with controls only when manipulation adds essential teaching value. For a passive programmable visual, set interactionLevel=none in the backend contract or interaction_level=none in the client contract.';

export const NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT = `NOUS VISUAL CONTRACT:
- Use a warm neutral base of ivory or paper, stone, and charcoal, with restrained surfaces, light borders, minimal shadows, and editorial typography.
- Use one accent consistent with the subject, chosen from muted red, burgundy, earthy green, and muted copper or orange.
- Do not use blue or purple SaaS palettes, neon, glow, decorative gradients, or oversized shadows unless the content requires the color semantically.
- Let the pedagogical purpose determine the medium. Editorial 2D illustrations are fully allowed. Do not default to decorative 3D objects or renders.
- In HTML and SVG, use the host CSS variables (--bg-paper, --bg-surface, --ink-primary, --ink-secondary, --accent, --border-subtle, --border-strong) instead of hard-coded theme colors, and keep both light and dark themes readable.`;

export const enforceLessonVisualTypeContract = <
  T extends { requiresDepiction: boolean; visualType: LessonVisualType },
>(
  plan: T
): T =>
  plan.requiresDepiction &&
  (plan.visualType === 'flowchart_svg' || plan.visualType === 'structural_svg')
    ? { ...plan, visualType: 'illustrative_image' }
    : plan;
