import { ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE } from '../../utils/learning/activePause.ts';
import { MEDIUM_REASONING_CONFIG } from './config.ts';
import type { SectionImagePlacement } from './lessonImages.ts';
import {
  clampLessonQuizCount,
  LESSON_QUIZ_OPTION_COUNT,
  MAX_LESSON_QUIZ_QUESTIONS,
  MIN_LESSON_QUIZ_QUESTIONS,
  normalizeQuizLength,
  parseQuizPayload,
} from './lessonMarkdownQuality/index.ts';
import {
  buildUserGenerationNotesBlock,
  FORMULA_RELEVANCE_RULE,
  INTERNAL_REASONING_EFFICIENCY_INSTRUCTION,
} from './prompts.ts';
import {
  callOpenRouter,
  type LessonImageRef,
  MODEL_FLASH,
  parseCleanJson,
  type QuizQuestion,
  retryWithBackoff,
  teacherInstruction,
} from './shared.ts';
import {
  INTERACTIVE_VISUAL_VALUE_RULE,
  MAX_GENERATED_VISUALS_PER_LESSON,
  type VerifiedVisualSlotPlan,
  VISUAL_FORMAT_SELECTION_RULE,
} from './visualExamples.ts';

interface PdfSectionContentPayload {
  contentMarkdown?: string;
  quiz?: QuizQuestion[];
  imagePlacements?: SectionImagePlacement[];
  visualPlanning: {
    plans: VerifiedVisualSlotPlan[];
    rationale: string;
  };
}

const normalizeVisualPlanningPayload = (
  visualPlanning?: Partial<PdfSectionContentPayload['visualPlanning']>
): PdfSectionContentPayload['visualPlanning'] => ({
  plans: Array.isArray(visualPlanning?.plans) ? visualPlanning.plans : [],
  rationale:
    visualPlanning?.rationale?.trim() || 'La stesura non ha proposto esempi visuali generati.',
});

export const parseLessonContentPayload = (
  response: string,
  sectionTitle: string
): PdfSectionContentPayload => {
  const parsed = parseCleanJson<PdfSectionContentPayload>(response || '{}');
  if (parsed.contentMarkdown?.trim()) {
    return {
      ...parsed,
      visualPlanning: normalizeVisualPlanningPayload(parsed.visualPlanning),
    };
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
  visualPlanning: {
    plans: VerifiedVisualSlotPlan[];
    rationale: string;
  };
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
              anchorExcerpt: {
                type: ['string', 'null'],
              },
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
            required: ['anchorExcerpt', 'exerciseType', 'question', 'options', 'correctIndex'],
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
        visualPlanning: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rationale: { type: 'string' },
            plans: {
              type: 'array',
              maxItems: MAX_GENERATED_VISUALS_PER_LESSON,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  slotId: { type: 'string' },
                  complexity: {
                    type: 'string',
                    enum: ['simple', 'moderate', 'complex'],
                  },
                  concept: { type: 'string' },
                  coverage: {
                    type: 'string',
                    enum: ['all_elements', 'single_complex', 'complete_synthesis', 'none'],
                  },
                  coverageRationale: { type: 'string' },
                  factualRequirements: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  interactionLevel: {
                    type: 'string',
                    enum: ['none', 'low', 'high'],
                  },
                  pedagogicalGoal: { type: 'string' },
                  reason: { type: 'string' },
                  requiresDepiction: { type: 'boolean' },
                  visualDirection: { type: 'string' },
                  visualType: {
                    type: 'string',
                    enum: [
                      'chart_html',
                      'flowchart_svg',
                      'illustrative_image',
                      'interactive_html',
                      'mermaid_class',
                      'mermaid_erd',
                      'structural_svg',
                    ],
                  },
                },
                required: [
                  'slotId',
                  'complexity',
                  'concept',
                  'coverage',
                  'coverageRationale',
                  'factualRequirements',
                  'interactionLevel',
                  'pedagogicalGoal',
                  'reason',
                  'requiresDepiction',
                  'visualDirection',
                  'visualType',
                ],
              },
            },
          },
          required: ['rationale', 'plans'],
        },
      },
      required: ['contentMarkdown', 'quiz', 'imagePlacements', 'visualPlanning'],
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

interface VerifyLessonDraftInput extends BuildLessonVerificationPromptInput {
  onReasoningUpdate?: (reasoning: string) => void;
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
10a. Per ogni pausa, \`anchorExcerpt\` deve copiare un breve estratto ESATTO dell'ultimo paragrafo che lo studente deve leggere prima della pausa. Il modello decide cosi il punto editoriale preciso; non usare il heading come scorciatoia e non anticipare una pausa prima delle informazioni necessarie.
11. \`contentMarkdown\` non deve contenere quiz, markdown image syntax, tag <img>, assetId tecnici o riferimenti sbagliati alle immagini.
12. I heading devono essere coerenti e ogni \`anchorHeading\` in \`imagePlacements\` deve corrispondere ESATTAMENTE a un heading presente in \`contentMarkdown\`.
13. Ogni immagine selezionata deve essere nel punto giusto della lezione: stessa sezione concettuale, stessa descrizione, stesso argomento. Deve avere un collegamento bidirezionale con il testo vicino: il paragrafo deve spiegare cio che la figura mostra, e la figura deve rappresentare cio che il paragrafo sta spiegando.
14. Verifica con particolare severita che descrizione, caption, immagine e paragrafo vicino siano abbinati correttamente: se una figura parla di ambient occlusion non puo essere usata per decals, overlay, particelle o altri argomenti diversi.
15. Ogni immagine selezionata deve anche essere visivamente chiara e autosufficiente: se appare sfocata, parziale, tagliata, poco leggibile, mostra solo un bordo, un wrapper, un riquadro, un badge, un'icona o un frammento non riconoscibile, rimuovila.
16. Se una figura e debole, ambigua, fuori tema, decorativa, non richiamata dal testo vicino o messa sotto il heading sbagliato, correggila o rimuovila. Meglio meno immagini che immagini sbagliate.
17. Se trovi forestierismi inutili nel testo, sostituiscili con equivalenti italiani naturali, salvo casi in cui il termine straniero sia davvero lo standard tecnico necessario.
18. Mantieni i contenuti validi e fai modifiche minime: non riscrivere tutto se non serve.
19. Se nessuna immagine candidata e chiaramente giusta, restituisci \`imagePlacements: []\`.
20. ${FORMULA_RELEVANCE_RULE} Rimuovi le formule decorative o estranee al materiale. Per le formule pertinenti, verifica con severita anche la formattazione KaTeX/LaTeX: formule inline solo con \`$...$\` oppure \`\\(...\\)\`; formule display solo con \`$$...$$\` oppure \`\\[...\\]\`. Non lasciare righe orfane con solo \`[\`, \`]\`, \`\\[\` o \`\\]\`, non mischiare delimitatori diversi nella stessa formula, e correggi delimitatori o graffe non bilanciati.
21. Verifica con severita tutti gli esempi tecnici che devono essere resi come blocchi preformattati: codice, pseudocodice, sequenze di bit, tracciati, comandi e output. Se un esempio non ha fence Markdown, ha soltanto un'etichetta di linguaggio nuda, oppure e spezzato tra piu fence e righe esterne, racchiudilo interamente in UN SOLO code block con un linguaggio appropriato. Non trasformare normale prosa o formule LaTeX in blocchi di codice. Questo e un errore di formattazione anche quando il contenuto resta semanticamente comprensibile.
22. La stesura ha gia deciso e collocato gli esempi visuali tramite \`visualPlanning.plans\` e tag \`{{VISUAL_SLOT:slot-001}}\` dentro \`contentMarkdown\`. Verifica questa decisione insieme al testo: conserva i tag validi nel loro punto editoriale, spostali nel testo se la revisione cambia il contesto, correggi o rimuovi piani deboli e aggiungine uno solo se la stesura ha omesso un aiuto chiaramente necessario. Non descrivere una posizione tramite heading o estratti: il tag E la posizione. Nel risultato ogni piano deve avere esattamente un tag e ogni tag esattamente un piano, fino a ${MAX_GENERATED_VISUALS_PER_LESSON}. Usa identificatori sequenziali \`slot-001\`, \`slot-002\`, ecc.
23. Pianifica un visuale solo quando migliora davvero la comprensione. ${VISUAL_FORMAT_SELECTION_RULE} ${INTERACTIVE_VISUAL_VALUE_RULE} I worker grafici non hanno comprensione spaziale affidabile: gli artefatti HTML devono generare la grafica con regole o algoritmi, non disegnarla a mano.
24. Verifica i marker YouTube \`{{YOUTUBE_CLIP_SOURCE:indice|START:secondi|END:secondi}}\` contro il transcript timestampato della stessa fonte. La stesura decide intervallo e posizione mentre scrive: conserva ogni scelta valida, correggi indice o tempi quando l'evidenza lo permette e rimuovila soltanto quando il transcript non la sostiene. Se la lezione insegna principalmente una procedura pratica, visiva, fisica, sonora, temporale o multistep e un transcript selezionato ne mostra direttamente l'azione, l'assenza di una clip inline e un errore editoriale: aggiungi il marker nel punto pertinente. Il marker deve restare subito dopo il paragrafo che spiega cosa osservare, mai in fondo alla lezione o in una sezione fonti.
25. Restituisci SOLO un oggetto JSON valido che rispetti esattamente lo schema richiesto.
26. Nei dati immagine, \`caption\` e una descrizione sintetica generata a partire dalla figura. Valuta la pertinenza usando solo la figura descritta da \`caption\`, il suo \`visibleLabel\` e il contesto della lezione, senza inventare dettagli non presenti. Se manca una frase vicina che aiuta il lettore a usare la figura, aggiungila con modifica minima oppure rimuovi l'immagine.

ESTRATTI RILEVANTI DAL PDF / CONTESTO SORGENTE:
${sourceContext}

IMMAGINI CANDIDATE DISPONIBILI:
${candidateImages.length > 0 ? JSON.stringify(candidateImages, null, 2) : '[]'}

BOZZA ATTUALE DA VERIFICARE:
${JSON.stringify(draft, null, 2)}

Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "contentMarkdown": "Lezione finale verificata in markdown",
  "quiz": [
    { "anchorExcerpt": "estratto esatto del paragrafo precedente", "exerciseType": "application-card", "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }
  ],
  "imagePlacements": [
    { "assetId": "pdf-img-001", "alt": "Descrizione breve", "caption": "Caption opzionale", "anchorHeading": "Analisi Approfondita" }
  ],
  "visualPlanning": {
    "rationale": "Motivazione sintetica della scelta",
    "plans": [
      {
        "slotId": "slot-001",
        "complexity": "moderate",
        "concept": "Concetto da mostrare",
        "coverage": "single_complex",
        "coverageRationale": "Perche questo perimetro e completo",
        "factualRequirements": ["Vincolo fattuale verificabile"],
        "interactionLevel": "none",
        "pedagogicalGoal": "Cosa deve capire lo studente",
        "reason": "Perche il visuale e utile",
        "requiresDepiction": true,
        "visualDirection": "Direzione visiva concreta",
        "visualType": "illustrative_image"
      }
    ]
  }
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
  onReasoningUpdate,
}: VerifyLessonDraftInput): Promise<LessonVerificationDraft> => {
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
        modelSlot: 'lesson',
        onReasoningUpdate,
        reasoning: MEDIUM_REASONING_CONFIG,
        messages: [
          {
            role: 'system',
            content: `${teacherInstruction}\n\n${INTERNAL_REASONING_EFFICIENCY_INSTRUCTION}`,
          },
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
  const contentMarkdown =
    typeof parsed.contentMarkdown === 'string' && parsed.contentMarkdown.trim()
      ? parsed.contentMarkdown
      : draft.contentMarkdown;
  const parsedVisualPlans = Array.isArray(parsed.visualPlanning?.plans)
    ? parsed.visualPlanning.plans
    : [];
  const seenSlotIds = new Set<string>();
  const visualPlans = parsedVisualPlans.filter(plan => {
    const slotId = plan.slotId?.trim();
    const marker = `{{VISUAL_SLOT:${slotId}}}`;
    if (!slotId || seenSlotIds.has(slotId) || !contentMarkdown.includes(marker)) {
      return false;
    }
    seenSlotIds.add(slotId);
    return contentMarkdown.indexOf(marker) === contentMarkdown.lastIndexOf(marker);
  });
  return {
    contentMarkdown,
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
    visualPlanning: {
      plans: visualPlans,
      rationale:
        parsed.visualPlanning?.rationale?.trim() ||
        (visualPlans.length > 0
          ? 'Pianificazione visuale integrata nella verifica finale.'
          : 'Nessun esempio visuale aggiuntivo selezionato.'),
    },
  };
};
