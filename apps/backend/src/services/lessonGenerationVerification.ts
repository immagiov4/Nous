import {
  INTERACTIVE_VISUAL_VALUE_RULE,
  MAX_GENERATED_VISUALS_PER_LESSON,
  MAX_LESSON_QUIZ_QUESTIONS,
  VISUAL_FORMAT_SELECTION_RULE,
} from '@shared/lessonGenerationPolicy';
import { buildLessonVerificationChecklist } from '@shared/lessonInstructionPacks';
import { FORMULA_RELEVANCE_RULE, SYSTEM_INSTRUCTION_TEACHER } from '@shared/lessonWritingContract';
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

const buildApplicableStructuralChecks = (
  input: LessonVerificationInput,
  draft: LessonContentDraft
): string[] => {
  const markdown = draft.contentBlocks
    .filter(block => block.type === 'markdown')
    .map(block => block.markdown)
    .join('\n');
  const hasQuiz = draft.contentBlocks.some(block => block.type === 'inline-quiz');
  const hasYoutube = draft.contentBlocks.some(block => block.type === 'youtube-clips');
  const hasGeneratedVisual =
    draft.generatedVisuals.length > 0 ||
    draft.contentBlocks.some(block => block.type === 'generated-visual');
  const hasImageRefs = draft.imageRefs.length > 0 || input.imageCandidates.length > 0;
  const hasMath = /\$|\\\(|\\\[|\\begin\{/u.test(markdown);
  const hasCode = input.instructionPacks.includes('code') || markdown.includes('```');

  const checks = [
    'I blocchi markdown non contengono quiz, marker strutturali, markdown image syntax, tag img, assetId tecnici o una sezione fonti terminale.',
  ];

  if (hasQuiz) {
    checks.push(
      `Mantieni da zero a ${MAX_LESSON_QUIZ_QUESTIONS} pause attive. Ogni inline-quiz deve avere prima di se, dalla pausa precedente, un blocco markdown che contiene le informazioni necessarie; visuali generati o clip YouTube intermedi non interrompono quel contesto. La pausa deve avere quattro opzioni distinte e non deve poter essere risolta copiando o riconoscendo una definizione locale.`,
      'Domande e opzioni sono testo normale: rimuovi backticks o code fence che racchiudono l intera stringa, preservando eventuale codice inline interno.'
    );
  }
  if (hasImageRefs) {
    checks.push(
      'Ogni imageRef usa un assetId disponibile, ha un anchorHeading esatto e una corrispondenza bidirezionale con il testo vicino. Rimuovi immagini ambigue, decorative, fuori tema o senza caption visiva chiara.'
    );
  }
  if (hasGeneratedVisual) {
    checks.push(
      `Ogni piano visuale ha esattamente un blocco generated-visual con lo stesso slotId e viceversa, fino a ${MAX_GENERATED_VISUALS_PER_LESSON}. ${VISUAL_FORMAT_SELECTION_RULE} ${INTERACTIVE_VISUAL_VALUE_RULE}`
    );
  }
  if (hasYoutube) {
    checks.push(
      'Ogni clip YouTube usa un sourceIndex valido e timestamp interamente compresi nel transcript; il titolo descrive il momento specifico e il blocco segue il testo che dice cosa osservare.'
    );
  }
  if (hasMath) {
    checks.push(
      `${FORMULA_RELEVANCE_RULE} Correggi delimitatori o graffe KaTeX non bilanciati. Ogni ambiente LaTeX aperto con \\begin{...} deve chiudersi con il corrispondente \\end{...} nello stesso blocco matematico.`
    );
  }
  if (hasCode) {
    checks.push(
      'Codice, pseudocodice, comandi e output devono stare in un solo code block valido; non trasformare prosa o formule in codice.'
    );
  }

  return checks;
};

export const buildLessonVerificationPrompt = (
  input: LessonVerificationInput,
  draft: LessonContentDraft
): string => {
  const checklist = buildLessonVerificationChecklist(input.instructionPacks);
  const structuralChecks = buildApplicableStructuralChecks(input, draft);
  return String.raw`RIFERIMENTI DELLA LEZIONE:
${buildLessonGenerationReferenceContext(input)}

BOZZA DA VERIFICARE:
${JSON.stringify(draft, null, 2)}

COMPITO DI VERIFICA:
Correggi SOLO cio che serve e conserva tutto il contenuto valido. Non riscrivere la lezione per gusto stilistico.
Per ogni controllo, giudica la bozza effettiva e cita in evidence il passaggio o il motivo concreto: non segnare pass automaticamente solo perche la regola compare nelle istruzioni.

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
