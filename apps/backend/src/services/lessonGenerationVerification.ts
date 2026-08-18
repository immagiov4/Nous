import {
  GENERATED_VISUAL_RELEVANCE_RULE,
  INTERACTIVE_VISUAL_VALUE_RULE,
  MAX_GENERATED_VISUALS_PER_LESSON,
  MAX_LESSON_QUIZ_QUESTIONS,
  VISUAL_FORMAT_SELECTION_RULE,
} from '@shared/lessonGenerationPolicy';
import { buildLessonVerificationChecklist } from '@shared/lessonInstructionPacks';
import {
  buildLessonContinuityRule,
  FORMULA_RELEVANCE_RULE,
  LESSON_ASCII_VISUAL_RULE,
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
  'Se la bozza contiene codice, pseudocodice, comandi o output, racchiudili in un code block Markdown valido; correggi anche frammenti tecnici rimasti nudi fuori dai fence. Non trasformare prosa o formule in codice.';

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

const countLeadingRun = (value: string, character: '`' | '~'): number => {
  let count = 0;
  while (value[count] === character) count += 1;
  return count;
};

const isEscaped = (value: string, index: number): boolean => {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
};

const isAsciiDigit = (value: string | undefined): boolean =>
  value !== undefined && value >= '0' && value <= '9';

const isAsciiLetter = (value: string | undefined): boolean =>
  value !== undefined && ((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z'));

const hasLaterSingleDollar = (value: string, startIndex: number): boolean => {
  for (let index = startIndex + 1; index < value.length; index += 1) {
    if (value[index] !== '$' || isEscaped(value, index)) continue;
    if (value[index - 1] === '$' || value[index + 1] === '$') continue;
    return true;
  }
  return false;
};

const isLikelyCurrencyAmount = (value: string, dollarIndex: number): boolean => {
  if (!isAsciiDigit(value[dollarIndex + 1]) || hasLaterSingleDollar(value, dollarIndex))
    return false;

  let cursor = dollarIndex + 1;
  while (isAsciiDigit(value[cursor])) cursor += 1;
  if ((value[cursor] === '.' || value[cursor] === ',') && isAsciiDigit(value[cursor + 1])) {
    cursor += 1;
    while (isAsciiDigit(value[cursor])) cursor += 1;
  }

  const immediatelyAfterNumber = value[cursor];
  if (immediatelyAfterNumber === undefined) return true;
  if (isAsciiLetter(immediatelyAfterNumber)) return false;
  if ('.;,!?'.includes(immediatelyAfterNumber)) return true;
  if (immediatelyAfterNumber.trim() !== '') return false;

  while (value[cursor]?.trim() === '') cursor += 1;
  const nextNonSpace = value[cursor];
  return (
    nextNonSpace === undefined || isAsciiLetter(nextNonSpace) || '.;,!?'.includes(nextNonSpace)
  );
};

const hasInlineDollarMath = (value: string): boolean => {
  let openingIndex: number | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '$' || isEscaped(value, index)) continue;
    if (value[index - 1] === '$' || value[index + 1] === '$') continue;

    if (openingIndex === null) {
      const next = value[index + 1];
      if (!next || next.trim() === '') continue;
      if (isLikelyCurrencyAmount(value, index)) continue;
      openingIndex = index;
      continue;
    }

    const previous = value[index - 1];
    if (previous && previous.trim() !== '') return true;

    const next = value[index + 1];
    openingIndex = next && next.trim() !== '' ? index : null;
  }

  return openingIndex !== null;
};

const markdownHasMathSyntax = (markdown: string): boolean => {
  let activeFence: { character: '`' | '~'; length: number } | null = null;

  for (const line of markdown.split('\n')) {
    const trimmed = line.trimStart();
    const first = trimmed[0];
    if (first === '`' || first === '~') {
      const length = countLeadingRun(trimmed, first);
      if (length >= 3) {
        if (!activeFence) {
          activeFence = { character: first, length };
        } else if (activeFence.character === first && length >= activeFence.length) {
          activeFence = null;
        }
        continue;
      }
    }

    if (activeFence) continue;
    if (
      line.includes('\\(') ||
      line.includes('\\)') ||
      line.includes('\\[') ||
      line.includes('\\]') ||
      line.includes('\\begin{') ||
      line.includes('\\end{') ||
      line.includes('$$') ||
      hasInlineDollarMath(line)
    ) {
      return true;
    }
  }

  return false;
};

const collectMathCheckText = (draft: LessonContentDraft): string =>
  draft.contentBlocks
    .flatMap(block => {
      if (block.type === 'markdown') return [block.markdown];
      if (block.type === 'inline-quiz') return [block.quiz.question, ...block.quiz.options];
      return [];
    })
    .join('\n');

export const buildApplicableLessonVerificationCheckIds = (
  draft: LessonContentDraft
): LessonVerificationStructuralCheckId[] => {
  const mathCheckText = collectMathCheckText(draft);
  const hasQuiz = draft.contentBlocks.some(block => block.type === 'inline-quiz');
  const hasYoutube = draft.contentBlocks.some(block => block.type === 'youtube-clips');
  const hasGeneratedVisual =
    draft.generatedVisuals.length > 0 ||
    draft.contentBlocks.some(block => block.type === 'generated-visual');
  const hasImageRefs = draft.imageRefs.length > 0;

  const checkIds: LessonVerificationStructuralCheckId[] = [
    'markdown-structure',
    'self-sufficiency',
    'ascii-visual',
    'code-structure',
  ];

  if (hasQuiz) checkIds.push('quiz-quality', 'quiz-text');
  if (hasImageRefs) checkIds.push('image-reference');
  if (hasGeneratedVisual) checkIds.push('generated-visual');
  if (hasYoutube) checkIds.push('youtube-structure');
  if (markdownHasMathSyntax(mathCheckText)) checkIds.push('math-structure');

  return checkIds;
};

const buildStructuralCheckInstruction = (checkId: LessonVerificationStructuralCheckId): string => {
  switch (checkId) {
    case 'markdown-structure':
      return MARKDOWN_STRUCTURE_CHECK;
    case 'self-sufficiency':
      return LESSON_SELF_SUFFICIENCY_RULE;
    case 'ascii-visual':
      return LESSON_ASCII_VISUAL_RULE;
    case 'code-structure':
      return CODE_STRUCTURE_CHECK;
    case 'quiz-quality':
      return `Mantieni da zero a ${MAX_LESSON_QUIZ_QUESTIONS} pause attive. Ogni inline-quiz deve avere prima di se, dalla pausa precedente, un blocco markdown che contiene le informazioni necessarie; visuali generati o clip YouTube intermedi non interrompono quel contesto. La pausa deve avere quattro opzioni distinte e non deve poter essere risolta copiando o riconoscendo una definizione locale.`;
    case 'quiz-text':
      return 'Domande e opzioni sono testo normale: rimuovi backticks o code fence che racchiudono l intera stringa, preservando eventuale codice inline interno.';
    case 'image-reference':
      return IMAGE_REFERENCE_CHECK;
    case 'generated-visual':
      return `Ogni piano visuale ha esattamente un blocco generated-visual con lo stesso slotId e viceversa, fino a ${MAX_GENERATED_VISUALS_PER_LESSON}. ${GENERATED_VISUAL_RELEVANCE_RULE} ${VISUAL_FORMAT_SELECTION_RULE} ${INTERACTIVE_VISUAL_VALUE_RULE}`;
    case 'youtube-structure':
      return `${YOUTUBE_STRUCTURE_CHECK}\n${YOUTUBE_CLIP_PEDAGOGY_RULES}`;
    case 'math-structure':
      return `${FORMULA_RELEVANCE_RULE} Correggi delimitatori o graffe KaTeX non bilanciati, inclusi delimitatori $, \\(, \\), \\[, \\] lasciati orfani. Ogni ambiente LaTeX aperto con \\begin{...} deve chiudersi con il corrispondente \\end{...} nello stesso blocco matematico.`;
  }
};

const buildLessonVerificationPrompt = (
  input: LessonVerificationInput,
  draft: LessonContentDraft
): string => {
  const checklist = buildLessonVerificationChecklist(input.instructionPacks);
  const structuralCheckIds = buildApplicableLessonVerificationCheckIds(draft);
  const structuralChecks = structuralCheckIds.map(buildStructuralCheckInstruction);
  const continuityRule = buildLessonContinuityRule(input.previousLessonTitles);
  return `RIFERIMENTI DELLA LEZIONE:
${buildLessonGenerationReferenceContext(input)}

BOZZA DA VERIFICARE:
${JSON.stringify(draft)}

COMPITO DI VERIFICA:
Correggi SOLO cio che serve e conserva tutto il contenuto valido. Non riscrivere la lezione per gusto stilistico.
Per ogni controllo, giudica la bozza effettiva e cita in evidence il passaggio o il motivo concreto: non segnare pass automaticamente solo perche la regola compare nelle istruzioni.

VINCOLI DI CONTINUITA E FOCUS SEMPRE OBBLIGATORI:
- ${continuityRule}
${LESSON_SCOPE_RULES.map(rule => `- ${rule}`).join('\n')}

CHECKLIST OBBLIGATORIA:
Compila esattamente una voce verificationReport per ciascun checkId:
${checklist.map(item => `- ${item.checkId}: ${item.instruction}`).join('\n')}

CONTROLLI STRUTTURALI APPLICABILI A QUESTA BOZZA:
${structuralChecks.map(check => `- ${check}`).join('\n')}

Restituisci soltanto il JSON verificato con verificationReport, senza testo esterno.`;
};

export const verifyLessonContentDraft = async (input: {
  draft: LessonContentDraft;
  generationInput: LessonGenerationInput;
  responseSchema: LessonResponseSchemaContract;
}): Promise<LessonContentDraft> => {
  const generationInput = input.generationInput;
  const prompt = buildLessonVerificationPrompt(generationInput, input.draft);
  const checklist = buildLessonVerificationChecklist(generationInput.instructionPacks);
  const checkIds = checklist.map(item => item.checkId);
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
