import { pushNousDebugTrace } from '../../core/debugTrace.ts';
import { MEDIUM_REASONING_CONFIG } from '../config.ts';
import { buildLessonChunkContext } from '../documentIndex/index.ts';
import type { GenerationStatusReporter } from '../generationProgress.ts';
import { generateLessonLearningAids } from '../learningAids.ts';
import {
  buildFallbackImageRefs,
  buildVisibleImageLabel,
  getMarkdownHeadings,
  injectImagePlaceholders,
  materializeGeneratedVisualSlots,
  normalizeImagePlacements,
  selectCandidatePdfImages,
} from '../lessonImages.ts';
import {
  estimateTargetQuizCount,
  MAX_LESSON_REPAIR_SOURCE_CHARS,
  normalizeQuizLength,
  parseQuizPayload,
  repairLessonMarkdown,
  sanitizeLessonMarkdownContent,
} from '../lessonMarkdownQuality/index.ts';
import {
  ACTIVE_PAUSE_EXERCISE_TYPE_RULES,
  LESSON_RESPONSE_SCHEMA,
  type LessonVerificationDraft,
  parseLessonContentPayload,
  verifyLessonDraft,
} from '../lessonVerification.ts';
import {
  buildStoredPdfDocumentAssets,
  getPdfAssetSession,
  getPdfTextSession,
} from '../pdfAssets.ts';
import {
  buildPdfChunkUsageDebugPayload,
  estimateRelevantPdfImagePages,
} from '../pdfLessonContext.ts';
import { buildReasoningContentForFile, clipPdfSourceText } from '../pdfReasoning.ts';
import {
  buildUserGenerationNotesBlock,
  LESSON_SCOPE_RULES,
  LESSON_SHARED_WRITING_RULES,
} from '../prompts.ts';
import {
  callOpenRouter,
  type FileData,
  isPdfFile,
  type LessonGeneratedVisual,
  type LessonImageRef,
  type LessonLearningAid,
  type LessonVisualPlanningDecision,
  MODEL_REASONING,
  type PdfDocumentAssets,
  type PdfTextIndex,
  type QuizQuestion,
  retryWithBackoff,
  teacherInstruction,
} from '../shared.ts';
import {
  INTERACTIVE_VISUAL_VALUE_RULE,
  MAX_GENERATED_VISUALS_PER_LESSON,
  VISUAL_FORMAT_SELECTION_RULE,
} from '../visualExamples.ts';

const MAX_PDF_FALLBACK_LESSON_SOURCE_CHARS = 36_000;
const PDF_ASSET_SESSION_TIMEOUT_MS = 60_000;
const LESSON_MARKDOWN_TRACE_PREVIEW_CHARS = 1600;

class SoftTimeoutError extends Error {
  timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'SoftTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

const summarizeLessonMarkdownForTrace = (content: string) => ({
  hasCodeFence: /(^|\n)```/.test(content),
  length: content.length,
  preview: content.slice(0, LESSON_MARKDOWN_TRACE_PREVIEW_CHARS),
});

const withSoftTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise.then(
        value => value,
        error => {
          throw error;
        }
      ),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new SoftTimeoutError(`Operation exceeded soft timeout of ${timeoutMs}ms.`, timeoutMs)
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const isSoftTimeoutError = (error: unknown): error is SoftTimeoutError =>
  error instanceof SoftTimeoutError;

const traceLessonMarkdownStage = (
  stage: 'cleaned' | 'raw' | 'repaired' | 'verified',
  sectionTitle: string,
  content: string
) => {
  pushNousDebugTrace(`lesson-markdown:${stage}`, {
    sectionTitle,
    ...summarizeLessonMarkdownForTrace(content),
  });
};

const logPdfLessonDebug = (label: string, payload: Record<string, unknown>) => {
  console.groupCollapsed(`[Nous][PDF Lesson] ${label}`);
  Object.entries(payload).forEach(([key, value]) => {
    console.info(key, value);
  });
  console.groupEnd();
};

export const generateSectionContent = async (
  file: FileData,
  sectionTitle: string,
  sectionDescription: string,
  previousContext: string,
  primaryChunkIds?: string[],
  documentIndex?: PdfTextIndex | null,
  onStatusUpdate?: GenerationStatusReporter,
  generationNotes?: string,
  onReasoningUpdate?: (reasoning: string) => void
): Promise<{
  content: string;
  generatedVisuals: LessonGeneratedVisual[];
  learningAids: LessonLearningAid[];
  quiz: QuizQuestion[];
  visualPlanningDecision?: LessonVisualPlanningDecision;
  imageRefs: LessonImageRef[];
  documentAssets: PdfDocumentAssets | null;
}> => {
  onStatusUpdate?.('Preparazione materiale della lezione...', 'sources');
  const isFirstLesson = previousContext.trim().length === 0;
  const continuityRule = isFirstLesson
    ? "PRIMA LEZIONE: non citare lezioni precedenti, capitoli gia visti, 'come abbiamo accennato', 'come vedremo', o altre formule di continuita retroattiva."
    : 'Se fai riferimenti al percorso, fallo solo usando il contesto precedente fornito e senza inventare lezioni mai avvenute.';
  const scopeRule = LESSON_SCOPE_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
  const userNotesBlock = buildUserGenerationNotesBlock(generationNotes);
  const noRepetitionRule = isFirstLesson
    ? ''
    : `\n0. **SALTARE LE INTRODUZIONI GIA SVILUPPATE:** Le lezioni precedenti (${previousContext}) hanno gia coperto le basi, le definizioni fondative e la traiettoria storica generale del percorso. Questa lezione DEVE partire DIRETTAMENTE dall'argomento specifico indicato dal titolo e dalla descrizione. Non riesporre concetti, definizioni, classificazioni o linee temporali gia affrontati nelle lezioni precedenti — ogni lezione deve aggiungere contenuto informativo nuovo, non ripercorrere le fondamenta comuni.`;

  const buildLessonPrompt = (options: {
    sourcePrefix?: string;
    sourceContext?: string;
    imageRules?: string;
    candidateImagesPayload?: string;
    imagePlacementInstruction?: string;
  }) => {
    const {
      sourcePrefix = '',
      sourceContext = '',
      imageRules = '',
      candidateImagesPayload = '',
      imagePlacementInstruction = '30. **IMMAGINI**: Per questa richiesta `imagePlacements` deve essere un array vuoto.',
    } = options;

    return `Sei il Professor Nous. Devi generare una LEZIONE COMPLETA E APPROFONDITA${sourcePrefix}.
${userNotesBlock}
TITOLO LEZIONE: "${sectionTitle}"
DESCRIZIONE: "${sectionDescription}"
CONTESTO PRECEDENTE: ${previousContext || 'Inizio percorso'}.${noRepetitionRule}
${sourceContext}
REGOLE FONDAMENTALI:
1. Scrivi una lezione esaustiva in Markdown ricco, ma ad alta densita informativa: niente riempitivo, niente ripetizioni decorative, niente giri larghi per dire poco.
2. Incorpora e spiega i contenuti del documento in modo discorsivo ma tecnico, con esempi concreti, formule (LaTeX $$...$$) e codice solo quando aiutano davvero la comprensione. Non fare riferimento a sezioni, pagine o strutture del testo sorgente ('il documento', 'la sezione X', 'il testo afferma'): la lezione deve funzionare come testo autonomo, senza presupporre che il lettore abbia il documento aperto. Quando introduci un concetto per la prima volta, parti da una definizione positiva ('X e Y'): le formulazioni per contrasto ('X non e soltanto Y') sono accettabili solo dopo che il concetto e gia stato definito. Tratta tabelle, blocchi comparativi, matrici, didascalie, legende e label testuali di grafici come parte del contenuto tecnico della lezione, non come rumore.
3. Organizza il testo con heading chiari, ma usa solo le sezioni che servono davvero a questa lezione. Non creare heading riempitivi.
4. Ogni sezione deve aggiungere informazione nuova. Non rispiegare la stessa definizione in Introduzione, Concetti Fondamentali e Analisi Approfondita con semplici parafrasi.
5. Non ripetere il titolo della lezione dentro \`contentMarkdown\` e non duplicare heading identici o quasi identici.
6. Evita metadiscorso e enfasi ridondante: non usare continuamente formule come "questo e importante", "in pratica", "il punto centrale e", "qui si capisce", salvo rarissimi casi.
${LESSON_SHARED_WRITING_RULES}${imageRules}
24. ${continuityRule}
25. Vincoli di focus della lezione:
${scopeRule}
26. L'output finale DEVE rispettare rigorosamente lo schema JSON richiesto. Non scrivere testo fuori dal JSON.
27. \`quiz\` deve contenere da 1 a 3 pause attive con ESATTAMENTE 4 opzioni ciascuna.
28. Usa il numero MINIMO necessario di pause attive: 1 se la lezione ha un solo snodo concettuale forte, 2 se ha piu passaggi da consolidare, 3 solo se la lezione e davvero ampia e segmentata.
29. Ogni pausa deve avere \`exerciseType\` scelto da questo catalogo trasversale:
${ACTIVE_PAUSE_EXERCISE_TYPE_RULES}
30. Non generare sempre domande: alterna consegne brevi, micro-casi, diagnosi, classificazioni, previsioni e sintesi quando sono pertinenti alla lezione.
31. Le pause del \`quiz\` NON devono mai limitarsi a chiedere la ripetizione letterale di una definizione, di una formula o di una frase appena letta.
32. Ogni pausa deve richiedere applicazione, confronto, inferenza, diagnosi di errore, classificazione di un caso, sequenziamento, micro-sintesi oppure previsione di un effetto/conseguenza.
33. Le opzioni errate devono essere credibili e vicine agli errori concettuali tipici, non banalmente ridicole.
34. **POSIZIONA OGNI PAUSA DOPO LE INFORMAZIONI NECESSARIE:** ogni pausa attiva deve arrivare DOPO che il contenuto necessario per rispondere e gia stato spiegato nel testo della lezione. In particolare, se la pausa e di tipo confronto (compare-contrast), non inserirla subito dopo il primo concetto: deve essere posizionata DOPO che ENTRAMBI i concetti / elementi da confrontare sono stati presentati e spiegati. Lo stesso vale per micro-sintesi, classificazione e previsione: il lettore deve avere tutti gli elementi per rispondere.
35. Le stringhe di \`quiz.question\` e \`quiz.options\` devono essere testo normale: non racchiudere MAI l'intera consegna o l'intera opzione in backticks, inline code o code fence. I backticks sono ammessi solo per un singolo termine, simbolo o identificatore interno alla frase quando servono davvero.
35a. Per ogni pausa, \`anchorExcerpt\` deve copiare un breve estratto ESATTO dell'ultimo paragrafo che lo studente deve leggere prima della pausa. Questo decide il punto editoriale preciso: non anticipare la pausa e non affidarti al solo heading.
${imagePlacementInstruction}
37. Non racchiudere il JSON in markdown fences e non aggiungere spiegazioni prima o dopo il JSON.
38. Quando elenchi 2 o piu elementi fratelli (tipi, gruppi, fasi, strutture, definizioni), usa una lista Markdown vera (\`-\` oppure \`1.\`).
39. Non scrivere pseudo-liste come paragrafi consecutivi del tipo "Etichetta: ..." senza bullet. Se non e una lista, allora fondi tutto in paragrafi completi.
40. Per i blocchi di codice, usa Markdown standard: la riga di apertura deve essere esattamente \`\`\`\` oppure \`\`\`\`lang con solo il nome del linguaggio (es. \`\`\`\`cpp). Non aggiungere commenti o testo extra sulla riga del fence.
41. Non scrivere righe spurie come \`cpp\`, \`cpp // commento\` o simili subito prima di un code block. Se vuoi introdurre il codice, usa una frase normale separata; se vuoi un commento nel codice, mettilo dentro il blocco con la sintassi del linguaggio.
42. NON inserire markdown image syntax dentro \`contentMarkdown\` (niente \`![...](...)\` e niente tag \`<img>\`): le immagini vengono gestite SOLO tramite \`imagePlacements\`.
43. NON inserire una sezione quiz, domande o verifica dentro \`contentMarkdown\`: il quiz deve comparire SOLO nel campo strutturato \`quiz\`.
44. Se inserisci formule, assicurati che il Markdown sia compatibile con KaTeX: formule inline solo con \`$...$\` oppure \`\\(...\\)\`; formule display solo con \`$$...$$\` oppure \`\\[...\\]\`. Non lasciare mai righe isolate con solo \`[\`, \`]\`, \`\\[\` o \`\\]\`, non aprire una formula con un delimitatore e chiuderla con un altro, e chiudi sempre correttamente graffe e delimitatori.
45. Mentre scrivi, decidi da zero a ${MAX_GENERATED_VISUALS_PER_LESSON} punti in cui un esempio visuale generato migliorerebbe davvero la comprensione. Inserisci direttamente nel testo il tag \`{{VISUAL_SLOT:slot-001}}\` nel punto editoriale esatto e aggiungi il piano corrispondente in \`visualPlanning.plans\`. Il tag e la posizione: non fornire heading o estratti da cercare dopo.
46. Ogni piano deve avere esattamente un tag e ogni tag esattamente un piano. Usa identificatori sequenziali. ${VISUAL_FORMAT_SELECTION_RULE} ${INTERACTIVE_VISUAL_VALUE_RULE} Per HTML interattivo, la grafica deve essere prodotta da regole o algoritmi, non disegnata a mano.
${candidateImagesPayload}
Rispondi SOLO con un oggetto JSON valido con questa struttura:
{
  "contentMarkdown": "Lezione completa in markdown",
  "quiz": [
    { "anchorExcerpt": "estratto esatto del paragrafo precedente", "exerciseType": "application-card", "question": "...", "options": ["A", "B", "C", "D"], "correctIndex": 0 }
  ],
  "imagePlacements": [
    { "assetId": "pdf-img-001", "alt": "Descrizione breve", "caption": "Caption opzionale", "anchorHeading": "Analisi Approfondita" }
  ],
  "visualPlanning": {
    "rationale": "Motivazione sintetica",
    "plans": []
  }
}`;
  };

  let pdfSession: Awaited<ReturnType<typeof getPdfAssetSession>> = null;
  let pdfTextSession: Awaited<ReturnType<typeof getPdfTextSession>> = null;
  let pdfPageCount: number | undefined;
  let relevantPdfPages: number[] = [];
  if (isPdfFile(file)) {
    onStatusUpdate?.('Analisi immagini...');
    try {
      pdfTextSession = await getPdfTextSession(file);
      pdfPageCount = pdfTextSession?.pageCount;
      relevantPdfPages = estimateRelevantPdfImagePages(
        documentIndex,
        primaryChunkIds,
        pdfPageCount,
        pdfTextSession?.pages
      );
      if (relevantPdfPages.length > 0) {
        onStatusUpdate?.(
          `Analisi immagini... pp. ${relevantPdfPages[0]}-${relevantPdfPages[relevantPdfPages.length - 1]}`
        );
      }

      pdfSession = await withSoftTimeout(
        getPdfAssetSession(file, {
          partialPages: relevantPdfPages,
        }),
        PDF_ASSET_SESSION_TIMEOUT_MS
      );
    } catch (error) {
      if (isSoftTimeoutError(error)) {
        console.warn(
          '[Nous][Lesson] PDF asset parsing timed out, continuing with text-only lesson generation for now.',
          error
        );
        onStatusUpdate?.('Salto immagini (PDF grande)...');
      } else {
        console.warn(
          'PDF asset parsing failed, falling back to text-only lesson generation.',
          error
        );
      }
    }
  }

  const pdfChunkUsageDebugPayload = isPdfFile(file)
    ? buildPdfChunkUsageDebugPayload(
        sectionTitle,
        documentIndex,
        primaryChunkIds,
        pdfPageCount,
        relevantPdfPages,
        pdfTextSession?.pages
      )
    : null;
  if (pdfChunkUsageDebugPayload) {
    logPdfLessonDebug('Chunk source usage', pdfChunkUsageDebugPayload);
  }

  if (pdfSession) {
    onStatusUpdate?.(`Analisi immagini... trovate ${pdfSession.images.length}`);
    const candidateImages = selectCandidatePdfImages(
      pdfSession.images,
      sectionTitle,
      sectionDescription,
      relevantPdfPages
    );
    logPdfLessonDebug('Candidate images selected', {
      sectionTitle,
      totalExtractedImages: pdfSession.images.length,
      candidateCount: candidateImages.length,
      candidates: candidateImages.map(image => ({
        id: image.id,
        pageNumber: image.pageNumber,
        caption: image.caption || '',
        sourceOrder: image.sourceOrder,
      })),
    });

    if (candidateImages.length === 0) {
      onStatusUpdate?.('Figure: nessuna pertinente');
    }

    const candidateImagePayload = candidateImages.map(image => ({
      assetId: image.id,
      pageNumber: image.pageNumber,
      visibleLabel: buildVisibleImageLabel(image, sectionTitle, sectionDescription),
      caption: image.caption,
      sourceOrder: image.sourceOrder,
      intrinsicWidth: image.intrinsicWidth ?? null,
      intrinsicHeight: image.intrinsicHeight ?? null,
      aspectRatio:
        image.intrinsicWidth && image.intrinsicHeight
          ? image.intrinsicWidth / image.intrinsicHeight
          : null,
      sizeBytes: image.sizeBytes ?? null,
    }));
    const visibleLabelByAssetId = new Map(
      candidateImagePayload.map(image => [image.assetId.toLowerCase(), image.visibleLabel])
    );

    const lessonSourceContext = buildLessonChunkContext(documentIndex, primaryChunkIds);
    const imageRules = `
18. Usa un numero di immagini proporzionato alla struttura della lezione. Ogni immagine deve servire una spiegazione vicina: non usarla come decorazione, intermezzo visivo o grafico generico se il testo non la interpreta esplicitamente.
19. Puoi referenziare SOLO questi assetId. Se nessuna immagine e chiaramente pertinente, restituisci un array vuoto.
20. Se usi un'immagine, \`anchorHeading\` deve corrispondere ESATTAMENTE a un heading presente in \`contentMarkdown\`, senza i simboli #. Scegli il heading della sezione in cui il primo blocco di testo spiega proprio cio che l'immagine mostra; se il testo vicino non la usa, non inserirla li.
21. Se il materiale parla chiaramente di anatomia, strutture o meccanica visivamente spiegabili e tra le candidate c'e una figura pertinente, preferisci includerne almeno una.
22. Usa solo immagini visivamente chiare, autosufficienti e distinguibili. Escludi immagini sfocate, parziali, ritagliate, poco leggibili, decorative, badge, icone, bordi, wrapper di sezione, riquadri ornamentali o frammenti di figura.
23. L'immagine originale e prioritaria quando e chiara, pertinente e specifica della fonte: schermate di un programma, oggetti o casi propri del documento, diagrammi complessi con label specifiche e relazioni non ricreabili vanno conservati anche se non perfetti.
24. Valuta anche intrinsicWidth, intrinsicHeight, aspectRatio e sizeBytes. Se una figura generica e piccola, poco leggibile, con proporzioni estremamente insolite, o la caption visiva diverge dal contesto vicino, non usarla: restituisci imagePlacements vuoto, cosi un esempio visuale piu chiaro puo occupare quello slot. Non scartare invece una figura specifica solo per la sua risoluzione.
25. Non usare il contesto testuale per indovinare una figura poco chiara: se l'immagine non si capisce da sola, non usarla.`;
    const prompt = buildLessonPrompt({
      sourcePrefix: ' a partire da un PDF gia analizzato',
      sourceContext: `\nESTRATTI RILEVANTI DAL PDF PER QUESTA LEZIONE:\n${lessonSourceContext || pdfSession.extractedText.slice(0, 12000)}\n`,
      imageRules,
      candidateImagesPayload: `45. Nei dati immagine, \`caption\` e una descrizione sintetica generata a partire dalla figura. Usa \`caption\`, \`visibleLabel\`, metadata dimensionali e il contesto della lezione per decidere se l'immagine e pertinente: non inventare dettagli non esplicitati dalla descrizione. La caption finale deve essere coerente con il paragrafo vicino, non una descrizione isolata.\n\nIMMAGINI CANDIDATE:\n${JSON.stringify(candidateImagePayload, null, 2)}`,
      imagePlacementInstruction: `36. \`imagePlacements\` deve contenere solo assetId presenti nella lista fornita oppure essere un array vuoto.\n37. NON citare MAI stringhe tecniche come \`pdf-img-004\` dentro \`contentMarkdown\`.\n38. Se vuoi richiamare un'immagine nel testo, usa solo il suo \`visibleLabel\`, la sua caption oppure formule naturali come "la figura mostra". Il paragrafo vicino deve dire al lettore che cosa guardare nell'immagine e perche e utile alla spiegazione.`,
    });

    onStatusUpdate?.('Strutturazione della lezione...', 'drafting');
    const parsed = await retryWithBackoff(async () => {
      const response = await callOpenRouter({
        model: MODEL_REASONING,
        modelSlot: 'drafting',
        reasoning: MEDIUM_REASONING_CONFIG,
        onReasoningUpdate,
        messages: [
          { role: 'system', content: teacherInstruction },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: LESSON_RESPONSE_SCHEMA,
        },
      });

      return parseLessonContentPayload(response, sectionTitle);
    });

    traceLessonMarkdownStage('raw', sectionTitle, parsed.contentMarkdown || '');
    onStatusUpdate?.('Organizzazione quiz...', 'quiz');
    const structuredQuiz = parseQuizPayload(parsed.quiz);
    const repairedContentMarkdown = await repairLessonMarkdown(
      parsed.contentMarkdown || '',
      sectionTitle,
      sectionDescription,
      lessonSourceContext ||
        clipPdfSourceText(pdfSession.extractedText, MAX_LESSON_REPAIR_SOURCE_CHARS),
      generationNotes,
      onReasoningUpdate
    ).catch(error => {
      console.warn('[Nous][Lesson] Markdown repair failed, keeping original content.', error);
      return parsed.contentMarkdown || '';
    });
    traceLessonMarkdownStage('repaired', sectionTitle, repairedContentMarkdown || '');
    const targetQuizCount = estimateTargetQuizCount(repairedContentMarkdown);
    const draftQuiz = normalizeQuizLength(structuredQuiz, targetQuizCount);

    const availableAssetIds = new Set(candidateImages.map(image => image.id));
    const normalizedImageRefs = normalizeImagePlacements(
      parsed.imagePlacements,
      availableAssetIds,
      visibleLabelByAssetId
    );
    const fallbackImageRefs =
      normalizedImageRefs.length > 0
        ? []
        : buildFallbackImageRefs(
            candidateImages,
            sectionTitle,
            sectionDescription,
            repairedContentMarkdown,
            visibleLabelByAssetId
          );
    const draftImageRefs = normalizedImageRefs.length > 0 ? normalizedImageRefs : fallbackImageRefs;
    const draftImageSelectionMode =
      normalizedImageRefs.length > 0 ? 'model' : fallbackImageRefs.length > 0 ? 'fallback' : 'none';

    logPdfLessonDebug('Image placement result', {
      sectionTitle,
      contentHeadingCount: getMarkdownHeadings(repairedContentMarkdown).length,
      modelPlacementsRaw: parsed.imagePlacements || [],
      normalizedImageRefs,
      fallbackImageRefs,
      draftImageRefs,
      imageSelectionMode: draftImageSelectionMode,
    });

    onStatusUpdate?.('Verifica finale...', 'verification');
    const verifiedDraft = await verifyLessonDraft({
      sectionTitle,
      sectionDescription,
      previousContext,
      sourceContext:
        lessonSourceContext ||
        clipPdfSourceText(pdfSession.extractedText, MAX_LESSON_REPAIR_SOURCE_CHARS),
      continuityRule,
      scopeRule,
      targetQuizCount,
      draft: {
        contentMarkdown: repairedContentMarkdown,
        quiz: draftQuiz,
        imagePlacements: draftImageRefs,
        visualPlanning: parsed.visualPlanning ?? {
          plans: [],
          rationale: 'La stesura non ha proposto esempi visuali generati.',
        },
      },
      candidateImages: candidateImagePayload,
      generationNotes,
      onReasoningUpdate,
    }).catch(error => {
      console.warn(
        '[Nous][Lesson] Final lesson verification failed, keeping pre-verified draft.',
        error
      );
      return {
        contentMarkdown: repairedContentMarkdown,
        quiz: draftQuiz,
        imagePlacements: draftImageRefs,
        visualPlanning: parsed.visualPlanning ?? {
          plans: [],
          rationale: 'La verifica visuale non è stata completata.',
        },
      } satisfies LessonVerificationDraft;
    });
    traceLessonMarkdownStage('verified', sectionTitle, verifiedDraft.contentMarkdown || '');

    const verifiedImageRefs = normalizeImagePlacements(
      verifiedDraft.imagePlacements,
      availableAssetIds,
      visibleLabelByAssetId
    );
    const imageRefs = verifiedImageRefs;
    const imageSelectionMode =
      imageRefs.length > 0
        ? verifiedImageRefs.length === draftImageRefs.length &&
          verifiedImageRefs.every((ref, index) => ref.assetId === draftImageRefs[index]?.assetId)
          ? draftImageSelectionMode
          : 'verified'
        : 'none';

    logPdfLessonDebug('Final lesson verification', {
      sectionTitle,
      verifiedImageRefs,
      imageSelectionMode,
      verifiedQuizCount: verifiedDraft.quiz.length,
    });

    if (imageSelectionMode === 'none') {
      onStatusUpdate?.(
        candidateImages.length > 0
          ? 'Immagini trovate ma nessuna ha superato i controlli di pertinenza'
          : 'Lezione generata senza immagini'
      );
    } else {
      onStatusUpdate?.(
        imageSelectionMode === 'model'
          ? `Lezione con ${imageRefs.length} immagini dal PDF`
          : imageSelectionMode === 'fallback'
            ? `Lezione con ${imageRefs.length} immagini dal PDF (fallback)`
            : `Lezione con ${imageRefs.length} immagini dal PDF (verificate)`
      );
    }

    const cleanedContentMarkdown = sanitizeLessonMarkdownContent(
      verifiedDraft.contentMarkdown,
      visibleLabelByAssetId
    );
    traceLessonMarkdownStage('cleaned', sectionTitle, cleanedContentMarkdown || '');
    const contentWithPdfImages = injectImagePlaceholders(cleanedContentMarkdown, imageRefs);
    const [visualResult, learningAids] = await Promise.all([
      materializeGeneratedVisualSlots({
        contentMarkdown: contentWithPdfImages,
        generationNotes,
        hasPdfImages: imageRefs.length > 0,
        onStatusUpdate,
        sectionDescription,
        sectionTitle,
        visualPlanning: verifiedDraft.visualPlanning,
      }),
      generateLessonLearningAids({
        contentMarkdown: cleanedContentMarkdown,
        sectionDescription,
        sectionTitle,
      }),
    ]);

    return {
      content: visualResult.content,
      generatedVisuals: visualResult.generatedVisuals,
      learningAids,
      quiz: normalizeQuizLength(verifiedDraft.quiz, targetQuizCount),
      visualPlanningDecision: visualResult.visualPlanningDecision,
      imageRefs,
      documentAssets: buildStoredPdfDocumentAssets(pdfSession, imageRefs),
    };
  }

  const mappedSourceContext = buildLessonChunkContext(documentIndex, primaryChunkIds);
  const prompt = buildLessonPrompt({
    sourcePrefix: mappedSourceContext ? ' usando solo gli estratti sorgente pertinenti' : '',
    sourceContext: mappedSourceContext
      ? `\nESTRATTI RILEVANTI DALLE FONTI PER QUESTA LEZIONE:\n${mappedSourceContext}\n`
      : '',
    imagePlacementInstruction:
      '30. **IMMAGINI**: Per questa richiesta `imagePlacements` deve essere un array vuoto.',
  });

  const userContent = mappedSourceContext
    ? prompt
    : await buildReasoningContentForFile(file, prompt, MAX_PDF_FALLBACK_LESSON_SOURCE_CHARS);
  onStatusUpdate?.('Strutturazione della lezione...', 'drafting');
  const parsed = await retryWithBackoff(async () => {
    const response = await callOpenRouter({
      model: MODEL_REASONING,
      modelSlot: 'drafting',
      reasoning: MEDIUM_REASONING_CONFIG,
      onReasoningUpdate,
      messages: [
        { role: 'system', content: teacherInstruction },
        {
          role: 'user',
          content: userContent,
        },
      ],
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: LESSON_RESPONSE_SCHEMA,
      },
    });
    return parseLessonContentPayload(response, sectionTitle);
  });
  traceLessonMarkdownStage('raw', sectionTitle, parsed.contentMarkdown || '');
  onStatusUpdate?.('Organizzazione quiz...', 'quiz');
  const structuredQuiz = parseQuizPayload(parsed.quiz);
  const repairedContentMarkdown = await repairLessonMarkdown(
    parsed.contentMarkdown || '',
    sectionTitle,
    mappedSourceContext || sectionDescription,
    sectionDescription,
    generationNotes,
    onReasoningUpdate
  ).catch(error => {
    console.warn('[Nous][Lesson] Markdown repair failed, keeping original content.', error);
    return parsed.contentMarkdown || '';
  });
  traceLessonMarkdownStage('repaired', sectionTitle, repairedContentMarkdown || '');
  const targetQuizCount = estimateTargetQuizCount(repairedContentMarkdown);
  const draftQuiz = normalizeQuizLength(structuredQuiz, targetQuizCount);

  onStatusUpdate?.('Verifica finale...', 'verification');
  const verifiedDraft = await verifyLessonDraft({
    sectionTitle,
    sectionDescription,
    previousContext,
    sourceContext: mappedSourceContext || sectionDescription,
    continuityRule,
    scopeRule,
    targetQuizCount,
    draft: {
      contentMarkdown: repairedContentMarkdown.trim(),
      quiz: draftQuiz,
      imagePlacements: [],
      visualPlanning: parsed.visualPlanning ?? {
        plans: [],
        rationale: 'La stesura non ha proposto esempi visuali generati.',
      },
    },
    candidateImages: [],
    generationNotes,
    onReasoningUpdate,
  }).catch(error => {
    console.warn(
      '[Nous][Lesson] Final lesson verification failed, keeping pre-verified draft.',
      error
    );
    return {
      contentMarkdown: repairedContentMarkdown.trim(),
      quiz: draftQuiz,
      imagePlacements: [],
      visualPlanning: parsed.visualPlanning ?? {
        plans: [],
        rationale: 'La verifica visuale non è stata completata.',
      },
    } satisfies LessonVerificationDraft;
  });
  traceLessonMarkdownStage('verified', sectionTitle, verifiedDraft.contentMarkdown || '');

  const cleanedContentMarkdown = sanitizeLessonMarkdownContent(
    verifiedDraft.contentMarkdown.trim()
  );
  traceLessonMarkdownStage('cleaned', sectionTitle, cleanedContentMarkdown);
  const [visualResult, learningAids] = await Promise.all([
    materializeGeneratedVisualSlots({
      contentMarkdown: cleanedContentMarkdown,
      generationNotes,
      hasPdfImages: false,
      onStatusUpdate,
      sectionDescription,
      sectionTitle,
      visualPlanning: verifiedDraft.visualPlanning,
    }),
    generateLessonLearningAids({
      contentMarkdown: cleanedContentMarkdown,
      sectionDescription,
      sectionTitle,
    }),
  ]);

  return {
    content: visualResult.content,
    generatedVisuals: visualResult.generatedVisuals,
    learningAids,
    quiz: normalizeQuizLength(verifiedDraft.quiz, targetQuizCount),
    visualPlanningDecision: visualResult.visualPlanningDecision,
    imageRefs: [],
    documentAssets: null,
  };
};
