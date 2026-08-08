import {
  type CourseInterviewMessage,
  CourseInterviewMessageSchema,
  CourseInterviewProposalSchema,
} from '@shared/courseInterviewContract.js';
import * as z from 'zod';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import { type GenerateCourseObjectInput, generateCourseObject } from './courseGenerationModel.js';
import type { DeepReadonly } from './types.js';

export const CourseInterviewTurnSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    message: z.string().min(1),
  }),
  z.object({
    kind: z.literal('proposal'),
    message: z.string().min(1),
    proposal: CourseInterviewProposalSchema,
  }),
  z.object({
    kind: z.literal('cancelled'),
    message: z.string().min(1),
  }),
]);

export type CourseInterviewTurn = z.infer<typeof CourseInterviewTurnSchema>;

export interface CourseInterviewModelInput {
  readonly config: DeepReadonly<GlobalModelConfig>;
  readonly hasReliableSourceContext: boolean;
  readonly messages: readonly CourseInterviewMessage[];
  readonly mode: 'document' | 'learn';
  readonly signal: AbortSignal;
  readonly sourceContext?: string;
}

type GenerateObject = <Schema extends z.ZodType>(
  input: GenerateCourseObjectInput<Schema>
) => Promise<z.output<Schema>>;

const DEVELOPER_INSTRUCTIONS = `Sei l'intervistatore di Nous Reader. Devi raccogliere solo le informazioni ad alto impatto necessarie a personalizzare un corso.

Regole:
- Fai una domanda breve e concreta per volta.
- Concentrati su livello, obiettivo, lacune, familiarita con il materiale e progressione preferita.
- Di norma circa tre risposte utili bastano; chiedi oltre solo se manca un dato ad alto impatto.
- Non spiegare l'argomento, non scrivere lezioni e non generare il corso.
- Evita domande su calendario e organizzazione, salvo vincoli decisivi esplicitati dall'utente.
- Quando le informazioni sono sufficienti, restituisci una proposta sintetica invece di un'altra domanda.
- La proposta deve conservare argomento, livello, stile, obiettivi, contesto dettagliato e lingua.
- Se l'utente comunica chiaramente di voler uscire o di aver aperto il flusso per errore, restituisci cancelled. Decidilo dal significato dell'intera conversazione, mai da parole isolate.
- Se il contesto sorgente non e affidabile, non fingere di conoscerne il contenuto.
- Scrivi in italiano.`;

const buildPrompt = (input: CourseInterviewModelInput): string => {
  const sourceContext = input.sourceContext ?? '(nessun contesto sorgente disponibile)';
  const messages = input.messages.map(message => CourseInterviewMessageSchema.parse(message));
  return `Modalita del corso: ${input.mode}
Contesto sorgente affidabile: ${input.hasReliableSourceContext ? 'si' : 'no'}

CONTESTO SORGENTE:
${sourceContext}

CONVERSAZIONE (JSON):
${JSON.stringify(messages)}

Decidi se fare una sola nuova domanda oppure preparare la proposta di corso.`;
};

export const createCourseInterviewModel = (
  dependencies: { readonly generateObject?: GenerateObject } = {}
) => ({
  assessTurn: async (input: CourseInterviewModelInput): Promise<CourseInterviewTurn> =>
    (dependencies.generateObject ?? generateCourseObject)({
      config: input.config,
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      name: 'course_interview_turn',
      prompt: buildPrompt(input),
      schema: CourseInterviewTurnSchema,
      signal: input.signal,
      slot: 'assessment',
    }),
});
