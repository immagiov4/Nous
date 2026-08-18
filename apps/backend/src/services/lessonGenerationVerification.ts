import {
  ACTIVE_PAUSE_OPTIONS_RULE,
  ACTIVE_PAUSE_TEXT_FORMAT_RULE,
  MAX_LESSON_QUIZ_QUESTIONS,
  ORIGINAL_IMAGE_PRIORITY_RULE,
} from '@shared/lessonGenerationPolicy';
import { buildLessonVerificationChecklist } from '@shared/lessonInstructionPacks';
import { LESSON_VISUAL_PLANNING_RULES } from '@shared/lessonVisualContracts';
import {
  buildLessonContinuityRule,
  FORMULA_RELEVANCE_RULE,
  LESSON_ASCII_VISUAL_RULE,
  LESSON_POSITIVE_DEFINITION_RULE,
  LESSON_SCOPE_RULES,
  LESSON_SELF_SUFFICIENCY_RULE,
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

interface LessonVerificationReportItem {
  action: string;
  checkId: string;
  evidence: string;
  status: 'corrected' | 'not-applicable' | 'pass';
}

type VerifiedLessonContentDraft = LessonContentDraft & {
  verificationReport: LessonVerificationReportItem[];
};

type LessonVerificationInput = Omit<LessonGenerationInput, 'config' | 'signal'>;

export type LessonVerificationStructuralCheckId =
  | 'ascii-visual'
  | 'code-structure'
  | 'generated-visual'
  | 'image-reference'
  | 'markdown-structure'
  | 'math-structure'
  | 'positive-definition'
  | 'quiz-quality'
  | 'quiz-text'
  | 'self-sufficiency'
  | 'youtube-structure';

const MARKDOWN_STRUCTURE_CHECK =
  'I blocchi markdown non contengono quiz, marker strutturali, markdown image syntax, tag img, assetId tecnici o una sezione fonti terminale.';
const IMAGE_REFERENCE_CHECK =
  'Ogni imageRef usa un assetId disponibile, ha un anchorHeading esatto e una corrispondenza bidirezionale con il testo vicino. Rimuovi immagini ambigue, decorative, fuori tema o senza caption visiva chiara.';
const YOUTUBE_STRUCTURE_CHECK =
  'Ogni clip YouTube usa un sourceIndex valido e timestamp interamente compresi nel transcript; il titolo descrive il momento specifico e il blocco segue il testo che dice cosa osservare.';
const CODE_STRUCTURE_CHECK =
  'Se la bozza contiene codice, pseudocodice, comandi o output, racchiudili in un code block Markdown valido; correggi anche frammenti tecnici rimasti nudi fuori dai fence. Non trasformare prosa o formule in codice. Se non contiene materiale tecnico di questo tipo, segna il controllo come non-applicable.';
const MATH_STRUCTURE_CHECK = `${FORMULA_RELEVANCE_RULE} Se la bozza contiene matematica, correggi delimitatori o graffe KaTeX non bilanciati, inclusi delimitatori $, \\(, \\), \\[, \\] lasciati orfani. Ogni ambiente LaTeX aperto con \\begin{...} deve chiudersi con il corrispondente \\end{...} nello stesso blocco matematico. Se non contiene matematica, segna il controllo come not-applicable.`;

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
            evidence: { type: 'string' },
            status: { enum: ['pass', 'corrected', 'not-applicable'], type: 'string' },
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
  const hasQuiz = draft.contentBlocks.some(block => block.type === 'inline-quiz');
  const hasYoutube = draft.contentBlocks.some(block => block.type === 'youtube-clips');
  const hasGeneratedVisual =
    draft.generatedVisuals.length > 0 ||
    draft.contentBlocks.some(block => block.type === 'generated-visual');
  const hasImageRefs = draft.imageRefs.length > 0;

  const checkIds: LessonVerificationStructuralCheckId[] = [
    'markdown-structure',
    'positive-definition',
    'self-sufficiency',
    'ascii-visual',
    'code-structure',
    'math-structure',
  ];

  if (hasQuiz) checkIds.push('quiz-quality', 'quiz-text');
  if (hasImageRefs) checkIds.push('image-reference');
  if (hasGeneratedVisual) checkIds.push('generated-visual');
  if (hasYoutube) checkIds.push('youtube-structure');

  return checkIds;
};

export const buildRequiredLessonVerificationCheckIds = (
  input: Pick<LessonGenerationInput, 'instructionPacks'>,
  draft: LessonContentDraft
): string[] => {
  const semanticIds = buildLessonVerificationChecklist(input.instructionPacks).map(
    item => item.checkId
  );
  return [...semanticIds, ...buildApplicableLessonVerificationCheckIds(draft)];
};

const buildStructuralCheckInstruction = (checkId: LessonVerificationStructuralCheckId): string => {
  switch (checkId) {
    case 'markdown-structure':
      return MARKDOWN_STRUCTURE_CHECK;
    case 'positive-definition':
      return LESSON_POSITIVE_DEFINITION_RULE;
    case 'self-sufficiency':
      return LESSON_SELF_SUFFICIENCY_RULE;
    case 'ascii-visual':
      return LESSON_ASCII_VISUAL_RULE;
    case 'code-structure':
      return CODE_STRUCTURE_CHECK;
    case 'math-structure':
      return MATH_STRUCTURE_CHECK;
    case 'quiz-quality':
      return `Mantieni da zero a ${MAX_LESSON_QUIZ_QUESTIONS} pause attive. Ogni inline-quiz deve avere prima di se, dalla pausa precedente, un blocco markdown che contiene le informazioni necessarie; visuali generati o clip YouTube intermedi non interrompono quel contesto. La pausa non deve poter essere risolta copiando o riconoscendo una definizione locale. ${ACTIVE_PAUSE_OPTIONS_RULE}`;
    case 'quiz-text':
      return ACTIVE_PAUSE_TEXT_FORMAT_RULE;
    case 'image-reference':
      return IMAGE_REFERENCE_CHECK;
    case 'generated-visual':
      return `Ogni piano visuale ha esattamente un blocco generated-visual con lo stesso slotId e viceversa. Applica anche l'intero contratto di pianificazione seguente alla bozza effettiva:\n${LESSON_VISUAL_PLANNING_RULES}\n- ${ORIGINAL_IMAGE_PRIORITY_RULE}`;
    case 'youtube-structure':
      return `${YOUTUBE_STRUCTURE_CHECK}\n${YOUTUBE_CLIP_PEDAGOGY_RULES}`;
  }
};

const buildLessonVerificationPrompt = (
  input: LessonVerificationInput,
  draft: LessonContentDraft
): string => {
  const checklist = buildLessonVerificationChecklist(input.instructionPacks);
  const structuralCheckIds = buildApplicableLessonVerificationCheckIds(draft);
  const continuityRule = buildLessonContinuityRule(input.previousLessonTitles);
  return `RIFERIMENTI DELLA LEZIONE:
${buildLessonGenerationReferenceContext(input)}

BOZZA DA VERIFICARE:
${JSON.stringify(draft)}

COMPITO DI VERIFICA:
Correggi SOLO cio che serve e conserva tutto il contenuto valido. Non riscrivere la lezione per gusto stilistico.
Per ogni checkId elencato sotto, giudica la bozza effettiva e cita in evidence il passaggio o il motivo concreto. Non segnare pass automaticamente solo perche la regola compare nelle istruzioni.
Compila esattamente una voce verificationReport per ciascun checkId, inclusi i controlli strutturali. Usa not-applicable solo quando l'istruzione lo consente e il contenuto corrispondente non esiste nella bozza.

VINCOLI DI CONTINUITA E FOCUS SEMPRE OBBLIGATORI:
- ${continuityRule}
${LESSON_SCOPE_RULES.map(rule => `- ${rule}`).join('\n')}

CHECKLIST SEMANTICA OBBLIGATORIA:
${checklist.map(item => `- ${item.checkId}: ${item.instruction}`).join('\n')}

CONTROLLI STRUTTURALI OBBLIGATORI:
${structuralCheckIds
  .map(checkId => `- ${checkId}: ${buildStructuralCheckInstruction(checkId)}`)
  .join('\n')}

Restituisci soltanto il JSON verificato con verificationReport, senza testo esterno.`;
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

  const reportedIds = new Set(verified.verificationReport.map(item => item.checkId));
  if (reportedIds.size !== checkIds.length || checkIds.some(checkId => !reportedIds.has(checkId))) {
    throw new Error('Lesson verification did not report every required check.');
  }
  const { verificationReport: _verificationReport, ...draft } = verified;
  return draft;
};
