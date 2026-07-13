import type { LessonLearningAid, LessonLearningAidKind } from '../../types.ts';
import { isRecord } from '../../utils/records.ts';
import { getMarkdownHeadings } from './lessonImages.ts';
import { callOpenRouter, MODEL_FLASH, parseCleanJson } from './shared.ts';

const LEARNING_AID_KINDS = new Set<LessonLearningAidKind>(['definition', 'formula', 'analogy']);
const MAX_DEFINITION_COUNT = 2;
const MAX_OTHER_KIND_COUNT = 1;
const MAX_LEARNING_AID_COUNT = 4;
const MAX_LESSON_MARKDOWN_CHARS = 24_000;

const LEARNING_AIDS_RESPONSE_SCHEMA = {
  name: 'lesson_learning_aids',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['aids'],
    properties: {
      aids: {
        type: 'array',
        maxItems: MAX_LEARNING_AID_COUNT,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'title', 'content', 'anchorHeading'],
          properties: {
            kind: {
              type: 'string',
              enum: Array.from(LEARNING_AID_KINDS),
            },
            title: { type: 'string' },
            content: { type: 'string' },
            anchorHeading: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
} as const;

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const slugifyAidTitle = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';

const isLearningAidKind = (value: unknown): value is LessonLearningAidKind =>
  typeof value === 'string' && LEARNING_AID_KINDS.has(value as LessonLearningAidKind);

const buildStableAidId = (
  kind: LessonLearningAidKind,
  title: string,
  usedIds: Set<string>
): string => {
  const baseId = `learning-aid-${kind}-${slugifyAidTitle(title)}`;
  let candidateId = baseId;
  let suffix = 2;

  while (usedIds.has(candidateId)) {
    candidateId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidateId);
  return candidateId;
};

export const normalizeLessonLearningAids = (
  payload: unknown,
  contentMarkdown: string
): LessonLearningAid[] => {
  if (!isRecord(payload) || !Array.isArray(payload.aids)) {
    return [];
  }

  const validHeadings = new Set(getMarkdownHeadings(contentMarkdown));
  const countsByKind = new Map<LessonLearningAidKind, number>();
  const seenAids = new Set<string>();
  const usedIds = new Set<string>();
  const normalized: LessonLearningAid[] = [];

  for (const draft of payload.aids) {
    if (!isRecord(draft) || !isLearningAidKind(draft.kind)) {
      continue;
    }

    const title = normalizeText(draft.title);
    const content = normalizeText(draft.content);
    if (!title || !content) {
      continue;
    }
    const dedupeKey = `${draft.kind}:${title.toLocaleLowerCase()}`;
    if (seenAids.has(dedupeKey)) {
      continue;
    }

    const kindLimit = draft.kind === 'definition' ? MAX_DEFINITION_COUNT : MAX_OTHER_KIND_COUNT;
    if ((countsByKind.get(draft.kind) ?? 0) >= kindLimit) {
      continue;
    }

    const requestedAnchor = normalizeText(draft.anchorHeading);
    const aid: LessonLearningAid = {
      id: buildStableAidId(draft.kind, title, usedIds),
      kind: draft.kind,
      title,
      content,
      ...(validHeadings.has(requestedAnchor) ? { anchorHeading: requestedAnchor } : {}),
    };

    normalized.push(aid);
    seenAids.add(dedupeKey);
    countsByKind.set(draft.kind, (countsByKind.get(draft.kind) ?? 0) + 1);

    if (normalized.length >= MAX_LEARNING_AID_COUNT) {
      break;
    }
  }

  return normalized;
};

interface GenerateLessonLearningAidsOptions {
  contentMarkdown: string;
  sectionDescription: string;
  sectionTitle: string;
}

const buildLearningAidsPrompt = ({
  contentMarkdown,
  sectionDescription,
  sectionTitle,
}: GenerateLessonLearningAidsOptions): string => `Analizza la lezione seguente e individua solo gli aiuti contestuali che riducono davvero il carico cognitivo.

TITOLO: ${sectionTitle}
DESCRIZIONE: ${sectionDescription}

VINCOLI:
- Scrivi nella stessa lingua della lezione.
- Restituisci al massimo 2 definizioni importanti e specifiche del contesto.
- Puoi aggiungere al massimo una formula e un'analogia, solo se sono realmente utili.
- Usa formula solo per un'espressione matematica con quantità o simboli e una relazione utile da consultare e riutilizzare. Relazioni in prosa, equivalenze concettuali, regole mnemoniche e frasi che usano "=" come abbreviazione sono definizioni, non formule.
- Mantieni titolo e contenuto compatti, autonomi e privi di riempitivo.
- Il titolo è un'etichetta: massimo 4 parole e 32 caratteri. Scegli il nome più breve e riconoscibile del concetto, mai una frase descrittiva.
- Ogni definizione deve essere comprensibile da sola per il richiamo immediato: usa parole comuni e non introdurre termini tecnici non spiegati; se un termine è indispensabile, chiariscilo nella stessa definizione.
- Non duplicare frasi o concetti equivalenti.
- Usa anchorHeading solo se coincide esattamente con un heading Markdown esistente; altrimenti usa null.
- Non modificare il Markdown e non proporre testo da inserirvi.
- Se nessun aiuto aggiunge valore, restituisci aids vuoto.

LEZIONE:
${contentMarkdown.slice(0, MAX_LESSON_MARKDOWN_CHARS)}`;

export const generateLessonLearningAids = async (
  options: GenerateLessonLearningAidsOptions
): Promise<LessonLearningAid[]> => {
  try {
    const response = await callOpenRouter({
      model: MODEL_FLASH,
      messages: [
        {
          role: 'system',
          content:
            'Sei Lia, un tutor rigoroso. Estrai solo supporti didattici brevi e verificabili dal testo fornito.',
        },
        { role: 'user', content: buildLearningAidsPrompt(options) },
      ],
      temperature: 0.1,
      max_tokens: 1200,
      response_format: {
        type: 'json_schema',
        json_schema: LEARNING_AIDS_RESPONSE_SCHEMA,
      },
    });

    return normalizeLessonLearningAids(
      parseCleanJson<unknown>(response || '{}'),
      options.contentMarkdown
    );
  } catch (error) {
    console.warn('[Nous][Lesson] Learning-aid generation failed; continuing without aids.', error);
    return [];
  }
};
