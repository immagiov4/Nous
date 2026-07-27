import { INTERNAL_FAST_TASK_INSTRUCTION } from '@shared/aiPromptInstructions';
import { generateText, jsonSchema, Output } from 'ai';

import {
  type GlobalModelConfig,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';
import { retryProviderCall } from './providerRetry.js';

const MAX_QUERY_CHARS = 80;
const MIN_QUERY_TERMS = 2;
const MAX_QUERY_TERMS = 6;
const YOUTUBE_QUERY_SYSTEM_INSTRUCTION = `Sei un planner di query per la ricerca interna di YouTube. Produci query da motore di ricerca, non frasi o riassunti.\n\n${INTERNAL_FAST_TASK_INSTRUCTION}`;

export interface LessonYouTubeSearchInput {
  config: GlobalModelConfig;
  context?: string;
  courseTitle: string;
  keyConcepts?: string[];
  language: string;
  lessonDescription: string;
  lessonTitle: string;
  practicalTask?: string;
  signal: AbortSignal;
}

export interface LessonYouTubeSearchPlan {
  fallbackQuery: string;
  focusConcept: string;
  specificQuery: string;
}

const YOUTUBE_SEARCH_PLAN_SCHEMA = {
  name: 'youtube_search_plan',
  strict: true,
  schema: {
    additionalProperties: false,
    properties: {
      fallbackQuery: { maxLength: MAX_QUERY_CHARS, type: 'string' },
      focusConcept: { maxLength: 120, type: 'string' },
      specificQuery: { maxLength: MAX_QUERY_CHARS, type: 'string' },
    },
    required: ['fallbackQuery', 'focusConcept', 'specificQuery'],
    type: 'object',
  },
} as const;

const limitQuery = (value: string): string =>
  value
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .slice(0, MAX_QUERY_TERMS)
    .join(' ')
    .slice(0, MAX_QUERY_CHARS)
    .trim();

const fallbackPlan = (input: LessonYouTubeSearchInput): LessonYouTubeSearchPlan => {
  const specificQuery = limitQuery(input.lessonTitle || input.courseTitle);
  const fallbackQuery = limitQuery(input.keyConcepts?.[0] || input.courseTitle || specificQuery);
  return {
    fallbackQuery: fallbackQuery || specificQuery,
    focusConcept: input.keyConcepts?.[0] || input.lessonTitle || input.courseTitle,
    specificQuery,
  };
};

const normalizeQuery = (value: string): string => {
  const query = value.replaceAll(/\s+/gu, ' ').trim();
  const terms = query.split(' ').filter(Boolean);
  if (
    query.length > MAX_QUERY_CHARS ||
    terms.length < MIN_QUERY_TERMS ||
    terms.length > MAX_QUERY_TERMS
  ) {
    throw new Error('Invalid YouTube search query.');
  }
  return query;
};

export const planLessonYouTubeSearch = async (
  input: LessonYouTubeSearchInput
): Promise<LessonYouTubeSearchPlan> => {
  const prompt = `Scegli UN SOLO concetto centrale della lezione che sia insieme difficile da capire, importante per l'obiettivo didattico e chiarito meglio da movimento, spazio, tempo o dimostrazione video. Non cercare di coprire tutta la lezione.

Restituisci due formulazioni della STESSA intenzione:
- specificQuery: il concetto con al massimo un contesto tecnico indispensabile;
- fallbackQuery: lo stesso concetto senza prodotto, framework o contesto restrittivo.

Regole:
- Ogni query usa ${MIN_QUERY_TERMS}-${MAX_QUERY_TERMS} termini che potrebbero davvero comparire nel titolo o nella descrizione.
- Ogni query cerca un solo soggetto e una sola intenzione: spiegazione, visualizzazione oppure dimostrazione.
- Non concatenare gli altri argomenti della lezione e non usare la query come elenco di keyword.
- Non copiare tutto il contesto, non scrivere una frase completa e non inserire URL.
- Puoi usare termini inglesi quando aumentano nettamente la qualita dei risultati, specialmente per contenuti visivi indipendenti dalla lingua.
- Massimo ${MAX_QUERY_CHARS} caratteri.

CONTESTO:
${JSON.stringify({
  context: input.context,
  courseTitle: input.courseTitle,
  keyConcepts: input.keyConcepts,
  language: input.language,
  lessonDescription: input.lessonDescription,
  lessonTitle: input.lessonTitle,
  practicalTask: input.practicalTask,
})}`;

  try {
    const plan = await retryProviderCall(
      async () => {
        if (resolveAiProviderForSlot(input.config, 'research') === 'codex') {
          const modelConfig = resolveTextModelConfig(input.config, 'research');
          const response = await runCodexAppServerTurn({
            allowWebSearch: false,
            developerInstructions: `${YOUTUBE_QUERY_SYSTEM_INSTRUCTION} Non usare strumenti e non accedere a file locali.`,
            input: [{ text: prompt, type: 'text' }],
            model: modelConfig.model,
            outputSchema: YOUTUBE_SEARCH_PLAN_SCHEMA.schema,
            reasoningEffort: modelConfig.reasoningEffort,
            serviceTier: resolveCodexServiceTierForSlot(input.config, 'research'),
            signal: input.signal,
          });
          return JSON.parse(response) as LessonYouTubeSearchPlan;
        }
        const configured = createConfiguredTextModel(input.config, 'research');
        const { output } = await generateText({
          abortSignal: input.signal,
          model: configured.model,
          output: Output.object({
            name: YOUTUBE_SEARCH_PLAN_SCHEMA.name,
            schema: jsonSchema<LessonYouTubeSearchPlan>(
              YOUTUBE_SEARCH_PLAN_SCHEMA.schema as unknown as Parameters<typeof jsonSchema>[0]
            ),
          }),
          prompt,
          providerOptions: configured.providerOptions,
          system: YOUTUBE_QUERY_SYSTEM_INSTRUCTION,
        });
        return output;
      },
      { delay: 300, retries: 1, signal: input.signal }
    );
    return {
      fallbackQuery: normalizeQuery(plan.fallbackQuery),
      focusConcept: plan.focusConcept.trim(),
      specificQuery: normalizeQuery(plan.specificQuery),
    };
  } catch (error) {
    if (input.signal.aborted) throw error;
    console.warn('[Generation job] YouTube query planning failed; using lesson titles.', error);
    return fallbackPlan(input);
  }
};
