import type { LessonContentBlock } from '../../types.ts';
import { ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE } from '../../utils/learning/activePause.ts';
import {
  buildLessonVerificationChecklist,
  type LessonInstructionPackId,
  type LessonVerificationChecklistItem,
} from '../../utils/learning/lessonInstructionPacks.ts';
import {
  deriveQuizFromLessonContentBlocks,
  hasValidTypedQuizBlocks,
  legacyMarkdownToLessonContentBlocks,
  lessonContentBlocksToLegacyMarkdown,
  normalizeLessonContentBlocks,
} from '../../utils/reader/lessonContentBlocks.ts';
import { pushNousDebugTrace } from '../core/debugTrace.ts';
import { MEDIUM_REASONING_CONFIG } from './config.ts';
import type { SectionImagePlacement } from './lessonImages.ts';
import {
  clampLessonQuizCount,
  LESSON_QUIZ_OPTION_COUNT,
  MAX_LESSON_QUIZ_QUESTIONS,
  MIN_LESSON_QUIZ_QUESTIONS,
  parseQuizPayload,
} from './lessonMarkdownQuality/index.ts';
import {
  buildUserGenerationNotesBlock,
  FORMULA_RELEVANCE_RULE,
  INTERNAL_REASONING_EFFICIENCY_INSTRUCTION,
  LESSON_LOCAL_PROPEDEUTIC_RULES,
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
  contentBlocks?: LessonContentBlock[];
  contentMarkdown?: string;
  quiz?: QuizQuestion[];
  verificationReport?: LessonVerificationReportItem[];
  imagePlacements?: SectionImagePlacement[];
  visualPlanning: {
    plans: VerifiedVisualSlotPlan[];
    rationale: string;
  };
}

interface LessonVerificationReportItem {
  action: string;
  checkId: string;
  evidence: string;
  status: 'corrected' | 'not-applicable' | 'pass';
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
  const contentBlocks = normalizeLessonContentBlocks(parsed.contentBlocks);
  const contentMarkdown = contentBlocks.length
    ? lessonContentBlocksToLegacyMarkdown(contentBlocks)
    : parsed.contentMarkdown?.trim() || '';
  if (contentMarkdown) {
    const legacyQuiz = parseQuizPayload(parsed.quiz);
    const normalizedBlocks = contentBlocks.length
      ? contentBlocks
      : legacyMarkdownToLessonContentBlocks(contentMarkdown, legacyQuiz);
    const quiz = contentBlocks.length
      ? parseQuizPayload(deriveQuizFromLessonContentBlocks(normalizedBlocks))
      : legacyQuiz;
    const hasValidInlineQuizMarkers = hasValidTypedQuizBlocks(normalizedBlocks, {
      max: MAX_LESSON_QUIZ_QUESTIONS,
      min: MIN_LESSON_QUIZ_QUESTIONS,
    });
    pushNousDebugTrace('lesson-forensics:parsed-draft', {
      contentBlocks: normalizedBlocks,
      contentMarkdown,
      hasValidInlineQuizMarkers,
      parsedPayload: parsed,
      quiz,
      response,
      sectionTitle,
    });
    if (!hasValidInlineQuizMarkers) {
      throw new Error('La lezione non rispetta il contratto dei blocchi quiz inline.');
    }

    return {
      ...parsed,
      contentBlocks: normalizedBlocks,
      contentMarkdown,
      quiz,
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
  contentBlocks?: LessonContentBlock[];
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

const buildLessonResponseSchema = () => {
  return {
    name: 'nous_lesson_response',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contentBlocks: {
          type: 'array',
          minItems: 2,
          items: {
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { type: 'string', const: 'markdown' },
                  markdown: { type: 'string' },
                },
                required: ['type', 'markdown'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { type: 'string', const: 'inline-quiz' },
                  quiz: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      exerciseType: {
                        type: 'string',
                        enum: ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE.map(exercise => exercise.type),
                      },
                      question: { type: 'string' },
                      options: {
                        type: 'array',
                        minItems: LESSON_QUIZ_OPTION_COUNT,
                        maxItems: LESSON_QUIZ_OPTION_COUNT,
                        items: { type: 'string' },
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
                required: ['type', 'quiz'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { type: 'string', const: 'youtube-clips' },
                  clips: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        sourceIndex: { type: 'integer', minimum: 0 },
                        startSeconds: { type: 'number', minimum: 0 },
                        endSeconds: { type: 'number', minimum: 0 },
                        title: { type: 'string' },
                      },
                      required: ['sourceIndex', 'startSeconds', 'endSeconds', 'title'],
                    },
                  },
                },
                required: ['type', 'clips'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { type: 'string', const: 'generated-visual' },
                  slotId: { type: 'string' },
                },
                required: ['type', 'slotId'],
              },
            ],
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
      required: ['contentBlocks', 'imagePlacements', 'visualPlanning'],
    },
  } as const;
};

const buildLessonVerificationResponseSchema = (
  checklist: readonly LessonVerificationChecklistItem[]
) => {
  const lessonResponseSchema = buildLessonResponseSchema();
  return {
    ...lessonResponseSchema,
    name: 'nous_lesson_verification_response',
    schema: {
      ...lessonResponseSchema.schema,
      properties: {
        ...lessonResponseSchema.schema.properties,
        verificationReport: {
          type: 'array',
          minItems: checklist.length,
          maxItems: checklist.length,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              checkId: { type: 'string', enum: checklist.map(item => item.checkId) },
              status: {
                type: 'string',
                enum: ['pass', 'corrected', 'not-applicable'],
              },
              evidence: { type: 'string' },
              action: { type: 'string' },
            },
            required: ['checkId', 'status', 'evidence', 'action'],
          },
        },
      },
      required: [...lessonResponseSchema.schema.required, 'verificationReport'],
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
  instructionPacks?: LessonInstructionPackId[];
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
  instructionPacks,
}: BuildLessonVerificationPromptInput): string => {
  const checklist = buildLessonVerificationChecklist(instructionPacks);
  return `Sei il verificatore finale di Nous Reader.

Ricevi una bozza quasi finale di lezione. Devi fare un controllo conclusivo e correggere SOLO cio che serve.
${buildUserGenerationNotesBlock(generationNotes)}
TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"
CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.

OBIETTIVI DI VERIFICA:
Compila obbligatoriamente una voce di \`verificationReport\` per CIASCUNO dei controlli seguenti, usando esattamente il relativo \`checkId\`:
${checklist.map(item => `- ${item.checkId}: ${item.instruction}`).join('\n')}

1. La lezione deve restare strettamente nel focus della lezione corrente.
2. ${continuityRule}
3. Devono valere tutti questi vincoli di focus:
${scopeRule}
4. \`contentBlocks\` deve contenere ESATTAMENTE ${clampLessonQuizCount(targetQuizCount)} blocchi inline-quiz con ESATTAMENTE 4 opzioni ciascuno.
5. Ogni pausa deve avere \`exerciseType\` scelto da questo catalogo trasversale:
${ACTIVE_PAUSE_EXERCISE_TYPE_RULES}
6. Non generare sempre domande: alterna consegne brevi, micro-casi, diagnosi, classificazioni, previsioni e sintesi quando sono pertinenti alla lezione.
7. Le pause del \`quiz\` NON devono mai chiedere di ripetere alla lettera una definizione appena data o copiare una frase della lezione.
8. Ogni pausa deve richiedere almeno una tra queste operazioni mentali: applicare un concetto a un caso, confrontare due casi, prevedere una conseguenza, riconoscere un errore, classificare un esempio, scegliere l'implicazione corretta.
9. Le quattro opzioni di ogni pausa devono essere testualmente distinte. I distrattori devono essere plausibili: niente opzioni caricaturali o palesemente assurde.
10. Le stringhe \`question\` e \`options\` dei blocchi inline-quiz devono essere testo normale: non racchiudere MAI l'intera consegna o opzione in backticks o code fence.
10a. La posizione di ogni pausa fa parte della stesura. In \`contentBlocks\`, inserisci un blocco \`inline-quiz\` che contiene direttamente l'oggetto \`quiz\`, subito DOPO il blocco markdown che completa le informazioni necessarie.
10b. Non restituire un array quiz separato: la sequenza dei blocchi e la fonte di verita. Non raggruppare le pause in fondo e non usare marker testuali o ancore indirette.
11. I blocchi markdown non devono contenere sezioni quiz, marker strutturali, markdown image syntax, tag <img>, assetId tecnici o riferimenti sbagliati alle immagini.
12. I heading devono essere coerenti e ogni \`anchorHeading\` in \`imagePlacements\` deve corrispondere ESATTAMENTE a un heading presente in un blocco markdown.
13. Ogni immagine selezionata deve essere nel punto giusto della lezione: stessa sezione concettuale, stessa descrizione, stesso argomento. Deve avere un collegamento bidirezionale con il testo vicino: il paragrafo deve spiegare cio che la figura mostra, e la figura deve rappresentare cio che il paragrafo sta spiegando.
14. Verifica con particolare severita che descrizione, caption, immagine e paragrafo vicino siano abbinati correttamente: se una figura parla di ambient occlusion non puo essere usata per decals, overlay, particelle o altri argomenti diversi.
15. Ogni immagine selezionata deve anche essere visivamente chiara e autosufficiente: se appare sfocata, parziale, tagliata, poco leggibile, mostra solo un bordo, un wrapper, un riquadro, un badge, un'icona o un frammento non riconoscibile, rimuovila.
16. Se una figura e debole, ambigua, fuori tema, decorativa, non richiamata dal testo vicino o messa sotto il heading sbagliato, correggila o rimuovila. Meglio meno immagini che immagini sbagliate.
17. Se trovi forestierismi inutili nel testo, sostituiscili con equivalenti italiani naturali, salvo casi in cui il termine straniero sia davvero lo standard tecnico necessario.
17a. Verifica l'ordine propedeutico LOCALE della bozza, paragrafo per paragrafo, e correggi ogni violazione:
${LESSON_LOCAL_PROPEDEUTIC_RULES.map(rule => `- ${rule}`).join('\n')}
17b. Rimuovi o sposta in avanti frasi che introducono dipendenze premature, come nomi di strutture, proprieta, convenzioni, eccezioni o operazioni che saranno spiegate soltanto in una sezione successiva. Formula e spiegazione possono precedersi in qualunque ordine quando restano nello stesso blocco locale o in paragrafi immediatamente adiacenti.
17c. Rimuovi i chiarimenti preventivi che aggiungono carico cognitivo senza risolvere un dubbio necessario al passaggio corrente. Se una precisazione serve davvero ma dipende da nozioni successive, sostituiscila con una breve anticipazione esplicita oppure spostala dopo l'introduzione dei prerequisiti.
17d. Applica davvero le note di personalizzazione: se chiedono lentezza, spiegazioni matematiche elementari o ridondanza didattica, non preservare una bozza densa soltanto perche tecnicamente corretta. Correggi con il minimo intervento sufficiente a rendere graduale la progressione.
18. Mantieni i contenuti validi e fai modifiche minime: non riscrivere tutto se non serve.
19. Se nessuna immagine candidata e chiaramente giusta, restituisci \`imagePlacements: []\`.
20. ${FORMULA_RELEVANCE_RULE} Rimuovi le formule decorative o estranee al materiale. Per le formule pertinenti, verifica con severita anche la formattazione KaTeX/LaTeX: formule inline solo con \`$...$\` oppure \`\\(...\\)\`; formule display solo con \`$$...$$\` oppure \`\\[...\\]\`. Non lasciare righe orfane con solo \`[\`, \`]\`, \`\\[\` o \`\\]\`, non mischiare delimitatori diversi nella stessa formula, e correggi delimitatori o graffe non bilanciati.
21. Verifica con severita tutti gli esempi tecnici che devono essere resi come blocchi preformattati: codice, pseudocodice, sequenze di bit, tracciati, comandi e output. Se un esempio non ha fence Markdown, ha soltanto un'etichetta di linguaggio nuda, oppure e spezzato tra piu fence e righe esterne, racchiudilo interamente in UN SOLO code block con un linguaggio appropriato. Non trasformare normale prosa o formule LaTeX in blocchi di codice. Questo e un errore di formattazione anche quando il contenuto resta semanticamente comprensibile.
22. La stesura colloca gli esempi visuali con blocchi \`generated-visual\` associati a \`visualPlanning.plans\` tramite \`slotId\`. Ogni piano deve avere esattamente un blocco e viceversa, fino a ${MAX_GENERATED_VISUALS_PER_LESSON}.
23. Pianifica un visuale solo quando migliora davvero la comprensione. ${VISUAL_FORMAT_SELECTION_RULE} ${INTERACTIVE_VISUAL_VALUE_RULE} I worker grafici non hanno comprensione spaziale affidabile: gli artefatti HTML devono generare la grafica con regole o algoritmi, non disegnarla a mano.
24. Verifica ogni blocco \`youtube-clips\` contro i transcript timestampati. Ogni clip contiene \`sourceIndex\`, \`startSeconds\`, \`endSeconds\` e un \`title\` breve che descrive il momento specifico mostrato, non il titolo generico del video. Il blocco deve stare subito dopo il markdown che spiega cosa osservare.
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
  "contentBlocks": [
    { "type": "markdown", "markdown": "## Sezione\\n\\nTesto della lezione." },
    { "type": "inline-quiz", "quiz": { "exerciseType": "application-card", "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 } }
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
  },
  "verificationReport": [
    {
      "checkId": "core.instructions",
      "status": "pass|corrected|not-applicable",
      "evidence": "Evidenza breve e specifica osservata nella lezione",
      "action": "Correzione applicata, oppure stringa vuota"
    }
  ]
}`;
};

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
  instructionPacks,
  onReasoningUpdate,
}: VerifyLessonDraftInput): Promise<LessonVerificationDraft> => {
  const verificationChecklist = buildLessonVerificationChecklist(instructionPacks);
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
    instructionPacks,
  });
  pushNousDebugTrace('lesson-forensics:verification-input', {
    draft,
    sectionDescription,
    sectionTitle,
    targetQuizCount,
    verificationPrompt,
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
          json_schema: buildLessonVerificationResponseSchema(verificationChecklist),
        },
      });
      pushNousDebugTrace('lesson-forensics:verification-response', {
        response,
        sectionTitle,
        targetQuizCount,
      });
      return parseCleanJson<PdfSectionContentPayload>(response || '{}');
    },
    1,
    500
  );
  const reportedCheckIds = new Set(
    Array.isArray(parsed.verificationReport)
      ? parsed.verificationReport.map(item => item.checkId)
      : []
  );
  if (
    reportedCheckIds.size !== verificationChecklist.length ||
    verificationChecklist.some(item => !reportedCheckIds.has(item.checkId))
  ) {
    throw new Error('La verifica non ha compilato tutti i controlli richiesti.');
  }
  const contentBlocks = normalizeLessonContentBlocks(parsed.contentBlocks);
  const effectiveBlocks = contentBlocks.length
    ? contentBlocks
    : (draft.contentBlocks ??
      legacyMarkdownToLessonContentBlocks(draft.contentMarkdown, draft.quiz));
  const contentMarkdown = lessonContentBlocksToLegacyMarkdown(effectiveBlocks);
  const parsedVisualPlans = Array.isArray(parsed.visualPlanning?.plans)
    ? parsed.visualPlanning.plans
    : [];
  const seenSlotIds = new Set<string>();
  const visualPlans = parsedVisualPlans.filter(plan => {
    const slotId = plan.slotId?.trim();
    if (
      !slotId ||
      seenSlotIds.has(slotId) ||
      !effectiveBlocks.some(block => block.type === 'generated-visual' && block.slotId === slotId)
    ) {
      return false;
    }
    seenSlotIds.add(slotId);
    return (
      effectiveBlocks.filter(block => block.type === 'generated-visual' && block.slotId === slotId)
        .length === 1
    );
  });
  const quiz = parseQuizPayload(deriveQuizFromLessonContentBlocks(effectiveBlocks));
  const hasValidInlineQuizMarkers = hasValidTypedQuizBlocks(effectiveBlocks, {
    exact: clampLessonQuizCount(targetQuizCount),
  });
  pushNousDebugTrace('lesson-forensics:verification-output', {
    contentMarkdown,
    hasValidInlineQuizMarkers,
    parsedPayload: parsed,
    quiz,
    sectionTitle,
    targetQuizCount,
  });
  if (!hasValidInlineQuizMarkers) {
    throw new Error('La verifica non ha restituito blocchi quiz inline validi.');
  }

  return {
    contentBlocks: effectiveBlocks,
    contentMarkdown,
    quiz,
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
