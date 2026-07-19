import { LOW_REASONING_CONFIG, MODEL_FLASH } from './config.ts';
import { INTERNAL_FAST_TASK_INSTRUCTION } from './prompts.ts';
import { callOpenRouter, parseCleanJson, retryWithBackoff } from './shared.ts';

const MAX_YOUTUBE_SEARCH_QUERY_CHARS = 100;
const MAX_COURSE_YOUTUBE_SEARCH_QUERIES = 3;
const YOUTUBE_SEARCH_QUERY_RESPONSE_SCHEMA = {
  name: 'youtube_search_query',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', maxLength: MAX_YOUTUBE_SEARCH_QUERY_CHARS },
    },
    required: ['query'],
  },
} as const;
const COURSE_YOUTUBE_SEARCH_QUERIES_RESPONSE_SCHEMA = {
  name: 'course_youtube_search_queries',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      queries: {
        type: 'array',
        minItems: 2,
        maxItems: MAX_COURSE_YOUTUBE_SEARCH_QUERIES,
        items: { type: 'string', maxLength: MAX_YOUTUBE_SEARCH_QUERY_CHARS },
      },
    },
    required: ['queries'],
  },
} as const;

export interface YouTubeSearchQueryInput {
  context?: string;
  courseTitle: string;
  keyConcepts?: string[];
  language: string;
  lessonDescription?: string;
  lessonTitle?: string;
  practicalTask?: string;
}

const normalizePlannedQuery = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Missing YouTube search query');
  const query = value.replace(/\s+/g, ' ').trim();
  if (!query || query.length > MAX_YOUTUBE_SEARCH_QUERY_CHARS) {
    throw new Error('Invalid YouTube search query length');
  }
  return query;
};

const buildFallbackQuery = (input: YouTubeSearchQueryInput): string =>
  [input.lessonTitle, input.courseTitle]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .slice(0, MAX_YOUTUBE_SEARCH_QUERY_CHARS)
    .trim();

const normalizePlannedQueries = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error('Missing YouTube search queries');
  const queries = value.map(normalizePlannedQuery);
  return [...new Set(queries)].slice(0, MAX_COURSE_YOUTUBE_SEARCH_QUERIES);
};

export const planYouTubeSearchQuery = async (input: YouTubeSearchQueryInput): Promise<string> => {
  try {
    const response = await retryWithBackoff(
      () =>
        callOpenRouter({
          model: MODEL_FLASH,
          modelSlot: 'research',
          reasoning: LOW_REASONING_CONFIG,
          temperature: 0.1,
          max_tokens: 100,
          messages: [
            {
              role: 'system',
              content: `Sei un planner di query per la ricerca interna di YouTube. Produci query da motore di ricerca, non frasi o riassunti.

${INTERNAL_FAST_TASK_INSTRUCTION}`,
            },
            {
              role: 'user',
              content: `Crea UNA query YouTube breve e mirata per trovare il video più utile a questa lezione.

Regole:
- Usa 3-10 termini che potrebbero davvero comparire nel titolo o nella descrizione di un video.
- Dai priorità alla tecnica, dimostrazione o processo concreto che lo studente deve vedere o sentire.
- Non copiare tutto il contesto, non scrivere una frase completa e non inserire URL.
- Puoi usare termini inglesi quando aumentano nettamente la qualità dei risultati, specialmente per contenuti visivi indipendenti dalla lingua.
- Massimo ${MAX_YOUTUBE_SEARCH_QUERY_CHARS} caratteri.

CONTESTO:
${JSON.stringify(input)}`,
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: YOUTUBE_SEARCH_QUERY_RESPONSE_SCHEMA,
          },
        }),
      1,
      300
    );
    const query = normalizePlannedQuery(
      parseCleanJson<{ query?: unknown }>(response || '{}').query
    );
    console.info('[Nous] Query YouTube pianificata.', { query });
    return query;
  } catch {
    const fallback = buildFallbackQuery(input);
    console.error('[Nous] Pianificazione della query YouTube fallita; uso il titolo breve.');
    return fallback;
  }
};

export const planCourseYouTubeSearchQueries = async (
  input: YouTubeSearchQueryInput
): Promise<string[]> => {
  try {
    const response = await retryWithBackoff(
      () =>
        callOpenRouter({
          model: MODEL_FLASH,
          modelSlot: 'research',
          reasoning: LOW_REASONING_CONFIG,
          temperature: 0.1,
          max_tokens: 220,
          messages: [
            {
              role: 'system',
              content: `Sei un planner di query per la ricerca interna di YouTube. Produci query da motore di ricerca, non frasi o riassunti.

${INTERNAL_FAST_TASK_INSTRUCTION}`,
            },
            {
              role: 'user',
              content: `Crea da DUE a ${MAX_COURSE_YOUTUBE_SEARCH_QUERIES} query YouTube brevi e complementari per progettare un intero corso.

Le query devono coprire prospettive diverse:
- fondamenti e panoramica dell'intera materia;
- percorso didattico completo o playlist strutturata;
- obiettivo pratico dell'utente, soltanto come approfondimento subordinato al tema generale.

Regole:
- Usa 3-10 termini che potrebbero davvero comparire nel titolo o nella descrizione.
- Non trasformare un esempio o progetto finale nell'argomento dell'intero corso.
- Non copiare tutto il contesto, non scrivere frasi complete e non inserire URL.
- Puoi usare termini inglesi quando migliorano nettamente i risultati.
- Ogni query deve restare entro ${MAX_YOUTUBE_SEARCH_QUERY_CHARS} caratteri.

CONTESTO:
${JSON.stringify(input)}`,
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: COURSE_YOUTUBE_SEARCH_QUERIES_RESPONSE_SCHEMA,
          },
        }),
      1,
      300
    );
    const queries = normalizePlannedQueries(
      parseCleanJson<{ queries?: unknown }>(response || '{}').queries
    );
    console.info('[Nous] Query YouTube del corso pianificate.', { queries });
    return queries;
  } catch {
    const fallback = buildFallbackQuery(input);
    console.error(
      '[Nous] Pianificazione delle query YouTube del corso fallita; uso il titolo breve.'
    );
    return fallback ? [fallback] : [];
  }
};
