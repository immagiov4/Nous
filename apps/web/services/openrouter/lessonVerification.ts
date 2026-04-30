import { ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE } from '../../utils/learning/activePause.ts';
import { MEDIUM_REASONING_CONFIG } from './config.ts';
import type { SectionImagePlacement } from './lessonImages.ts';
import {
  clampLessonQuizCount,
  LESSON_QUIZ_OPTION_COUNT,
  MAX_LESSON_QUIZ_QUESTIONS,
  MAX_LESSON_REPAIR_SOURCE_CHARS,
  MIN_LESSON_QUIZ_QUESTIONS,
  normalizeQuizLength,
  parseQuizPayload,
} from './lessonMarkdownQuality.ts';
import { buildUserGenerationNotesBlock } from './prompts.ts';
import {
  callOpenRouter,
  type LessonImageRef,
  MODEL_FLASH,
  parseCleanJson,
  type QuizQuestion,
  retryWithBackoff,
  teacherInstruction,
} from './shared.ts';

interface PdfSectionContentPayload {
  contentMarkdown?: string;
  quiz?: QuizQuestion[];
  imagePlacements?: SectionImagePlacement[];
}

export const parseLessonContentPayload = (
  response: string,
  sectionTitle: string
): PdfSectionContentPayload => {
  const parsed = parseCleanJson<PdfSectionContentPayload>(response || '{}');
  if (parsed.contentMarkdown?.trim()) {
    return parsed;
  }

  console.warn('[Nous][Lesson] Lesson generation returned empty contentMarkdown — retrying.', {
    sectionTitle,
    responsePreview: (response || '').slice(0, 200),
  });
  const error = new Error(
    'La generazione della lezione non ha restituito contenuti. Riprova tra poco.'
  ) as Error & { status?: number; details?: string };
  error.status = 0;
  error.details = 'empty_lesson_content';
  throw error;
};

export interface LessonVerificationDraft {
  contentMarkdown: string;
  quiz: QuizQuestion[];
  imagePlacements: LessonImageRef[];
}

export const ACTIVE_PAUSE_EXERCISE_TYPE_RULES = ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE.map(
  exercise => `- ${exercise.type}: ${exercise.instruction}`
).join('\n');

const buildLessonResponseSchema = (exactQuizCount?: number) => {
  const quizCount =
    typeof exactQuizCount === 'number' && Number.isInteger(exactQuizCount)
      ? clampLessonQuizCount(exactQuizCount)
      : undefined;

  return {
    name: 'nous_lesson_response',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contentMarkdown: {
          type: 'string',
        },
        quiz: {
          type: 'array',
          minItems: quizCount ?? MIN_LESSON_QUIZ_QUESTIONS,
          maxItems: quizCount ?? MAX_LESSON_QUIZ_QUESTIONS,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              exerciseType: {
                type: 'string',
                enum: ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE.map(exercise => exercise.type),
              },
              question: {
                type: 'string',
              },
              options: {
                type: 'array',
                minItems: LESSON_QUIZ_OPTION_COUNT,
                maxItems: LESSON_QUIZ_OPTION_COUNT,
                items: {
                  type: 'string',
                },
              },
              correctIndex: {
                type: 'integer',
                minimum: 0,
                maximum: LESSON_QUIZ_OPTION_COUNT - 1,
              },
            },
            required: ['exerciseType', 'question', 'options', 'correctIndex'],
          },
        },
        imagePlacements: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              assetId: {
                type: 'string',
              },
              alt: {
                type: 'string',
              },
              caption: {
                type: ['string', 'null'],
              },
              anchorHeading: {
                type: ['string', 'null'],
              },
            },
            required: ['assetId', 'alt', 'caption', 'anchorHeading'],
          },
        },
      },
      required: ['contentMarkdown', 'quiz', 'imagePlacements'],
    },
  } as const;
};

export const LESSON_RESPONSE_SCHEMA = buildLessonResponseSchema();

interface BuildLessonVerificationPromptInput {
  sectionTitle: string;
  sectionDescription: string;
  previousContext: string;
  sourceContext: string;
  continuityRule: string;
  scopeRule: string;
  targetQuizCount: number;
  draft: LessonVerificationDraft;
  candidateImages: Array<{
    assetId: string;
    pageNumber?: number;
    visibleLabel: string;
    caption?: string;
    sourceOrder: number;
  }>;
  generationNotes?: string;
}

export const buildLessonVerificationPrompt = ({
  sectionTitle,
  sectionDescription,
  previousContext,
  sourceContext,
  continuityRule,
  scopeRule,
  targetQuizCount,
  draft,
  candidateImages,
  generationNotes,
}: BuildLessonVerificationPromptInput): string => `Sei il verificatore finale di Nous Reader.

Ricevi una bozza quasi finale di lezione. Devi fare un controllo conclusivo e correggere SOLO cio che serve.
${buildUserGenerationNotesBlock(generationNotes)}
TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"
CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.

OBIETTIVI DI VERIFICA:
1. La lezione deve restare strettamente nel focus della lezione corrente.
2. ${continuityRule}
3. Devono valere tutti questi vincoli di focus:
${scopeRule}
4. \`quiz\` deve contenere ESATTAMENTE ${clampLessonQuizCount(targetQuizCount)} pause attive con ESATTAMENTE 4 opzioni ciascuna.
5. Ogni pausa deve avere \`exerciseType\` scelto da questo catalogo trasversale:
${ACTIVE_PAUSE_EXERCISE_TYPE_RULES}
6. Non generare sempre domande: alterna consegne brevi, micro-casi, diagnosi, classificazioni, previsioni e sintesi quando sono pertinenti alla lezione.
7. Le pause del \`quiz\` NON devono mai chiedere di ripetere alla lettera una definizione appena data o copiare una frase della lezione.
8. Ogni pausa deve richiedere almeno una tra queste operazioni mentali: applicare un concetto a un caso, confrontare due casi, prevedere una conseguenza, riconoscere un errore, classificare un esempio, scegliere l'implicazione corretta.
9. I distrattori devono essere plausibili: niente opzioni caricaturali o palesemente assurde.
10. Le stringhe di \`quiz.question\` e \`quiz.options\` devono essere testo normale: non racchiudere MAI l'intera consegna o l'intera opzione in backticks, inline code o code fence. I backticks sono ammessi solo per un singolo termine, simbolo o identificatore interno alla frase quando servono davvero.
11. \`contentMarkdown\` non deve contenere quiz, markdown image syntax, tag <img>, assetId tecnici o riferimenti sbagliati alle immagini.
12. I heading devono essere coerenti e ogni \`anchorHeading\` in \`imagePlacements\` deve corrispondere ESATTAMENTE a un heading presente in \`contentMarkdown\`.
13. Ogni immagine selezionata deve essere nel punto giusto della lezione: stessa sezione concettuale, stessa descrizione, stesso argomento.
14. Verifica con particolare severita che descrizione, caption e immagine siano abbinate correttamente: se una figura parla di ambient occlusion non puo essere usata per decals, overlay, particelle o altri argomenti diversi.
15. Ogni immagine selezionata deve anche essere visivamente chiara e autosufficiente: se appare sfocata, parziale, tagliata, poco leggibile, mostra solo un bordo, un wrapper, un riquadro, un badge, un'icona o un frammento non riconoscibile, rimuovila.
16. Se una figura e debole, ambigua, fuori tema o messa sotto il heading sbagliato, correggila o rimuovila. Meglio meno immagini che immagini sbagliate.
17. Se trovi forestierismi inutili nel testo, sostituiscili con equivalenti italiani naturali, salvo casi in cui il termine straniero sia davvero lo standard tecnico necessario.
18. Mantieni i contenuti validi e fai modifiche minime: non riscrivere tutto se non serve.
19. Se nessuna immagine candidata e chiaramente giusta, restituisci \`imagePlacements: []\`.
20. Verifica con severita anche la formattazione KaTeX/LaTeX: formule inline solo con \`$...$\` oppure \`\\(...\\)\`; formule display solo con \`$$...$$\` oppure \`\\[...\\]\`. Non lasciare righe orfane con solo \`[\`, \`]\`, \`\\[\` o \`\\]\`, non mischiare delimitatori diversi nella stessa formula, e correggi delimitatori o graffe non bilanciati.
21. Verifica con severita i blocchi di codice/pseudocodice Markdown: se un esempio e spezzato in piu blocchi \`\`\`text\` con righe del corpo fuori dal blocco, correggilo in UN SOLO code block che contenga firma, corpo, parentesi graffe e RETURN. Questo e un errore di formattazione, anche se il testo e semanticamente comprensibile.
22. Restituisci SOLO un oggetto JSON valido che rispetti esattamente lo schema richiesto.
23. Nei dati immagine, \`caption\` e una descrizione sintetica generata a partire dalla figura. Valuta la pertinenza usando solo la figura descritta da \`caption\`, il suo \`visibleLabel\` e il contesto della lezione, senza inventare dettagli non presenti.

ESTRATTI RILEVANTI DAL PDF / CONTESTO SORGENTE:
${sourceContext.slice(0, MAX_LESSON_REPAIR_SOURCE_CHARS)}

IMMAGINI CANDIDATE DISPONIBILI:
${candidateImages.length > 0 ? JSON.stringify(candidateImages, null, 2) : '[]'}

BOZZA ATTUALE DA VERIFICARE:
${JSON.stringify(draft, null, 2)}

Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "contentMarkdown": "Lezione finale verificata in markdown",
  "quiz": [
    { "exerciseType": "application-card", "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }
  ],
  "imagePlacements": [
    { "assetId": "pdf-img-001", "alt": "Descrizione breve", "caption": "Caption opzionale", "anchorHeading": "Analisi Approfondita" }
  ]
}`;

export const verifyLessonDraft = async ({
  sectionTitle,
  sectionDescription,
  previousContext,
  sourceContext,
  continuityRule,
  scopeRule,
  targetQuizCount,
  draft,
  candidateImages,
  generationNotes,
}: BuildLessonVerificationPromptInput): Promise<LessonVerificationDraft> => {
  const verificationPrompt = buildLessonVerificationPrompt({
    sectionTitle,
    sectionDescription,
    previousContext,
    sourceContext,
    continuityRule,
    scopeRule,
    targetQuizCount,
    draft,
    candidateImages,
    generationNotes,
  });

  const parsed = await retryWithBackoff(
    async () => {
      const response = await callOpenRouter({
        model: MODEL_FLASH,
        reasoning: MEDIUM_REASONING_CONFIG,
        messages: [
          { role: 'system', content: teacherInstruction },
          { role: 'user', content: verificationPrompt },
        ],
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: buildLessonResponseSchema(targetQuizCount),
        },
      });
      return parseCleanJson<PdfSectionContentPayload>(response || '{}');
    },
    1,
    500
  );
  const verifiedQuiz = parseQuizPayload(parsed.quiz);
  return {
    contentMarkdown:
      typeof parsed.contentMarkdown === 'string' && parsed.contentMarkdown.trim()
        ? parsed.contentMarkdown
        : draft.contentMarkdown,
    quiz:
      verifiedQuiz.length > 0
        ? normalizeQuizLength(verifiedQuiz, targetQuizCount)
        : normalizeQuizLength(draft.quiz, targetQuizCount),
    imagePlacements: Array.isArray(parsed.imagePlacements)
      ? parsed.imagePlacements
          .filter(
            (placement): placement is LessonImageRef =>
              Boolean(placement) &&
              typeof placement.assetId === 'string' &&
              typeof placement.alt === 'string'
          )
          .map(placement => ({
            assetId: placement.assetId,
            alt: placement.alt,
            caption: placement.caption,
            anchorHeading: placement.anchorHeading,
          }))
      : draft.imagePlacements,
  };
};
