import { getMarkdownHeadings } from '@shared/lessonPdfImageSelection';
import { generateText, jsonSchema, Output } from 'ai';

import {
  type GlobalModelConfig,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';

export type LessonLearningAidKind = 'analogy' | 'definition' | 'formula';

const LEARNING_AID_KINDS = new Set<LessonLearningAidKind>(['analogy', 'definition', 'formula']);

export interface LessonLearningAidDraft {
  anchorHeading: string | null;
  content: string;
  kind: LessonLearningAidKind;
  title: string;
}

export interface StoredLessonLearningAid {
  anchorHeading?: string;
  content: string;
  id: string;
  kind: LessonLearningAidKind;
  title: string;
}

const MAX_DEFINITION_COUNT = 2;
const MAX_OTHER_KIND_COUNT = 1;
const MAX_LEARNING_AID_COUNT = 4;
const MAX_LESSON_MARKDOWN_CHARS = 24_000;
const LEARNING_AIDS_SYSTEM_INSTRUCTION =
  'Sei Lia, un tutor rigoroso. Estrai solo supporti didattici brevi e verificabili dal testo fornito. Rispondi esclusivamente con un oggetto JSON valido conforme allo schema richiesto.';

const LEARNING_AIDS_RESPONSE_SCHEMA = {
  name: 'lesson_learning_aids',
  strict: true,
  schema: {
    additionalProperties: false,
    properties: {
      aids: {
        items: {
          additionalProperties: false,
          properties: {
            anchorHeading: { type: ['string', 'null'] },
            content: { type: 'string' },
            kind: { enum: ['definition', 'formula', 'analogy'], type: 'string' },
            title: { type: 'string' },
          },
          required: ['kind', 'title', 'content', 'anchorHeading'],
          type: 'object',
        },
        maxItems: MAX_LEARNING_AID_COUNT,
        type: 'array',
      },
    },
    required: ['aids'],
    type: 'object',
  },
} as const;

const slugifyAidTitle = (value: string): string => {
  const slug = value
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-');
  return slug.split('-').filter(Boolean).join('-') || 'untitled';
};

const buildStableAidId = (
  kind: LessonLearningAidKind,
  title: string,
  usedIds: Set<string>
): string => {
  const baseId = `learning-aid-${kind}-${slugifyAidTitle(title)}`;
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
};

const normalizeLearningAidDraft = (
  value: unknown,
  headings: ReadonlySet<string>
): Omit<StoredLessonLearningAid, 'id'> | null => {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<LessonLearningAidDraft>;
  if (!draft.kind || !LEARNING_AID_KINDS.has(draft.kind)) return null;
  if (typeof draft.title !== 'string' || typeof draft.content !== 'string') return null;

  const title = draft.title.replaceAll(/\s+/gu, ' ').trim();
  const content = draft.content.replaceAll(/\s+/gu, ' ').trim();
  if (!title || !content) return null;

  const requestedAnchor =
    typeof draft.anchorHeading === 'string'
      ? draft.anchorHeading.replaceAll(/\s+/gu, ' ').trim()
      : '';
  const anchorHeading =
    requestedAnchor && headings.has(requestedAnchor) ? requestedAnchor : undefined;
  return {
    kind: draft.kind,
    title,
    content,
    ...(anchorHeading ? { anchorHeading } : {}),
  };
};

export const normalizeLessonLearningAids = (
  drafts: unknown,
  contentMarkdown: string
): StoredLessonLearningAid[] => {
  const headings = new Set(getMarkdownHeadings(contentMarkdown));
  const counts = new Map<LessonLearningAidKind, number>();
  const seen = new Set<string>();
  const usedIds = new Set<string>();
  const normalized: StoredLessonLearningAid[] = [];

  for (const value of Array.isArray(drafts) ? drafts : []) {
    const draft = normalizeLearningAidDraft(value, headings);
    if (!draft) continue;
    const dedupeKey = `${draft.kind}:${draft.title.toLocaleLowerCase()}`;
    const kindLimit = draft.kind === 'definition' ? MAX_DEFINITION_COUNT : MAX_OTHER_KIND_COUNT;
    if (seen.has(dedupeKey) || (counts.get(draft.kind) || 0) >= kindLimit) continue;

    normalized.push({
      ...draft,
      id: buildStableAidId(draft.kind, draft.title, usedIds),
    });
    seen.add(dedupeKey);
    counts.set(draft.kind, (counts.get(draft.kind) || 0) + 1);
    if (normalized.length >= MAX_LEARNING_AID_COUNT) break;
  }

  return normalized;
};

const buildLearningAidsPrompt = (
  contentMarkdown: string,
  sectionDescription: string,
  sectionTitle: string
): string => `Analizza la lezione seguente e individua solo gli aiuti contestuali che riducono davvero il carico cognitivo.

TITOLO: ${sectionTitle}
DESCRIZIONE: ${sectionDescription}

VINCOLI:
- Scrivi nella stessa lingua della lezione.
- Restituisci al massimo 2 definizioni importanti e specifiche del contesto.
- Puoi aggiungere al massimo una formula e un'analogia, solo se sono realmente utili.
- Usa formula solo per un'espressione matematica con quantita o simboli e una relazione utile da consultare e riutilizzare. Relazioni in prosa, equivalenze concettuali, regole mnemoniche e frasi che usano "=" come abbreviazione sono definizioni, non formule.
- Mantieni titolo e contenuto compatti, autonomi e privi di riempitivo.
- Il titolo e un'etichetta: massimo 4 parole e 32 caratteri. Scegli il nome piu breve e riconoscibile del concetto, mai una frase descrittiva.
- Ogni definizione deve essere comprensibile da sola per il richiamo immediato: usa parole comuni e non introdurre termini tecnici non spiegati; se un termine e indispensabile, chiariscilo nella stessa definizione.
- Non duplicare frasi o concetti equivalenti.
- Usa anchorHeading solo se coincide esattamente con un heading Markdown esistente; altrimenti usa null.
- Non modificare il Markdown e non proporre testo da inserirvi.
- Se nessun aiuto aggiunge valore, restituisci aids vuoto.

LEZIONE:
${contentMarkdown.slice(0, MAX_LESSON_MARKDOWN_CHARS)}`;

export interface GenerateLessonLearningAidsInput {
  config: GlobalModelConfig;
  contentMarkdown: string;
  sectionDescription: string;
  sectionTitle: string;
  signal: AbortSignal;
}

export type RequestLessonLearningAidDrafts = (
  input: GenerateLessonLearningAidsInput,
  prompt: string
) => Promise<LessonLearningAidDraft[]>;

const requestLessonLearningAidDrafts: RequestLessonLearningAidDrafts = async (input, prompt) => {
  if (resolveAiProviderForSlot(input.config, 'lesson') === 'codex') {
    const modelConfig = resolveTextModelConfig(input.config, 'lesson');
    const response = await runCodexAppServerTurn({
      allowWebSearch: false,
      developerInstructions: `${LEARNING_AIDS_SYSTEM_INSTRUCTION} Non usare strumenti e non accedere a file locali.`,
      input: [{ text: prompt, type: 'text' }],
      model: modelConfig.model,
      outputSchema: LEARNING_AIDS_RESPONSE_SCHEMA.schema,
      reasoningEffort: modelConfig.reasoningEffort,
      serviceTier: resolveCodexServiceTierForSlot(input.config, 'lesson'),
      signal: input.signal,
    });
    return (JSON.parse(response) as { aids: LessonLearningAidDraft[] }).aids;
  }

  const configured = createConfiguredTextModel(input.config, 'lesson');
  const { output } = await generateText({
    abortSignal: input.signal,
    maxRetries: 0,
    model: configured.model,
    output: Output.object({
      name: LEARNING_AIDS_RESPONSE_SCHEMA.name,
      schema: jsonSchema<{ aids: LessonLearningAidDraft[] }>(
        LEARNING_AIDS_RESPONSE_SCHEMA.schema as unknown as Parameters<typeof jsonSchema>[0]
      ),
    }),
    prompt,
    providerOptions: configured.providerOptions,
    system: LEARNING_AIDS_SYSTEM_INSTRUCTION,
  });
  return output.aids;
};

export const createLessonLearningAidGenerator =
  (requestDrafts: RequestLessonLearningAidDrafts = requestLessonLearningAidDrafts) =>
  async (input: GenerateLessonLearningAidsInput): Promise<StoredLessonLearningAid[]> => {
    const prompt = buildLearningAidsPrompt(
      input.contentMarkdown,
      input.sectionDescription,
      input.sectionTitle
    );
    const drafts = await requestDrafts(input, prompt);
    return normalizeLessonLearningAids(drafts, input.contentMarkdown);
  };

export const generateLessonLearningAids = createLessonLearningAidGenerator();
