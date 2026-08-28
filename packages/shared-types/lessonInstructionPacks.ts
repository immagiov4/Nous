import { ACTIVE_PAUSE_REASONING_RULE } from './lessonGenerationPolicy';
import { LESSON_COVERAGE_DEPTH_RULE } from './lessonWritingContract';

export const LESSON_INSTRUCTION_PACK_IDS = [
  'mathematics',
  'code',
  'technical-sources',
  'visual-learning',
] as const;

export type LessonInstructionPackId = (typeof LESSON_INSTRUCTION_PACK_IDS)[number];

interface LessonInstructionPack {
  description: string;
  verificationChecks: readonly string[];
  writingRules: readonly string[];
}

export interface LessonVerificationChecklistItem {
  checkId: string;
  instruction: string;
}

export const VISUAL_LEARNING_REQUIRED_REPRESENTATION_RULE =
  'When the visual-learning pack is active, treat it as an explicit task requirement to include at least one pedagogically necessary visual representation. Prefer suitable source images or media when available. If no source media meets the need, the verifier may restore the minimum necessary generated-visual. Do not satisfy the requirement with decorative elements.';

const UNIVERSAL_LESSON_VERIFICATION_CHECKS: readonly LessonVerificationChecklistItem[] = [
  {
    checkId: 'core.instructions',
    instruction:
      'The lesson respects the instructions, level, tone, language, pace, and explicit student preferences.',
  },
  {
    checkId: 'core.coverage',
    instruction: LESSON_COVERAGE_DEPTH_RULE,
  },
  {
    checkId: 'core.progression',
    instruction:
      'Local progression does not require concepts that have not yet been introduced or leave previews unresolved. Every new concept, question, technique, or abstraction has a concise bridge explaining why it follows from the preceding reasoning, even when the content is factually correct. Do not add ritual transitions when the link is already explicit.',
  },
  {
    checkId: 'core.clarity',
    instruction:
      'Density, intermediate steps, examples, and explanations make every substantive passage understandable.',
  },
  {
    checkId: 'core.correctness',
    instruction:
      'Claims and examples are correct, consistent with the available sources, and do not contradict one another.',
  },
  {
    checkId: 'core.structure',
    instruction:
      'The objective, ordering, connections, active pauses, and conclusion form a pedagogically coherent lesson.',
  },
  {
    checkId: 'core.active-pauses',
    instruction: ACTIVE_PAUSE_REASONING_RULE,
  },
  {
    checkId: 'core.relevance',
    instruction:
      'Examples, analogies, historical cases, surprising details, and digressions must advance the concept or clarify a real consequence. Remove interesting but pedagogically decorative details, and do not invent memories, personal experiences, or autobiography for the teacher or AI to make the text seem more human.',
  },
  {
    checkId: 'core.integrity',
    instruction:
      'Applicable Markdown, formulas, code, visuals, references, and structured blocks are valid and readable.',
  },
];

const LESSON_INSTRUCTION_PACKS: Record<LessonInstructionPackId, LessonInstructionPack> = {
  mathematics: {
    description:
      'The lesson uses formulas, mathematical symbols, or substantive quantitative passages.',
    writingRules: [
      'Connect every formula to an explanation of its symbols in the same paragraph or the one immediately after it. The formula may come before or after the explanation, but no symbol may remain unresolved or require looking for its meaning in a later section.',
      'Explain in prose what the formula represents and why it is needed in the current passage. Do not merely translate the symbols mechanically.',
      'When the student states that mathematics is difficult, introduce only one new abstraction at a time and use small numerical examples without requiring needless mental arithmetic.',
      'State conventions, units of measurement, and the meaning of subscripts, superscripts, or Greek letters when they become relevant.',
    ],
    verificationChecks: [
      'Every formula and group of symbols has an adjacent explanation in the same paragraph or the one immediately after it.',
      'The explanation clarifies the formula meaning and purpose, not only how to read the symbols.',
      'Mathematical density matches the student notes and does not accumulate multiple new abstractions in the same passage.',
      'Conventions, units, subscripts, superscripts, and Greek letters are clarified locally when needed.',
    ],
  },
  code: {
    description: 'The lesson teaches code, APIs, commands, configuration, or program behavior.',
    writingRules: [
      'Present every code or command example with its purpose, required preconditions, and expected observable result.',
      'Explain non-obvious identifiers, APIs, and steps near the first example that uses them. Do not leave opaque technical names unresolved until a later section.',
      'Clearly distinguish guaranteed behavior, illustrative examples, and version-specific or platform-specific details.',
    ],
    verificationChecks: [
      'Code and commands have an understandable purpose, preconditions, and expected result.',
      'Non-obvious identifiers and APIs are explained near their first use.',
      'The text distinguishes contracts, examples, and version-dependent or platform-dependent details.',
    ],
  },
  'technical-sources': {
    description:
      'The lesson depends on technical documentation, source code, standards, papers, or verifiable facts.',
    writingRules: [
      'Distinguish facts verified in the sources, reasonable inferences, and conventions that must be checked in the concrete system.',
      'Preserve exact names, versions, directions, ordering, and technical constraints. Do not turn a local convention into a universal rule.',
      'If the sources do not support a conclusion, state the limitation instead of filling it by intuition.',
    ],
    verificationChecks: [
      'Facts, inferences, and conventions are distinguished without presenting assumptions as certainties.',
      'Names, versions, ordering, and technical constraints match the available sources.',
      'Source limitations remain visible and are not filled with invented details.',
    ],
  },
  'visual-learning': {
    description: 'Understanding requires images, diagrams, animations, or spatial representations.',
    writingRules: [
      VISUAL_LEARNING_REQUIRED_REPRESENTATION_RULE,
      'Prepare every visual with the minimum necessary context and connect it explicitly to the concept it must make visible.',
      'After the visual, clarify the detail to observe and the teaching conclusion. Do not use it as decoration or as a substitute for a missing explanation.',
      'Do not ask a visual to represent relationships that the chosen format cannot show reliably.',
    ],
    verificationChecks: [
      'Every visual is prepared by the text and has a recognizable teaching objective.',
      'The text says what to observe and what conclusion to draw.',
      'The visual format and content fit the relationship being shown.',
      VISUAL_LEARNING_REQUIRED_REPRESENTATION_RULE,
    ],
  },
};

const isLessonInstructionPackId = (value: unknown): value is LessonInstructionPackId =>
  typeof value === 'string' &&
  LESSON_INSTRUCTION_PACK_IDS.includes(value as LessonInstructionPackId);

export const normalizeLessonInstructionPacks = (value: unknown): LessonInstructionPackId[] =>
  Array.isArray(value) ? [...new Set(value.filter(isLessonInstructionPackId))] : [];

export const LESSON_INSTRUCTION_PACK_SELECTION_RULES = `Assign each lesson only the specialist packs that genuinely apply:
${LESSON_INSTRUCTION_PACK_IDS.map(
  id => `- \`${id}\`: ${LESSON_INSTRUCTION_PACKS[id].description}`
).join('\n')}
If no specialist pack is needed, return an empty array. Do not activate a pack for a passing mention. It must describe a substantive need of the lesson.`;

export const buildLessonInstructionPackBlock = (
  packIds: readonly LessonInstructionPackId[] | undefined,
  mode: 'verification' | 'writing'
): string => {
  const normalizedIds = normalizeLessonInstructionPacks(packIds);
  if (normalizedIds.length === 0) return '';

  const rulesKey = mode === 'writing' ? 'writingRules' : 'verificationChecks';
  const heading =
    mode === 'writing' ? 'ACTIVE SPECIALIST WRITING PACKS' : 'REQUIRED SPECIALIST CHECKLIST';
  const formattedPacks = normalizedIds
    .map(id => {
      const rules = LESSON_INSTRUCTION_PACKS[id][rulesKey].map(rule => `- ${rule}`).join('\n');
      return `${id}:\n${rules}`;
    })
    .join('\n');

  return `\n${heading}:
${formattedPacks}\n`;
};

export const buildLessonVerificationChecklist = (
  packIds: readonly LessonInstructionPackId[] | undefined
): LessonVerificationChecklistItem[] => {
  const specialistChecks = normalizeLessonInstructionPacks(packIds).flatMap(packId =>
    LESSON_INSTRUCTION_PACKS[packId].verificationChecks.map((instruction, index) => ({
      checkId: `${packId}.${index + 1}`,
      instruction,
    }))
  );

  return [...UNIVERSAL_LESSON_VERIFICATION_CHECKS, ...specialistChecks];
};
