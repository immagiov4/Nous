import {
  ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE,
  ACTIVE_PAUSE_OPTIONS_RULE,
  ACTIVE_PAUSE_PLACEMENT_RULE,
  ACTIVE_PAUSE_TEXT_FORMAT_RULE,
  MAX_LESSON_QUIZ_QUESTIONS,
  ORIGINAL_IMAGE_PRIORITY_RULE,
  ORIGINAL_IMAGE_USAGE_RULES,
} from '@shared/lessonGenerationPolicy';
import {
  buildLessonVerificationChecklist,
  VISUAL_LEARNING_REQUIRED_REPRESENTATION_RULE,
} from '@shared/lessonInstructionPacks';
import { LESSON_VISUAL_PLANNING_RULES } from '@shared/lessonVisualContracts';
import {
  buildLessonContinuityRule,
  buildLessonNoRepetitionRule,
  FORMULA_RELEVANCE_RULE,
  LESSON_ASCII_VISUAL_RULE,
  LESSON_CODE_FORMATTING_RULE,
  LESSON_FIRST_EXPOSURE_RULE,
  LESSON_GUIDED_NOVICE_RULE,
  LESSON_HEADING_STRUCTURE_RULE,
  LESSON_KATEX_FORMATTING_RULE,
  LESSON_LANGUAGE_CLARITY_RULES,
  LESSON_LIST_STRUCTURE_RULE,
  LESSON_LOCAL_PROPEDEUTIC_RULES,
  LESSON_MAIN_PROSE_RULE,
  LESSON_MARKDOWN_CONTENT_INTEGRITY_RULE,
  LESSON_NAMED_SOURCE_ATTRIBUTION_RULE,
  LESSON_POSITIVE_DEFINITION_RULE,
  LESSON_PRIMARY_SOURCE_INTEGRATION_RULE,
  LESSON_REFERENCE_SECTION_LABELS,
  LESSON_RELEVANCE_STYLE_RULES,
  LESSON_RESEARCH_TRANSFORMATION_RULE,
  LESSON_SCOPE_RULES,
  LESSON_SELF_SUFFICIENCY_RULE,
  LESSON_SOURCE_PRECEDENCE_RULE,
  LESSON_STRUCTURED_SOURCE_COMPARISON_RULE,
  LESSON_STUDENT_STYLE_OVERRIDE_RULE,
  LESSON_TECHNICAL_SOURCE_STRUCTURE_RULE,
  SYSTEM_INSTRUCTION_TEACHER,
  YOUTUBE_CLIP_PEDAGOGY_RULES,
} from '@shared/lessonWritingContract';
import { generateText, jsonSchema, Output } from 'ai';

import {
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';
import {
  isLessonStructuredOutputError,
  retryLessonGenerationCorrection,
} from './lessonGenerationCorrection.js';
import { buildLessonGenerationReferenceContext } from './lessonGenerationPrompt.js';
import type { LessonContentDraft, LessonGenerationInput } from './lessonGenerationTypes.js';

interface LessonResponseSchemaContract {
  name: string;
  schema: {
    properties: Record<string, unknown>;
    required: readonly string[];
    [key: string]: unknown;
  };
}

const LESSON_VERIFICATION_STATUS = {
  corrected: 'corrected',
  notApplicable: 'not-applicable',
  pass: 'pass',
} as const;

const LESSON_VERIFICATION_STATUS_VALUES = Object.values(LESSON_VERIFICATION_STATUS);
type LessonVerificationStatus =
  (typeof LESSON_VERIFICATION_STATUS)[keyof typeof LESSON_VERIFICATION_STATUS];

interface LessonVerificationReportItem {
  action: string;
  checkId: string;
  evidence: string;
  status: LessonVerificationStatus;
}

type VerifiedLessonContentDraft = LessonContentDraft & {
  verificationReport: LessonVerificationReportItem[];
};

type LessonVerificationInput = Omit<LessonGenerationInput, 'config' | 'signal'>;
type LessonVerificationChecklistItem = ReturnType<typeof buildLessonVerificationChecklist>[number];

type LessonVerificationCheckContext = Pick<
  LessonGenerationInput,
  'imageCandidates' | 'instructionPacks' | 'sources'
>;

type LessonVerificationStructuralContext = Pick<
  LessonGenerationInput,
  'imageCandidates' | 'instructionPacks' | 'sources'
>;

export type LessonVerificationStructuralCheckId =
  | 'ascii-visual'
  | 'code-structure'
  | 'generated-visual'
  | 'image-reference'
  | 'markdown-structure'
  | 'math-structure'
  | 'positive-definition'
  | 'quiz-quality'
  | 'self-sufficiency'
  | 'youtube-structure';

const BASE_LESSON_VERIFICATION_STRUCTURAL_CHECK_IDS: readonly LessonVerificationStructuralCheckId[] =
  [
    'markdown-structure',
    'positive-definition',
    'self-sufficiency',
    'ascii-visual',
    'quiz-quality',
    'generated-visual',
  ];

const CODE_MARKUP_MARKERS = ['`', '~~~'] as const;
const INDENTED_CODE_BLOCK_PATTERN = /(?:^|\n[ \t]*\n)(?: {4}|\t)\S/;
const MATH_MARKUP_MARKERS = [
  '$',
  String.raw`\(`,
  String.raw`\)`,
  String.raw`\[`,
  String.raw`\]`,
  String.raw`\begin{`,
  String.raw`\end{`,
] as const;

const ACTIVE_PAUSE_EXERCISE_TYPE_RULES = ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE.map(
  exercise => `${exercise.type}: ${exercise.instruction}`
).join('\n');

const LOCAL_PROPEDEUTIC_VERIFICATION_RULES = LESSON_LOCAL_PROPEDEUTIC_RULES.join(' ');
const LANGUAGE_CLARITY_VERIFICATION_RULES = `${LESSON_STUDENT_STYLE_OVERRIDE_RULE} ${LESSON_LANGUAGE_CLARITY_RULES.join(' ')}`;
const RELEVANCE_STYLE_VERIFICATION_RULES = `${LESSON_STUDENT_STYLE_OVERRIDE_RULE} ${LESSON_RELEVANCE_STYLE_RULES.join(' ')}`;
const MARKDOWN_STRUCTURE_CHECK = `${LESSON_HEADING_STRUCTURE_RULE} ${LESSON_MAIN_PROSE_RULE} ${LESSON_LIST_STRUCTURE_RULE} ${LESSON_MARKDOWN_CONTENT_INTEGRITY_RULE}`;
const POSITIVE_DEFINITION_CHECK = `${LESSON_FIRST_EXPOSURE_RULE} ${LESSON_POSITIVE_DEFINITION_RULE}`;
const IMAGE_REFERENCE_CHECK = `${ORIGINAL_IMAGE_USAGE_RULES.join(' ')} Evaluate both the selectable original images and any existing imageRefs. If no original candidate is useful and no imageRefs exist, mark the check as ${LESSON_VERIFICATION_STATUS.notApplicable}.`;
const YOUTUBE_STRUCTURE_CHECK = `If the references contain a timestamped YouTube transcript but the draft has no clips, apply the pedagogical rules below to the omission decision as well. Add only the minimum useful interval when a clip is genuinely necessary. Otherwise mark the check as ${LESSON_VERIFICATION_STATUS.notApplicable}. Every existing or added clip must use a valid sourceIndex and timestamps entirely within the transcript. Its title must describe the specific moment, and its block must follow text that says what to observe.`;
const CODE_STRUCTURE_CHECK = `${LESSON_CODE_FORMATTING_RULE} If the draft contains no code, pseudocode, commands, or output, mark the check as ${LESSON_VERIFICATION_STATUS.notApplicable}.`;
const MATH_STRUCTURE_CHECK = `${FORMULA_RELEVANCE_RULE} ${LESSON_KATEX_FORMATTING_RULE} If the draft contains no mathematics, mark the check as ${LESSON_VERIFICATION_STATUS.notApplicable}.`;

const draftMarkdownContains = (draft: LessonContentDraft, markers: readonly string[]): boolean =>
  draft.contentBlocks.some(
    block => block.type === 'markdown' && markers.some(marker => block.markdown.includes(marker))
  );

const draftMarkdownMatches = (draft: LessonContentDraft, pattern: RegExp): boolean =>
  draft.contentBlocks.some(block => block.type === 'markdown' && pattern.test(block.markdown));

const buildVerificationSchema = (
  responseSchema: LessonResponseSchemaContract,
  checkIds: string[]
) => ({
  name: 'durable_lesson_verification',
  strict: true,
  schema: {
    ...responseSchema.schema,
    properties: {
      ...responseSchema.schema.properties,
      verificationReport: {
        items: {
          additionalProperties: false,
          properties: {
            action: { type: 'string' },
            checkId: { enum: checkIds, type: 'string' },
            evidence: { minLength: 1, type: 'string' },
            status: { enum: LESSON_VERIFICATION_STATUS_VALUES, type: 'string' },
          },
          required: ['checkId', 'status', 'evidence', 'action'],
          type: 'object',
        },
        maxItems: checkIds.length,
        minItems: checkIds.length,
        type: 'array',
      },
    },
    required: [...responseSchema.schema.required, 'verificationReport'],
  },
});

export const buildApplicableLessonVerificationCheckIds = (
  draft: LessonContentDraft
): LessonVerificationStructuralCheckId[] => {
  const checkIds = [...BASE_LESSON_VERIFICATION_STRUCTURAL_CHECK_IDS];
  if (
    draftMarkdownContains(draft, CODE_MARKUP_MARKERS) ||
    draftMarkdownMatches(draft, INDENTED_CODE_BLOCK_PATTERN)
  ) {
    checkIds.push('code-structure');
  }
  if (draftMarkdownContains(draft, MATH_MARKUP_MARKERS)) checkIds.push('math-structure');
  if (draft.imageRefs.length > 0) checkIds.push('image-reference');
  if (draft.contentBlocks.some(block => block.type === 'youtube-clips')) {
    checkIds.push('youtube-structure');
  }
  return checkIds;
};

const hasTimestampedYoutubeSource = (sources: LessonGenerationInput['sources']): boolean =>
  sources.some(source => (source.youtubeTranscript?.segments.length ?? 0) > 0);

const buildRequiredLessonVerificationStructuralCheckIds = (
  input: LessonVerificationStructuralContext,
  draft: LessonContentDraft
): LessonVerificationStructuralCheckId[] => {
  const checkIds = buildApplicableLessonVerificationCheckIds(draft);
  if (input.instructionPacks.includes('code') && !checkIds.includes('code-structure')) {
    checkIds.push('code-structure');
  }
  if (input.instructionPacks.includes('mathematics') && !checkIds.includes('math-structure')) {
    checkIds.push('math-structure');
  }
  if (input.imageCandidates.length > 0 && !checkIds.includes('image-reference')) {
    checkIds.push('image-reference');
  }
  if (hasTimestampedYoutubeSource(input.sources) && !checkIds.includes('youtube-structure')) {
    checkIds.push('youtube-structure');
  }
  return checkIds;
};

export const buildRequiredLessonVerificationCheckIds = (
  input: LessonVerificationCheckContext,
  draft: LessonContentDraft
): string[] => {
  const semanticIds = buildLessonVerificationChecklist(input.instructionPacks).map(
    item => item.checkId
  );
  return [...semanticIds, ...buildRequiredLessonVerificationStructuralCheckIds(input, draft)];
};

export const findUncheckedLessonVerificationStructuralCheckIds = (
  input: LessonVerificationStructuralContext,
  draft: LessonContentDraft,
  checkedIds: readonly string[]
): LessonVerificationStructuralCheckId[] => {
  const checkedIdSet = new Set(checkedIds);
  return buildRequiredLessonVerificationStructuralCheckIds(input, draft).filter(
    checkId => !checkedIdSet.has(checkId)
  );
};

export const isLessonVerificationReportComplete = (
  report: readonly { checkId: string; evidence: string }[],
  checkIds: readonly string[]
): boolean => {
  if (report.length !== checkIds.length) return false;
  const reportedIds = new Set(report.map(item => item.checkId));
  return (
    reportedIds.size === checkIds.length &&
    checkIds.every(checkId => reportedIds.has(checkId)) &&
    report.every(item => item.evidence.trim().length > 0)
  );
};

const buildStructuralCheckInstruction = (checkId: LessonVerificationStructuralCheckId): string => {
  switch (checkId) {
    case 'markdown-structure':
      return MARKDOWN_STRUCTURE_CHECK;
    case 'positive-definition':
      return POSITIVE_DEFINITION_CHECK;
    case 'self-sufficiency':
      return LESSON_SELF_SUFFICIENCY_RULE;
    case 'ascii-visual':
      return LESSON_ASCII_VISUAL_RULE;
    case 'code-structure':
      return CODE_STRUCTURE_CHECK;
    case 'math-structure':
      return MATH_STRUCTURE_CHECK;
    case 'quiz-quality':
      return `Mantieni da zero a ${MAX_LESSON_QUIZ_QUESTIONS} pause attive. Se la bozza non contiene pause, non aggiungerne salvo che le ${LESSON_REFERENCE_SECTION_LABELS.personalizationNotes.activePauseVerifierAlias} o il ${LESSON_REFERENCE_SECTION_LABELS.pedagogicalContext.activePauseVerifierAlias} ne richiedano esplicitamente una; se una pausa e richiesta esplicitamente ma manca, aggiungi soltanto il numero minimo necessario. Se non esiste alcuna pausa e nessuna istruzione esplicita la richiede, segna il controllo come ${LESSON_VERIFICATION_STATUS.notApplicable}. ${ACTIVE_PAUSE_PLACEMENT_RULE} ${ACTIVE_PAUSE_OPTIONS_RULE} ${ACTIVE_PAUSE_TEXT_FORMAT_RULE} Verifica inoltre che quiz.exerciseType descriva davvero l'operazione mentale richiesta dalla domanda; correggi il campo quando non corrisponde al catalogo seguente:\n${ACTIVE_PAUSE_EXERCISE_TYPE_RULES}`;
    case 'image-reference':
      return IMAGE_REFERENCE_CHECK;
    case 'generated-visual':
      return `${VISUAL_LEARNING_REQUIRED_REPRESENTATION_RULE} If the draft contains no generated visuals, do not add any unless the ${LESSON_REFERENCE_SECTION_LABELS.personalizationNotes.primary}, ${LESSON_REFERENCE_SECTION_LABELS.pedagogicalContext.primary}, or an active specialist pack requires a visual representation that source images or media do not already satisfy adequately. When visual-learning is active and that need remains unmet, add only the minimum necessary number of generated-visual blocks. Do not mark this check as ${LESSON_VERIFICATION_STATUS.notApplicable} merely because notes and context do not mention a visual explicitly. If no task instruction requires a missing representation and no generated visuals exist, mark the check as ${LESSON_VERIFICATION_STATUS.notApplicable}. Every existing or added visual plan must have exactly one generated-visual block with the same slotId and vice versa. Apply the complete planning contract below to the actual draft as well:\n${LESSON_VISUAL_PLANNING_RULES}\n- ${ORIGINAL_IMAGE_PRIORITY_RULE}`;
    case 'youtube-structure':
      return `${YOUTUBE_STRUCTURE_CHECK}\n${YOUTUBE_CLIP_PEDAGOGY_RULES}`;
  }
};

const applyLessonVerificationContext = (
  item: LessonVerificationChecklistItem,
  context: {
    hasReferenceMaterial: boolean;
    input: LessonVerificationInput;
    isResearchOnly: boolean;
  }
): LessonVerificationChecklistItem => {
  const { hasReferenceMaterial, input, isResearchOnly } = context;
  switch (item.checkId) {
    case 'core.coverage':
      return input.sourceContext
        ? {
            ...item,
            instruction: `${item.instruction} ${LESSON_PRIMARY_SOURCE_INTEGRATION_RULE}`,
          }
        : item;
    case 'core.progression':
      return {
        ...item,
        instruction: `${LOCAL_PROPEDEUTIC_VERIFICATION_RULES} ${LESSON_GUIDED_NOVICE_RULE}`,
      };
    case 'core.clarity':
      return {
        ...item,
        instruction: `${item.instruction} ${LANGUAGE_CLARITY_VERIFICATION_RULES}`,
      };
    case 'core.correctness': {
      const sourceRules = [
        input.sourceContext ? LESSON_SOURCE_PRECEDENCE_RULE : '',
        hasReferenceMaterial ? LESSON_NAMED_SOURCE_ATTRIBUTION_RULE : '',
      ]
        .filter(Boolean)
        .join(' ');
      return sourceRules ? { ...item, instruction: `${item.instruction} ${sourceRules}` } : item;
    }
    case 'core.structure': {
      const structureRules = [
        item.instruction,
        hasReferenceMaterial ? LESSON_TECHNICAL_SOURCE_STRUCTURE_RULE : '',
        hasReferenceMaterial ? LESSON_STRUCTURED_SOURCE_COMPARISON_RULE : '',
        isResearchOnly ? LESSON_RESEARCH_TRANSFORMATION_RULE : '',
      ]
        .filter(Boolean)
        .join(' ');
      return { ...item, instruction: structureRules };
    }
    case 'core.relevance':
      return {
        ...item,
        instruction: RELEVANCE_STYLE_VERIFICATION_RULES,
      };
    default:
      return item;
  }
};

const buildLessonVerificationPrompt = (
  input: LessonVerificationInput,
  draft: LessonContentDraft
): string => {
  const hasReferenceMaterial = Boolean(
    input.sourceContext || input.researchContext || input.sources.length > 0
  );
  const isResearchOnly =
    !input.sourceContext && Boolean(input.researchContext || input.sources.length > 0);
  const checklist = buildLessonVerificationChecklist(input.instructionPacks).map(item =>
    applyLessonVerificationContext(item, { hasReferenceMaterial, input, isResearchOnly })
  );
  const structuralCheckIds = buildRequiredLessonVerificationStructuralCheckIds(input, draft);
  const continuityRule = buildLessonContinuityRule(input.previousLessonTitles);
  const noRepetitionRule = buildLessonNoRepetitionRule(input.previousLessonTitles);
  const retryCorrection = input.retryFeedback?.trim()
    ? `\nREQUIRED CORRECTION FROM THE PREVIOUS ATTEMPT:\n${input.retryFeedback.trim()}\n`
    : '';
  return `${buildLessonGenerationReferenceContext(input)}

DRAFT TO VERIFY:
${JSON.stringify(draft)}
${retryCorrection}
VERIFICATION TASK:
Correct ONLY what is necessary and preserve all valid content. Do not rewrite the lesson for stylistic preference.
For every checkId listed below, judge the actual draft and cite the concrete passage or reason in evidence. Do not mark a check as pass automatically merely because its rule appears in the instructions.
Produce exactly one verificationReport entry for every checkId, including structural checks. Use ${LESSON_VERIFICATION_STATUS.notApplicable} only when the instruction allows it and the corresponding content does not exist in the draft.
The presence of a repair check is not an invitation to add a feature. Create active pauses or generated visuals only when an explicit task requirement makes them necessary.
Do not introduce imageRefs or YouTube clips unless the corresponding checkId is listed below. If you must remove an invalid artifact and the replacement format check is absent, correct the content in prose or remove the artifact instead of introducing an unchecked feature.

ALWAYS REQUIRED CONTINUITY AND FOCUS CONSTRAINTS:
- ${continuityRule}
${noRepetitionRule ? `- ${noRepetitionRule}\n` : ''}${LESSON_SCOPE_RULES.map(rule => `- ${rule}`).join('\n')}

REQUIRED SEMANTIC CHECKLIST:
${checklist.map(item => `- ${item.checkId}: ${item.instruction}`).join('\n')}

REQUIRED STRUCTURAL CHECKS:
${structuralCheckIds
  .map(checkId => `- ${checkId}: ${buildStructuralCheckInstruction(checkId)}`)
  .join('\n')}

Return only the verified JSON with verificationReport and no external text.`;
};

export const verifyLessonContentDraft = async (input: {
  draft: LessonContentDraft;
  generationInput: LessonGenerationInput;
  responseSchema: LessonResponseSchemaContract;
}): Promise<LessonContentDraft> => {
  const generationInput = input.generationInput;
  const prompt = buildLessonVerificationPrompt(generationInput, input.draft);
  const checkIds = buildRequiredLessonVerificationCheckIds(generationInput, input.draft);
  const schema = buildVerificationSchema(input.responseSchema, checkIds);
  let verified: VerifiedLessonContentDraft;
  try {
    if (resolveAiProviderForSlot(generationInput.config, 'lesson') === 'codex') {
      const modelConfig = resolveTextModelConfig(generationInput.config, 'lesson');
      const response = await runCodexAppServerTurn({
        allowWebSearch: false,
        developerInstructions: `${SYSTEM_INSTRUCTION_TEACHER}\nVerify and minimally correct the supplied lesson draft. Return every required checklist item. Do not use tools or access local files.`,
        input: [{ text: prompt, type: 'text' }],
        model: modelConfig.model,
        outputSchema: schema.schema,
        reasoningEffort: modelConfig.reasoningEffort,
        serviceTier: resolveCodexServiceTierForSlot(generationInput.config, 'lesson'),
        signal: generationInput.signal,
      });
      verified = JSON.parse(response) as VerifiedLessonContentDraft;
    } else {
      const configured = createConfiguredTextModel(generationInput.config, 'lesson');
      const { output } = await generateText({
        abortSignal: generationInput.signal,
        maxRetries: 0,
        model: configured.model,
        output: Output.object({
          name: schema.name,
          schema: jsonSchema<VerifiedLessonContentDraft>(
            schema.schema as unknown as Parameters<typeof jsonSchema>[0]
          ),
        }),
        prompt,
        providerOptions: configured.providerOptions,
        system: SYSTEM_INSTRUCTION_TEACHER,
      });
      verified = output;
    }
  } catch (error) {
    generationInput.signal.throwIfAborted();
    if (!isLessonStructuredOutputError(error)) throw error;
    throw retryLessonGenerationCorrection({
      code: 'lesson_review_output_invalid',
      feedback:
        'Return valid JSON matching the lesson verification schema exactly. Preserve the lesson draft fields and include every required verificationReport entry with a valid checkId, status, non-empty evidence, and action.',
      message: 'The lesson verifier returned invalid structured output.',
    });
  }

  if (!isLessonVerificationReportComplete(verified.verificationReport, checkIds)) {
    throw retryLessonGenerationCorrection({
      code: 'lesson_review_report_incomplete',
      feedback:
        'Return exactly one verificationReport entry for every required checkId. Do not omit, duplicate, or invent checkIds, and give every entry non-empty concrete evidence from the corrected draft.',
      message: 'The lesson verification report is incomplete.',
    });
  }

  const uncheckedStructuralCheckIds = findUncheckedLessonVerificationStructuralCheckIds(
    generationInput,
    verified,
    checkIds
  );
  if (uncheckedStructuralCheckIds.length > 0) {
    throw retryLessonGenerationCorrection({
      code: 'lesson_review_unchecked_structural_feature',
      feedback: `Do not introduce structural features whose checks were not authorized for this verification attempt. Remove or replace the newly introduced feature types requiring these missing checks: ${uncheckedStructuralCheckIds.join(', ')}. Preserve valid existing content.`,
      message: 'The lesson verifier introduced an unchecked structural feature.',
    });
  }

  const { verificationReport: _verificationReport, ...draft } = verified;
  return draft;
};
