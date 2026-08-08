import {
  INTERACTIVE_VISUAL_VALUE_RULE,
  MAX_GENERATED_VISUALS_PER_LESSON,
  MAX_LESSON_QUIZ_QUESTIONS,
  VISUAL_FORMAT_SELECTION_RULE,
} from '@shared/lessonGenerationPolicy';
import { buildLessonVerificationChecklist } from '@shared/lessonInstructionPacks';
import {
  FORMULA_RELEVANCE_RULE,
  LESSON_LOCAL_PROPEDEUTIC_RULES,
  LESSON_SCOPE_RULES,
  SYSTEM_INSTRUCTION_TEACHER,
} from '@shared/lessonWritingContract';
import { generateText, jsonSchema, Output } from 'ai';

import {
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';
import { buildLessonGenerationPrompt } from './lessonGenerationPrompt.js';
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

const buildVerificationPrompt = (
  input: Omit<LessonGenerationInput, 'config' | 'signal'>,
  draft: LessonContentDraft
): string => {
  const checklist = buildLessonVerificationChecklist(input.instructionPacks);
  const scopeRules = LESSON_SCOPE_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
  return `Sei il verificatore finale di Nous Reader. Correggi SOLO cio che serve nella bozza e conserva tutto il contenuto valido.

CONTRATTO DI GENERAZIONE DA RISPETTARE:
${buildLessonGenerationPrompt(input)}

CHECKLIST OBBLIGATORIA:
Compila esattamente una voce verificationReport per ciascun checkId:
${checklist.map(item => `- ${item.checkId}: ${item.instruction}`).join('\n')}

CONTROLLI FINALI SPECIFICI:
- Mantieni la lezione nel focus corrente e applica questi vincoli:
${scopeRules}
- Verifica l'ordine propedeutico locale paragrafo per paragrafo:
${LESSON_LOCAL_PROPEDEUTIC_RULES.map(rule => `- ${rule}`).join('\n')}
- Mantieni da zero a ${MAX_LESSON_QUIZ_QUESTIONS} pause attive. Ogni inline-quiz deve seguire un blocco markdown che contiene le informazioni necessarie, avere quattro opzioni distinte e non essere una parafrasi diretta del testo.
- Domande e opzioni sono testo normale: rimuovi backticks o code fence che racchiudono l'intera stringa, preservando eventuale codice inline interno.
- I blocchi markdown non contengono quiz, marker strutturali, markdown image syntax, tag img, assetId tecnici o una sezione fonti terminale.
- Ogni imageRef usa un assetId disponibile, ha un anchorHeading esatto e una corrispondenza bidirezionale con il testo vicino. Rimuovi immagini ambigue, decorative, fuori tema o senza caption visiva chiara.
- Ogni piano visuale ha esattamente un blocco generated-visual con lo stesso slotId e viceversa, fino a ${MAX_GENERATED_VISUALS_PER_LESSON}. ${VISUAL_FORMAT_SELECTION_RULE} ${INTERACTIVE_VISUAL_VALUE_RULE}
- Ogni clip YouTube usa un sourceIndex valido e timestamp interamente compresi nel transcript; il titolo descrive il momento specifico e il blocco segue il testo che dice cosa osservare.
- ${FORMULA_RELEVANCE_RULE} Correggi delimitatori o graffe KaTeX non bilanciati.
- Codice, pseudocodice, comandi e output devono stare in un solo code block valido; non trasformare prosa o formule in codice.

BOZZA DA VERIFICARE:
${JSON.stringify(draft, null, 2)}

Restituisci soltanto il JSON verificato con verificationReport, senza testo esterno.`;
};

export const verifyLessonContentDraft = async (input: {
  draft: LessonContentDraft;
  generationInput: LessonGenerationInput;
  responseSchema: LessonResponseSchemaContract;
}): Promise<LessonContentDraft> => {
  const generationInput = input.generationInput;
  const prompt = buildVerificationPrompt(generationInput, input.draft);
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
