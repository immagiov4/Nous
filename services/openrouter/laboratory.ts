import type {
  FileData,
  LaboratoryAttachment,
  LaboratoryExercise,
  LaboratoryExerciseEvaluation,
  LaboratoryState,
  LearningPlan,
  PdfTextChunk,
  PdfTextIndex,
  ProjectSource,
  UserProfile,
} from '../../types.ts';
import { buildLaboratoryAttachmentContext } from '../laboratory/attachments.ts';
import { CURRENT_LABORATORY_SCHEMA_VERSION } from '../laboratory/state.ts';
import { createProjectId } from '../projects/projectSnapshot.ts';
import {
  HIGH_REASONING_CONFIG,
  MODEL_ASSESSMENT,
  MODEL_FLASH,
  MODEL_PDF_IMAGE_CAPTION,
  MODEL_REASONING,
} from './config.ts';
import { buildReasoningContentForFile } from './contextChat.ts';
import { callOpenRouter, fileToDataUrl, parseCleanJson, retryWithBackoff } from './shared.ts';
import type { ChatMessageContent, OpenRouterReasoningOptions } from './types.ts';

const MAX_CODEBASE_SOURCE_CHARS = 72_000;
const MAX_LEARNING_PLAN_CHARS = 28_000;
const MAX_PDF_CHUNKS_FOR_EXERCISE = 6;
const MAX_PDF_SOURCE_CHARS = 42_000;
const MAX_IMAGE_ATTACHMENTS_IN_PROMPT = 6;

const LAB_INSTRUCTIONS_MARKDOWN_TEMPLATE = [
  'Contenuti richiesti per instructionsMarkdown:',
  '- scenario specifico gia deciso',
  '- obiettivo pratico da raggiungere',
  '- deliverable concreti e verificabili',
  '- vincoli del caso gia integrati nella traccia, senza una sezione separata di requisiti duplicati',
  '- il testo mostrato allo studente non deve spiegare marker markdown, livelli di heading, sintassi di tabella o altri dettagli di formattazione',
  '- i deliverable devono dire chiaramente cosa produrre, con quale livello minimo di dettaglio e in quale forma',
].join('\n');

const LAB_APPROACH_MARKDOWN_TEMPLATE = [
  'Contenuti richiesti per approachMarkdown:',
  '- strategia iniziale concreta',
  '- controlli iniziali davvero utili',
  '- errori da evitare o verifiche minime',
  '- spiega come affrontare il caso, non come formattare il testo della consegna',
].join('\n');

const LAB_EXAMPLE_MARKDOWN_TEMPLATE = [
  'Contenuti richiesti per exampleMarkdown:',
  '- esempio parallelo oppure avvio guidato',
  '- primo passo osservabile o indizio operativo',
  '- criterio di qualita minimo o errore tipico da evitare',
  '- non chiedere allo studente di riprodurre una sintassi markdown specifica',
].join('\n');

const LAB_MARKDOWN_STYLE_RULES = [
  'Regole di stile markdown per tutti i campi mostrati all utente:',
  '- usa una struttura leggibile con heading, liste quando servono e paragrafi brevi',
  '- questo NON e una lezione discorsiva, ma non deve nemmeno diventare una checklist ovunque: usa liste solo quando chiariscono davvero elementi fratelli, passi o output distinti',
  '- se ci sono piu elementi omogenei consecutivi da classificare, confrontare o consegnare, usa una lista markdown vera invece di righe sciolte',
  '- usa liste vere soprattutto per requisiti, deliverable, passi operativi, controlli iniziali, errori da evitare, indizi e segnali di rischio; per brevi spiegazioni consecutive, vanno bene anche paragrafi corti',
  '- niente code fence, blockquote, tabelle o pseudo-template se non stai mostrando vero codice o veri comandi',
  '- non dire mai allo studente quanti # usare, come fare una tabella markdown, come aprire un code fence o altri dettagli puramente sintattici: chiedi il contenuto, non il markup',
  '- se un deliverable puo essere reso bene in piu formati equivalenti, lascia flessibilita di forma e valuta il contenuto; non imporre tabelle markdown o formati rigidi senza necessita sostanziale',
  '- non inserire etichette decorative dentro code fence come "Esempio parallelo", "Oppure", "stile atteso" o simili',
  '- non scrivere meta-testo su come dovrebbe apparire l esempio: scrivi direttamente l esempio finale',
  '- ogni bullet deve essere breve, concreta e con al massimo due frasi',
  '- evita paragrafi-muro: se superi due frasi, spezza in bullet separati',
  '- mantieni tono tecnico, asciutto e leggibile; niente prose ridondanti o introduzioni ornamentali',
].join('\n');

interface LaboratoryExerciseDraft {
  approachMarkdown?: string;
  brief?: string;
  exampleMarkdown?: string;
  instructionsMarkdown?: string;
  internalNotes?: string[];
  requirements?: string[];
  sourceChunkIds?: string[];
  title?: string;
}

interface LaboratoryGenerationDraft {
  exercises?: LaboratoryExerciseDraft[];
  summary?: string;
  title?: string;
}

interface LaboratoryEvaluationDraft {
  caveats?: string[];
  confidenceScore?: number;
  confidenceSummary?: string;
  improvements?: string[];
  score?: number;
  strengths?: string[];
  summary?: string;
}

interface GenerateLaboratoryArgs {
  documentIndex?: PdfTextIndex | null;
  learningPlan: LearningPlan;
  onReasoning?: (reasoning: string) => void;
  onStatus?: (status: string) => void;
  source: ProjectSource | null;
  userProfile?: UserProfile | null;
}

interface EvaluateLaboratoryExerciseArgs {
  documentIndex?: PdfTextIndex | null;
  exercise: LaboratoryExercise;
  learningPlan: LearningPlan | null;
  onReasoning?: (reasoning: string) => void;
  onStatus?: (status: string) => void;
  source: ProjectSource | null;
  userProfile?: UserProfile | null;
}

interface RegenerateLaboratoryExerciseArgs extends GenerateLaboratoryArgs {
  exercise: LaboratoryExercise;
}

const clip = (value: string, maxChars: number, suffix: string) => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars).trimEnd()}\n\n${suffix}`;
};

const cleanLines = (values: unknown): string[] =>
  Array.isArray(values)
    ? values.map(value => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
    : [];

const clampPercentage = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
};

const buildLearningPlanOutline = (learningPlan: LearningPlan): string => {
  const lines = [
    `Titolo percorso: ${learningPlan.title}`,
    learningPlan.summary.trim() ? `Sintesi percorso: ${learningPlan.summary.trim()}` : '',
    '',
    'Sezioni del percorso:',
    ...learningPlan.sections.map((section, index) => {
      const chunkLine = section.primaryChunkIds?.length
        ? ` | chunk sorgente: ${section.primaryChunkIds.join(', ')}`
        : '';
      const modulePrefix = section.moduleTitle?.trim() ? `${section.moduleTitle.trim()} / ` : '';

      return `${index + 1}. ${modulePrefix}${section.title}\n- Tipo: ${section.type}\n- Descrizione: ${section.description}${chunkLine}`;
    }),
  ].filter(Boolean);

  return clip(lines.join('\n'), MAX_LEARNING_PLAN_CHARS, '[piano troncato]');
};

const buildUserProfileSummary = (userProfile?: UserProfile | null): string => {
  if (!userProfile) {
    return 'Profilo utente non disponibile.';
  }

  return [
    `Topic: ${userProfile.topic}`,
    `Livello: ${userProfile.experienceLevel}`,
    `Stile: ${userProfile.learningStyle}`,
    `Obiettivi: ${userProfile.goals}`,
    `Contesto: ${userProfile.context}`,
  ].join('\n');
};

const selectDistributedPdfChunks = (chunks: PdfTextChunk[], limit: number): PdfTextChunk[] => {
  if (chunks.length <= limit) {
    return chunks;
  }

  const selectedChunks: PdfTextChunk[] = [];
  const selectedIndices = new Set<number>();
  const denominator = Math.max(1, limit - 1);

  for (let index = 0; index < limit; index += 1) {
    const candidateIndex = Math.floor((index * (chunks.length - 1)) / denominator);
    if (selectedIndices.has(candidateIndex)) {
      continue;
    }

    selectedIndices.add(candidateIndex);
    selectedChunks.push(chunks[candidateIndex] as PdfTextChunk);
  }

  if (selectedChunks.length < limit) {
    for (let index = chunks.length - 1; index >= 0 && selectedChunks.length < limit; index -= 1) {
      if (selectedIndices.has(index)) {
        continue;
      }

      selectedIndices.add(index);
      selectedChunks.push(chunks[index] as PdfTextChunk);
    }

    selectedChunks.sort((left, right) => left.sequence - right.sequence);
  }

  return selectedChunks;
};

const formatChunkPageRange = (chunk: PdfTextChunk): string => {
  if (typeof chunk.pageStart !== 'number' && typeof chunk.pageEnd !== 'number') {
    return 'Pagina non disponibile';
  }

  const pageStart = chunk.pageStart ?? chunk.pageEnd;
  const pageEnd = chunk.pageEnd ?? chunk.pageStart;

  if (typeof pageStart !== 'number' || typeof pageEnd !== 'number') {
    return 'Pagina non disponibile';
  }

  return pageStart === pageEnd ? `pag. ${pageStart}` : `pag. ${pageStart}-${pageEnd}`;
};

const buildPdfChunkSummary = (
  documentIndex: PdfTextIndex,
  exercise: LaboratoryExercise | null
): string => {
  const chunkById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));
  const selectedChunks = (exercise?.sourceChunkIds || [])
    .map(chunkId => chunkById.get(chunkId))
    .filter((chunk): chunk is PdfTextChunk => Boolean(chunk));
  const fallbackChunks = selectDistributedPdfChunks(
    documentIndex.chunks,
    MAX_PDF_CHUNKS_FOR_EXERCISE
  );
  const chunks = selectedChunks.length > 0 ? selectedChunks : fallbackChunks;

  return clip(
    [
      selectedChunks.length > 0
        ? 'Estratto mirato ai chunk gia associati all esercizio.'
        : 'Estratto distribuito sull intero documento per coprire inizio, centro e fine del corpus.',
      ...chunks.map(chunk => {
        const headingPath = chunk.headingPath.join(' > ').trim() || 'Senza heading';
        return `CHUNK ${chunk.id}\nPagine: ${formatChunkPageRange(chunk)}\nHeading: ${headingPath}\n${chunk.text}`;
      }),
    ].join('\n\n---\n\n'),
    MAX_PDF_SOURCE_CHARS,
    '[estratto PDF troncato]'
  );
};

const buildSourceSummary = async ({
  documentIndex,
  exercise,
  learningPlan,
  source,
}: {
  documentIndex?: PdfTextIndex | null;
  exercise?: LaboratoryExercise | null;
  learningPlan: LearningPlan | null;
  source: ProjectSource | null;
}): Promise<string> => {
  if (!source) {
    return learningPlan
      ? 'La sorgente originale non e disponibile. Basati sul piano di studio e sugli allegati utente.'
      : 'Non e disponibile nessuna sorgente originale.';
  }

  if (source.kind === 'codebase-bundle') {
    return `Codebase: ${source.name}\n\n${clip(source.aggregatedText, MAX_CODEBASE_SOURCE_CHARS, '[codebase troncata]')}`;
  }

  if (documentIndex?.chunks.length) {
    return `Documento PDF: ${source.file.name}\n\n${buildPdfChunkSummary(documentIndex, exercise || null)}`;
  }

  return typeof source.file === 'object'
    ? String(
        await buildReasoningContentForFile(
          source.file,
          `Usa il documento allegato solo come contesto per il laboratorio seguente:\n${learningPlan ? buildLearningPlanOutline(learningPlan) : 'Nessun piano disponibile.'}`,
          MAX_PDF_SOURCE_CHARS
        )
      )
    : 'La sorgente PDF non ha un estratto testuale disponibile.';
};

const buildImageDescriptionPrompt = (attachment: LaboratoryAttachment): string => {
  const optionalDescription = attachment.description?.trim()
    ? `\nDescrizione fornita dall'utente: ${attachment.description.trim()}`
    : '';

  return `Descrivi questa immagine in Italiano in modo conciso e fattuale.
Regole:
- massimo 60 parole
- se mostra codice, UI, diagrammi, grafici o risultati sperimentali, dillo in modo esplicito
- non inventare dettagli illeggibili
- se e quasi vuota o poco informativa, dillo chiaramente${optionalDescription}`;
};

const attachmentToFileData = (attachment: LaboratoryAttachment): FileData => ({
  name: attachment.name,
  mimeType: attachment.mimeType,
  data: attachment.data,
});

const describeImageAttachment = async (attachment: LaboratoryAttachment): Promise<string> => {
  const imagePrompt = buildImageDescriptionPrompt(attachment);
  const imageContent = [
    {
      type: 'image_url' as const,
      image_url: { url: fileToDataUrl(attachmentToFileData(attachment)) },
    },
    { type: 'text' as const, text: imagePrompt },
  ];

  const primaryResponse = await retryWithBackoff(
    () =>
      callOpenRouter({
        disableModelOverride: true,
        max_tokens: 180,
        messages: [{ role: 'user', content: imageContent }],
        model: MODEL_PDF_IMAGE_CAPTION,
        temperature: 0.1,
      }),
    2,
    500
  );

  const normalizedPrimaryResponse = primaryResponse.trim();
  if (normalizedPrimaryResponse) {
    return normalizedPrimaryResponse;
  }

  return retryWithBackoff(
    () =>
      callOpenRouter({
        disableModelOverride: true,
        max_tokens: 180,
        messages: [{ role: 'user', content: imageContent }],
        model: MODEL_FLASH,
        temperature: 0.1,
      }),
    2,
    500
  );
};

const appendTextContent = (content: ChatMessageContent, extraText: string): ChatMessageContent => {
  if (typeof content === 'string') {
    return `${content}\n\n${extraText}`;
  }

  return [...content, { type: 'text', text: extraText }];
};

const buildEvaluationUserContent = async ({
  attachmentWarnings,
  documentIndex,
  exercise,
  learningPlan,
  source,
  sourceSummary,
}: {
  attachmentWarnings: string[];
  documentIndex?: PdfTextIndex | null;
  exercise: LaboratoryExercise;
  learningPlan: LearningPlan | null;
  source: ProjectSource | null;
  sourceSummary: string;
}): Promise<ChatMessageContent> => {
  const imageAttachments = exercise.attachments.filter(attachment => attachment.kind === 'image');

  const attachmentContext = await buildLaboratoryAttachmentContext(exercise.attachments, {
    describeImageAttachment,
  });

  const warnings = [...attachmentWarnings, ...attachmentContext.warnings];
  const promptText = [
    `Titolo esercizio: ${exercise.title}`,
    `Brief: ${exercise.brief}`,
    '',
    'Istruzioni esercizio:',
    exercise.instructionsMarkdown,
    '',
    exercise.requirements.length > 0
      ? `Vincoli espliciti legacy:\n- ${exercise.requirements.join('\n- ')}`
      : '',
    `Guida operativa fornita allo studente:\n${exercise.approachMarkdown}`,
    `Esempio o indizi forniti allo studente:\n${exercise.exampleMarkdown}`,
    '',
    exercise.internalNotes.length > 0
      ? `Note interne per il valutatore:\n- ${exercise.internalNotes.join('\n- ')}`
      : '',
    learningPlan ? `Contesto del percorso:\n${buildLearningPlanOutline(learningPlan)}` : '',
    source
      ? `Sorgente originale rilevante:\n${sourceSummary}`
      : 'Sorgente originale non disponibile: valuta con prudenza e alza i caveat se la consegna non basta.',
    attachmentContext.content
      ? `Consegne e allegati dell'utente:\n${attachmentContext.content}`
      : 'Non ci sono allegati utente leggibili.',
    warnings.length > 0 ? `Avvisi di lettura:\n- ${warnings.join('\n- ')}` : '',
    documentIndex && source?.kind === 'pdf' && !exercise.sourceChunkIds?.length
      ? 'Nota: questo esercizio non e collegato a chunk specifici del PDF; valuta soprattutto coerenza con la traccia e qualita della consegna.'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  if (imageAttachments.length === 0) {
    return promptText;
  }

  const imageParts = imageAttachments.slice(0, MAX_IMAGE_ATTACHMENTS_IN_PROMPT).map(attachment => ({
    type: 'image_url' as const,
    image_url: { url: fileToDataUrl(attachmentToFileData(attachment)) },
  }));

  const omittedImageCount = Math.max(0, imageAttachments.length - imageParts.length);
  const finalPromptText = omittedImageCount
    ? `${promptText}\n\nImmagini non allegate direttamente al modello per limiti di contesto: ${omittedImageCount}. Usa comunque le descrizioni testuali gia presenti sopra.`
    : promptText;

  return [{ type: 'text', text: finalPromptText }, ...imageParts];
};

const callJsonModel = async <T>({
  content,
  model,
  modelSlot,
  onReasoning,
  reasoning,
  system,
  temperature = 0.2,
}: {
  content: ChatMessageContent;
  model: string;
  modelSlot: 'assessment' | 'lesson';
  onReasoning?: (reasoning: string) => void;
  reasoning?: OpenRouterReasoningOptions;
  system: string;
  temperature?: number;
}): Promise<T> => {
  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        model,
        modelSlot,
        onReasoningUpdate: onReasoning,
        reasoning,
        response_format: { type: 'json_object' },
        temperature,
      }),
    2,
    500
  );

  return parseCleanJson<T>(response);
};

const normalizeExercise = (
  draft: LaboratoryExerciseDraft,
  fallbackIndex: number
): LaboratoryExercise => {
  const now = new Date().toISOString();
  const title = draft.title?.trim() || `Esercizio ${fallbackIndex + 1}`;
  const brief = draft.brief?.trim() || 'Svolgi una consegna pratica coerente con il percorso.';
  const instructionsMarkdown =
    draft.instructionsMarkdown?.trim() ||
    [
      '## Scenario',
      `Applica il percorso in un caso tecnico specifico e realistico collegato a "${title}".`,
      '',
      '## Obiettivo',
      brief,
      '',
      '## Vincoli del caso',
      '- Lavora sul contesto gia assegnato senza ridefinire scenario, attori o perimetro.',
      '- Mantieni il focus su output verificabili e coerenti con il caso.',
      '',
      '## Deliverables',
      '- Carica una soluzione documentata.',
      '- Motiva le scelte usando il caso, i vincoli espliciti e i deliverable richiesti.',
    ].join('\n');
  const approachMarkdown =
    draft.approachMarkdown?.trim() ||
    [
      '### Strategia',
      '- Isola contesto, vincoli e output richiesti prima di produrre qualsiasi artefatto.',
      '- Trasforma vincoli e deliverable in una checklist operativa da seguire durante tutta la consegna.',
      '',
      '### Controlli iniziali',
      '- Verifica quali dati, sistemi o file del caso sono davvero nel perimetro.',
      '- Identifica subito quale evidenza concreta userai per giustificare ogni scelta.',
      '',
      '### Errori da evitare',
      '- Non ridefinire lo scenario: il caso e gia deciso nella traccia.',
      '- Non proporre soluzioni senza collegarle ai vincoli e alle evidenze del caso.',
    ].join('\n');
  const exampleMarkdown =
    draft.exampleMarkdown?.trim() ||
    [
      '### Esempio parallelo',
      '- Scenario: su un caso simile, ricevi un perimetro gia definito e devi capire da quali evidenze partire.',
      '- Primo passo: annota prima i vincoli operativi e poi collega ogni vincolo a un controllo o artefatto verificabile.',
      '- Criterio di qualita: il primo output deve gia mostrare perche una scelta e coerente con il caso.',
      '',
      '### Indizi operativi',
      '- Parti da un sotto-problema piccolo ma verificabile, non dall intera soluzione finale.',
      '- Se il caso e ambiguo, esplicita l assunzione minima necessaria prima di continuare.',
    ].join('\n');

  return {
    attachments: [],
    approachMarkdown,
    brief,
    evaluation: null,
    exampleMarkdown,
    generatedAt: now,
    id: createProjectId(),
    internalNotes: cleanLines(draft.internalNotes),
    instructionsMarkdown,
    requirements: [],
    sourceChunkIds: cleanLines(draft.sourceChunkIds),
    title,
    updatedAt: now,
  };
};

const normalizeEvaluation = (
  draft: LaboratoryEvaluationDraft,
  fallback?: Partial<LaboratoryEvaluationDraft>
): LaboratoryExerciseEvaluation => {
  const now = new Date().toISOString();
  const merged = {
    ...fallback,
    ...draft,
  };

  return {
    caveats: cleanLines(merged.caveats),
    confidenceScore: clampPercentage(merged.confidenceScore, 45),
    confidenceSummary:
      (typeof merged.confidenceSummary === 'string' && merged.confidenceSummary.trim()) ||
      'Confidenza moderata: la valutazione dipende dalla qualita degli allegati forniti.',
    evaluatedAt: now,
    improvements: cleanLines(merged.improvements),
    score: clampPercentage(merged.score, 0),
    strengths: cleanLines(merged.strengths),
    summary:
      (typeof merged.summary === 'string' && merged.summary.trim()) ||
      'Valutazione completata con informazioni limitate.',
  };
};

export const generateLaboratory = async ({
  documentIndex,
  learningPlan,
  onReasoning,
  onStatus,
  source,
  userProfile,
}: GenerateLaboratoryArgs): Promise<LaboratoryState> => {
  onStatus?.('Definizione tracce laboratorio...');

  const learningPlanOutline = buildLearningPlanOutline(learningPlan);
  const sourceSummary = await buildSourceSummary({
    documentIndex,
    learningPlan,
    source,
  });
  const content = [
    `Profilo utente:\n${buildUserProfileSummary(userProfile)}`,
    `Piano di studio:\n${learningPlanOutline}`,
    `Sorgente originale:\n${sourceSummary}`,
  ].join('\n\n');

  const system = `Sei un progettista didattico tecnico. Devi creare una fase laboratoriale SEPARATA dal percorso di studio.

Regole fondamentali:
- genera esercizi pratici, non nuove lezioni teoriche
- assumi che il lavoro dell'utente verra consegnato tramite allegati rimovibili: note markdown, immagini, archivi zip, documenti, output vari
- non introdurre campi o linguaggio come "modalita di valutazione" o tassonomie interne da mostrare all'utente
- se il materiale e un codebase, includi almeno un esercizio che richieda ragionamento su codice, struttura o patch
- se il materiale e documentale/teorico, includi esercizi di analisi, scrittura, applicazione o progetto
- gli esercizi devono essere progressivi, concreti, e giudicabili da allegati reali
- ordina gli esercizi secondo la progressione propedeutica del learningPlan: prima prerequisiti applicati e casi semplici, poi integrazione e casi piu complessi; non invertire mai i prerequisiti
- se il corpus e lungo o copre molte aree, distribuisci gli esercizi su porzioni diverse del materiale e del learningPlan; non concentrare tutte le tracce sulle prime pagine o sul primo blocco di contenuti salvo che il resto sia davvero irrilevante
- ogni esercizio deve essere autosufficiente: inventa tu uno scenario plausibile, specifico e circoscritto quando la sorgente non ne fornisce uno gia pronto
- non chiedere mai allo studente di scegliere lo scenario, definire il perimetro, inventare i requisiti o decidere chi sono gli attori del caso
- i vincoli del caso devono essere espliciti dentro instructionsMarkdown, senza duplicare una sezione separata di requisiti
- instructionsMarkdown deve descrivere una traccia completa e specifica, con scenario, task e deliverable chiari
- la sezione Deliverables deve essere concreta e verificabile: non usare formule vaghe come "scrivi una soluzione", "sviluppa l elaborato" o "carica il lavoro" senza specificare quale artefatto produrre
- ogni deliverable deve chiarire il formato atteso e il contenuto minimo, ad esempio nota tecnica, tabella o schema comparativo compilato, patch commentata, checklist motivata, diagramma annotato o analisi comparativa
- non chiedere mai allo studente di usare una sintassi markdown specifica, livelli di heading, tabelle markdown, code fence o altri dettagli presentazionali
- se serve un confronto strutturato, chiedi una tabella, matrice o schema comparativo chiaro, ma non imporre il formato markdown della tabella
- approachMarkdown deve spiegare come affrontare l'esercizio in pratica, facendo da ponte tra teoria e applicazione
- exampleMarkdown deve offrire un esempio guidato o indizi utili senza risolvere esattamente l'esercizio assegnato
- se il problema avrebbe una soluzione unica o spoilerabile, usa un esempio parallelo con dati diversi oppure mostra solo l'avvio, il primo passo o gli indizi iniziali
- nel laboratorio liste e checklist sono utili quando il contenuto e davvero enumerativo, ma non trasformare ogni sezione in sola lista se un paragrafo breve spiega meglio
- se la traccia include una serie di frasi, evidenze, asset, rischi o note da trattare, rappresentali come lista markdown vera e non come righe sciolte
- evita scenari generici come "scegli un caso realistico" o "immagina un contesto plausibile": il contesto deve essere gia deciso nel laboratorio
- internalNotes serve solo come promemoria interno per il valutatore su limiti, segnali da cercare, o tipi di evidenza attesa
- se la sorgente e un PDF o un documento con chunk disponibili, valorizza sourceChunkIds per ogni esercizio quando il collegamento alla sorgente e ricostruibile senza forzature
- non inventare sourceChunkIds: omettili solo quando il collegamento sarebbe arbitrario o fuorviante

Rispondi SOLO in JSON con questa forma:
{
  "title": "Laboratorio ...",
  "summary": "Breve sintesi della fase laboratoriale",
  "exercises": [
    {
      "title": "...",
      "brief": "...",
      "instructionsMarkdown": "...",
      "approachMarkdown": "...",
      "exampleMarkdown": "...",
      "internalNotes": ["..."],
      "sourceChunkIds": ["chunk-001"]
    }
  ]
}

Vincoli:
- crea da 2 a 5 esercizi
- instructionsMarkdown deve essere ben strutturato e pronto da mostrare all'utente
- i vincoli del caso devono stare dentro instructionsMarkdown e non in un campo separato duplicato
- approachMarkdown deve contenere passi concreti, criteri di lettura del caso ed errori da evitare o verifiche iniziali
- exampleMarkdown deve essere specifico e coerente con la traccia, ma non puo coincidere con la soluzione dell'esercizio assegnato
- ogni brief deve stare in una sola frase
- evita testo ornamentale o promesse vaghe

${LAB_MARKDOWN_STYLE_RULES}

${LAB_INSTRUCTIONS_MARKDOWN_TEMPLATE}

${LAB_APPROACH_MARKDOWN_TEMPLATE}

${LAB_EXAMPLE_MARKDOWN_TEMPLATE}`;

  const draft = await callJsonModel<LaboratoryGenerationDraft>({
    content,
    model: MODEL_REASONING,
    modelSlot: 'lesson',
    onReasoning,
    reasoning: HIGH_REASONING_CONFIG,
    system,
    temperature: 0.3,
  });

  onStatus?.('Verifica specificita e supporto del laboratorio...');

  const verifiedDraft = await callJsonModel<LaboratoryGenerationDraft>({
    content: appendTextContent(
      content,
      `Draft laboratorio da rivedere e correggere:\n${JSON.stringify(draft, null, 2)}`
    ),
    model: MODEL_FLASH,
    modelSlot: 'lesson',
    onReasoning,
    system: `Sei il revisore QA di un laboratorio tecnico gia generato. Riceverai contesto completo e un draft JSON.

Obiettivo:
- restituisci lo stesso JSON completamente corretto e pronto all'uso
- rendi ogni scenario specifico, autosufficiente e realistico
- elimina richieste che delegano allo studente la scelta dello scenario o dei vincoli del caso
- assicurati che ogni esercizio abbia vincoli espliciti dentro instructionsMarkdown, approachMarkdown utile ed exampleMarkdown specifico
- verifica che la sezione Deliverables sia concreta, non generica, e che ogni output richiesto sia materialmente producibile e valutabile
- se l'esercizio ha una soluzione unica o facilmente spoilerabile, mantieni exampleMarkdown su un caso analogo, un sotto-problema o un avvio guidato, mai sulla soluzione finale assegnata
- conserva internalNotes come note interne e non trasformarle in testo per l'utente
- mantieni il focus su esercizi pratici e verificabili da allegati
- ripulisci la forma markdown: niente code fence decorative, niente paragrafi-muro, niente meta-testo come "stile atteso" o "oppure"
- usa liste markdown vere solo quando il contenuto e davvero enumerativo o operativo; se una breve spiegazione in prosa e piu naturale, mantienila
- verifica che gli esercizi siano ancora in ordine propedeutico rispetto al learningPlan e tra loro
- elimina ogni istruzione rivolta allo studente su marker markdown, livelli di heading, sintassi di tabella o altri dettagli di formattazione
- se compare una richiesta di tabella, checklist o schema, controlla che sia motivata dal contenuto e non dal desiderio di imporre un formato markdown specifico
- se approachMarkdown o exampleMarkdown non rispettano i template, riscrivili da zero in forma pulita

${LAB_MARKDOWN_STYLE_RULES}

${LAB_INSTRUCTIONS_MARKDOWN_TEMPLATE}

${LAB_APPROACH_MARKDOWN_TEMPLATE}

${LAB_EXAMPLE_MARKDOWN_TEMPLATE}

Restituisci SOLO JSON con la stessa forma del draft, senza testo extra.`,
    temperature: 0.1,
  });

  const finalDraft = {
    title: verifiedDraft.title?.trim() || draft.title,
    summary: verifiedDraft.summary?.trim() || draft.summary,
    exercises:
      Array.isArray(verifiedDraft.exercises) && verifiedDraft.exercises.length > 0
        ? verifiedDraft.exercises
        : draft.exercises,
  };

  const exercises = Array.isArray(finalDraft.exercises)
    ? finalDraft.exercises.map(normalizeExercise)
    : [];

  if (exercises.length === 0) {
    throw new Error('La generazione del laboratorio non ha prodotto esercizi validi.');
  }

  const now = new Date().toISOString();
  return {
    errorMessage: undefined,
    exercises,
    generatedAt: now,
    schemaVersion: CURRENT_LABORATORY_SCHEMA_VERSION,
    status: 'ready',
    summary: finalDraft.summary?.trim() || 'Fase laboratoriale generata automaticamente.',
    title: finalDraft.title?.trim() || 'Laboratorio',
    updatedAt: now,
  };
};

export const regenerateLaboratoryExercise = async ({
  documentIndex,
  exercise,
  learningPlan,
  onReasoning,
  onStatus,
  source,
  userProfile,
}: RegenerateLaboratoryExerciseArgs): Promise<LaboratoryExercise> => {
  onStatus?.('Rigenerazione esercizio laboratorio...');

  const generatedLaboratory = await generateLaboratory({
    documentIndex,
    learningPlan,
    onReasoning,
    onStatus,
    source,
    userProfile,
  });
  const candidate = generatedLaboratory.exercises[0];

  if (!candidate) {
    throw new Error('Non sono riuscito a rigenerare l esercizio del laboratorio.');
  }

  return {
    ...candidate,
    attachments: [],
    evaluation: null,
    id: exercise.id,
    updatedAt: new Date().toISOString(),
  };
};

export const evaluateLaboratoryExercise = async ({
  documentIndex,
  exercise,
  learningPlan,
  onReasoning,
  onStatus,
  source,
}: EvaluateLaboratoryExerciseArgs): Promise<LaboratoryExerciseEvaluation> => {
  if (exercise.attachments.length === 0) {
    throw new Error('Aggiungi almeno un allegato prima di avviare la valutazione.');
  }

  onStatus?.('Analisi allegati laboratorio...');
  const sourceSummary = await buildSourceSummary({
    documentIndex,
    exercise,
    learningPlan,
    source,
  });
  const evaluationContent = await buildEvaluationUserContent({
    attachmentWarnings: [],
    documentIndex,
    exercise,
    learningPlan,
    source,
    sourceSummary,
  });

  const evaluatorSystem = `Sei un revisore tecnico severo ma utile. Devi valutare una consegna laboratoriale.

Regole:
- giudica solo cio che e supportato da istruzioni, sorgente e allegati
- valuta la consegna rispetto ai requisiti espliciti del caso, non rispetto a una generica idea dell'argomento
- usa approachMarkdown ed exampleMarkdown come supporto dato allo studente, ma non pretendere che la soluzione copi l'esempio parola per parola
- se una prova manca, abbassa score o confidenza invece di inventare
- non parlare di rubriche, modalita o tassonomie interne
- score e confidenceScore sono interi 0-100
- summary e confidenceSummary devono essere in Italiano, brevi e chiari
- strengths, improvements e caveats devono essere liste brevi, concrete e non ridondanti tra loro
- strengths: solo elementi corretti o ben motivati
- improvements: azioni pratiche che lo studente deve fare per completare o correggere la consegna
- caveats: solo limiti della valutazione, incertezze o prove non verificabili; non ripetere mancanze gia trasformate in improvements
- se non esiste un caveat distinto dagli improvements, restituisci caveats: []

Rispondi SOLO in JSON con questa forma:
{
  "score": 0,
  "confidenceScore": 0,
  "confidenceSummary": "...",
  "summary": "...",
  "strengths": ["..."],
  "improvements": ["..."],
  "caveats": ["..."]
}`;

  onStatus?.('Prima correzione laboratorio...');
  const draft = await callJsonModel<LaboratoryEvaluationDraft>({
    content: evaluationContent,
    model: MODEL_ASSESSMENT,
    modelSlot: 'assessment',
    onReasoning,
    system: evaluatorSystem,
    temperature: 0.1,
  });

  onStatus?.('Verifica finale della valutazione...');
  const verificationSystem = `Sei un secondo revisore. Devi verificare una valutazione gia prodotta e rimuovere affermazioni non supportate.

Regole:
- mantieni il formato JSON identico
- correggi il draft solo se trovi claims troppo forti, non provati o incoerenti con gli allegati
- se l evidenza e fragile, abbassa la confidenza e aggiungi caveat
- rimuovi duplicati concettuali tra improvements e caveats: le azioni da fare restano in improvements, i limiti di verifica restano in caveats
- non aggiungere spiegazioni fuori dal JSON`;

  const verifiedDraft = await callJsonModel<LaboratoryEvaluationDraft>({
    content: appendTextContent(
      evaluationContent,
      `Valutazione iniziale da verificare:\n${JSON.stringify(normalizeEvaluation(draft), null, 2)}`
    ),
    model: MODEL_ASSESSMENT,
    modelSlot: 'assessment',
    onReasoning,
    system: verificationSystem,
    temperature: 0.1,
  });

  return normalizeEvaluation(verifiedDraft, draft);
};
