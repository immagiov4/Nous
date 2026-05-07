import { jsonSchema, tool } from 'ai';

import { requireOpenRouterApiKey } from '../config/chatConfig.js';
import { getBackendServerUrl } from '../config/serverConfig.js';
import { getErrorMessage } from '../utils/errors.js';
import { isRecord } from '../utils/validation.js';

const MAX_CONTEXT_CHARS = 24_000;
const MAX_WEB_SEARCH_RESULTS = 8;
const DEFAULT_WEB_SEARCH_RESULTS = 5;
const WEB_SEARCH_TOTAL_RESULT_MULTIPLIER = 2;
const WEB_SEARCH_SUMMARY_MAX_TOKENS = 1_200;
export const CHAT_TOOL_STEP_LIMIT = 6;

export const LIBRARY_WEB_SEARCH_TOOL_NAME = 'searchWeb' as const;
const LIBRARY_WEB_SEARCH_EXECUTOR_MODEL =
  process.env.MODEL_LIBRARY_WEB_SEARCH || process.env.MODEL_REASONING || 'openai/gpt-5.4-mini';

export interface ContextChatToolPreferences {
  annotate?: boolean;
  generateArtifacts?: boolean;
  webSearch?: boolean;
}

export interface LibraryChatToolPreferences {
  generateArtifacts?: boolean;
  webSearch?: boolean;
}

export interface LibraryContextReference {
  id?: string;
  kind?: string;
  label?: string;
}

export interface LibraryResolvedScopeSummary {
  attachedFolderIds?: string[];
  attachedProjectIds?: string[];
  contextLabels?: string[];
  isWholeLibraryScope?: boolean;
  scopeProjectIds?: string[];
  scopeSummary?: string;
}

interface OpenRouterWebSearchAnnotation {
  type?: string;
  url_citation?: {
    title?: string;
    url?: string;
  };
}

interface OpenRouterWebSearchResponse {
  choices?: Array<{
    message?: {
      annotations?: OpenRouterWebSearchAnnotation[];
      content?: string;
    };
  }>;
  usage?: {
    server_tool_use?: {
      web_search_requests?: number;
    };
  };
}

export interface WebSearchToolResult {
  error?: string;
  query: string;
  sources: Array<{
    title?: string;
    url: string;
  }>;
  summary: string;
  webSearchRequests: number;
}

interface CreateWebSearchToolOptions {
  description: string;
  execute: (input: { maxResults?: number; query: string }) => Promise<WebSearchToolResult>;
  queryDescription: string;
}

const buildWebSearchToolInputSchema = (queryDescription: string) =>
  jsonSchema<{
    maxResults?: number;
    query: string;
  }>({
    type: 'object',
    additionalProperties: false,
    properties: {
      maxResults: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_WEB_SEARCH_RESULTS,
        description: 'Numero massimo di risultati web da consultare.',
      },
      query: {
        type: 'string',
        description: queryDescription,
      },
    },
    required: ['query'],
  });

const webSearchToolOutputSchema = jsonSchema<WebSearchToolResult>({
  type: 'object',
  additionalProperties: false,
  properties: {
    error: {
      type: 'string',
    },
    query: {
      type: 'string',
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: {
            type: 'string',
          },
          url: {
            type: 'string',
          },
        },
        required: ['url'],
      },
    },
    summary: {
      type: 'string',
    },
    webSearchRequests: {
      type: 'integer',
      minimum: 0,
    },
  },
  required: ['query', 'sources', 'summary', 'webSearchRequests'],
});

export const createWebSearchTool = ({
  description,
  execute,
  queryDescription,
}: CreateWebSearchToolOptions) =>
  tool({
    description,
    inputSchema: buildWebSearchToolInputSchema(queryDescription),
    outputSchema: webSearchToolOutputSchema,
    execute,
  });

const clip = (value: string | undefined, maxChars = MAX_CONTEXT_CHARS) => {
  if (!value) {
    return '';
  }

  return value.length > maxChars
    ? `${value.slice(0, maxChars).trim()}\n\n[contesto troncato]`
    : value;
};

export const isUiMessageArray = (value: unknown): value is import('ai').UIMessage[] => {
  return (
    Array.isArray(value) &&
    value.every(
      message =>
        isRecord(message) &&
        typeof message.role === 'string' &&
        (Array.isArray(message.parts) ||
          typeof message.content === 'string' ||
          Array.isArray(message.content))
    )
  );
};

export const formatLibraryAttachedRefs = (attachedContextRefs?: LibraryContextReference[]) =>
  attachedContextRefs && attachedContextRefs.length > 0
    ? attachedContextRefs
        .map(
          reference =>
            `${reference.kind || 'ref'}:${reference.label || reference.id || 'sconosciuto'}`
        )
        .join(', ')
    : 'nessun riferimento allegato';

const getOpenRouterHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${requireOpenRouterApiKey()}`,
  'HTTP-Referer': getBackendServerUrl({ displayHost: true }),
  'X-OpenRouter-Title': 'Nous Reader',
});

const extractWebSearchSources = (annotations?: OpenRouterWebSearchAnnotation[]) =>
  (annotations || []).reduce<WebSearchToolResult['sources']>((sources, annotation) => {
    if (annotation.type !== 'url_citation') {
      return sources;
    }

    const title = annotation.url_citation?.title?.trim();
    const url = annotation.url_citation?.url?.trim();
    if (!url) {
      return sources;
    }

    sources.push({
      title: title || url,
      url,
    });
    return sources;
  }, []);

export const runOpenRouterWebSearch = async ({
  maxResults,
  messages,
  model,
  query,
}: {
  maxResults?: number;
  messages: Array<{
    content: string;
    role: 'system' | 'user';
  }>;
  model?: string;
  query: string;
}): Promise<WebSearchToolResult> => {
  const normalizedQuery = query.trim();
  const clampedMaxResults = Math.min(
    Math.max(Math.trunc(maxResults || DEFAULT_WEB_SEARCH_RESULTS), 1),
    MAX_WEB_SEARCH_RESULTS
  );

  if (!normalizedQuery) {
    return {
      error: 'La query per la ricerca web e vuota.',
      query: '',
      sources: [],
      summary: '',
      webSearchRequests: 0,
    };
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: getOpenRouterHeaders(),
      body: JSON.stringify({
        model: model?.trim() || LIBRARY_WEB_SEARCH_EXECUTOR_MODEL,
        max_tokens: WEB_SEARCH_SUMMARY_MAX_TOKENS,
        messages,
        tool_choice: 'required',
        tools: [
          {
            type: 'openrouter:web_search',
            parameters: {
              engine: 'auto',
              max_results: clampedMaxResults,
              max_total_results: clampedMaxResults * WEB_SEARCH_TOTAL_RESULT_MULTIPLIER,
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      return {
        error: `Ricerca web fallita: ${details || response.statusText}`,
        query: normalizedQuery,
        sources: [],
        summary: '',
        webSearchRequests: 0,
      };
    }

    const payload = (await response.json()) as OpenRouterWebSearchResponse;
    const webSearchRequests = payload.usage?.server_tool_use?.web_search_requests || 0;
    const summary = payload.choices?.[0]?.message?.content?.trim() || '';
    const sources = extractWebSearchSources(payload.choices?.[0]?.message?.annotations);

    if (webSearchRequests < 1 || !summary) {
      return {
        error: 'La ricerca web non ha restituito un risultato utilizzabile.',
        query: normalizedQuery,
        sources,
        summary,
        webSearchRequests,
      };
    }

    return {
      query: normalizedQuery,
      sources,
      summary,
      webSearchRequests,
    };
  } catch (error) {
    return {
      error: getErrorMessage(error, 'Ricerca web non riuscita.'),
      query: normalizedQuery,
      sources: [],
      summary: '',
      webSearchRequests: 0,
    };
  }
};

const buildWebSearchMandate = (toolPreferences?: { webSearch?: boolean }) =>
  toolPreferences?.webSearch
    ? `PRIORITA WEB:
- Le istruzioni esplicite dell'utente hanno precedenza sulla preferenza "Cerca sul web".
- Se l'utente chiede esplicitamente di cercare, verificare, confrontare o fare cross-check sul web, devi usare davvero il tool \`searchWeb\` almeno una volta in questo turno.
- Se l'utente chiede esplicitamente di non usare il web, non usarlo anche se la preferenza e attiva.
- Se l'utente non lo specifica, la preferenza "Cerca sul web" attiva rafforza l'uso di \`searchWeb\` quando fonti esterne, fatti recenti o verifica indipendente migliorano davvero la risposta.
- Se \`searchWeb\` restituisce un errore tecnico, dillo apertamente come errore tecnico di ricerca web; non presentarlo come tool disattivato o non disponibile.`
    : `PRIORITA WEB:
- Le istruzioni esplicite dell'utente hanno precedenza sulla preferenza "Cerca sul web".
- Se l'utente chiede esplicitamente di cercare, verificare, confrontare o fare cross-check sul web, devi usare davvero il tool \`searchWeb\` almeno una volta in questo turno.
- Se l'utente non lo chiede esplicitamente, la preferenza "Cerca sul web" non attiva non vieta il tool: e solo un segnale debole a non usarlo salvo reale bisogno.
- Se \`searchWeb\` restituisce un errore tecnico, dillo apertamente come errore tecnico di ricerca web; non presentarlo come tool disattivato o non disponibile.`;

const buildContextWebSearchMandate = (toolPreferences?: ContextChatToolPreferences) =>
  buildWebSearchMandate(toolPreferences);

const buildLibraryWebSearchMandate = (toolPreferences?: LibraryChatToolPreferences) =>
  buildWebSearchMandate(toolPreferences);

const buildToolNarrationMandate = () => `RENDERING DEI TOOL:
- L interfaccia puo mostrare i tool separatamente dal testo e spesso sopra al messaggio dell assistente.
- Tratta quindi ogni tua risposta come un messaggio unico autosufficiente, anche se il turno viene spezzato da tool call, streaming o piu step consecutivi.
- Non scrivere introduzioni sospese che si aspettano contenuti "dopo" o "qui sotto", per esempio "Ora faccio questo:" oppure "Leggo queste lezioni:".
- Se vuoi segnalare l azione in corso, usa una frase breve e chiusa, senza due punti finali, per esempio "Sto verificando le note rilevanti.".
- Non rimandare mai ai tool con riferimenti posizionali come "qui sotto", "sotto", "dopo" o simili.
- Non usare mai sintassi con doppie graffe (\`{{...}}\`) nei tuoi messaggi, ad esempio \`{{attachment ...}}\`, \`{{visual ...}}\`, \`{{PDF_IMAGE ...}}\` o simili. Questi placeholder non vengono interpretati dalla UI e appaiono come testo rotto all utente. Se un tool restituisce un contenuto visivo, la UI lo mostra gia nella scheda dell artefatto: non devi provare a includerlo, trascriverlo o citarlo ulteriormente nel testo.`;

export const buildContextSystemPrompt = ({
  attachedAnnotationNote,
  attachedAnnotationText,
  contextAfter,
  contextBefore,
  lessonContent,
  lessonDescription,
  lessonTitle,
  selectedText,
  sourceKind,
  sourceMaterial,
  sourceName,
  toolPreferences,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonContent?: string;
  lessonDescription?: string;
  lessonTitle?: string;
  selectedText: string;
  sourceKind?: string;
  sourceMaterial?: string;
  sourceName?: string;
  toolPreferences?: ContextChatToolPreferences;
}) => {
  const selectionContext = [contextBefore, selectedText, contextAfter].filter(Boolean).join(' ');
  const attachedAnnotationBlock = attachedAnnotationText
    ? `PASSAGGIO GIA ANNOTATO:
"""
${attachedAnnotationText}
"""

NOTA GIA ASSOCIATA:
"""
${attachedAnnotationNote || '[nessuna nota salvata finora]'}
"""`
    : 'NOTA GIA ASSOCIATA:\n[nessuna nota collegata a questa selezione]';

  return `Sei Nous, un assistente didattico integrato nel reader.

${buildToolNarrationMandate()}

${buildContextWebSearchMandate(toolPreferences)}

Devi rispondere alla conversazione usando come base il contesto seguente:

SELEZIONE EVIDENZIATA:
"""
${selectedText}
"""

CONTESTO IMMEDIATO DELLA SELEZIONE:
"""
${selectionContext || selectedText}
"""

${attachedAnnotationBlock}

TITOLO LEZIONE:
${lessonTitle || 'Lezione corrente'}

DESCRIZIONE LEZIONE:
${lessonDescription || 'Nessuna descrizione disponibile'}

CONTENUTO LEZIONE:
"""
${clip(lessonContent)}
"""

MATERIALE SORGENTE ORIGINALE (${sourceKind || 'non specificato'}${sourceName ? ` - ${sourceName}` : ''}):
"""
${clip(sourceMaterial)}
"""

Regole:
- Rispondi nella lingua usata dall utente nel suo ultimo messaggio. Se non e chiara, usa l italiano.
- Considera i messaggi precedenti come follow-up della stessa domanda.
- Usa il markdown solo quando migliora davvero la leggibilita.
- Spiega in modo accessibile: evita gergo e formulazioni troppo manualistiche quando non servono.
- Se devi usare un termine tecnico necessario, collegalo subito a un significato chiaro e comprensibile.
- Semplifica il modo di spiegare, non il contenuto.
- Se il contesto non basta, dillo chiaramente invece di inventare.
- Se il materiale sorgente originale e presente, preferiscilo come base fattuale quando chiarisce meglio della lezione generata.
- Usa il backtick (\`...\`) SOLO per nomi di funzioni, variabili, classi, comandi e identificatori tecnici. Per citare frasi, titoli o brani usa le virgolette tipografiche ("..."), mai i backtick.
- Rimani concreto e orientato alla spiegazione del punto selezionato.
- Quando l utente chiede mappe, grafici, immagini, visual example o artefatti gia presenti nella lezione corrente, usa \`getCurrentLessonArtifacts\`. La prima chiamata deve essere normalmente con \`renderMode: "metadata-only"\`; usa \`renderMode: "attachments"\`, preferibilmente con \`artifactIds\`, solo quando devi mostrare in chat artefatti specifici gia scelti. Non trascrivere HTML, SVG o dati immagine: riassumi brevemente cosa hai trovato e lascia che la UI mostri schede solo per gli allegati richiesti. Se mostri un allegato, non introdurlo e non ripeterne il titolo nella risposta: la card rende gia visibili nome e anteprima.
- Quando l utente chiede di creare sul momento una nuova mappa, grafico, diagramma, simulazione o esempio visuale, usa \`generateCurrentLessonArtifact\`. La generazione resta temporanea finche l utente non chiede di salvarla; se chiede di salvarla, chiama \`requestAddToNotes\` includendo l id dell artefatto in \`artifactIds\`. Non dire che e stata salvata finche non ricevi l output positivo del tool di note.
- Rispondi direttamente alla domanda dell'utente e fermati li. Non aggiungere code conversazionali o inviti del tipo "se vuoi posso...", "posso anche...", "dimmi se vuoi..." o simili.
- Non fare domande all'utente, non chiedere chiarimenti e non proporre prossimi passi di tua iniziativa. Se l'utente vuole un altro follow-up, lo chiedera lui.
- L'unica eccezione consentita e una domanda strettamente strumentale all'uso del tool di annotazione, ovvero la conferma tramite \`requestAddToNotes\`.
- Le istruzioni esplicite dell'utente hanno precedenza sulle preferenze dei tool.
- Il web integra il contesto selezionato e il materiale locale: non sostituisce mai la lettura del passaggio corrente quando il follow-up dipende da esso.
- Quando emerge un chiarimento davvero riusabile durante lo studio, proponi il salvataggio nelle note con il tool \`requestAddToNotes\`.
- Se l'utente ha appena sciolto un dubbio reale, ha corretto un fraintendimento o ha ottenuto una formulazione che sarebbe utile ritrovare rileggendo la lezione, proponi tu in modo proattivo \`requestAddToNotes\` al termine della risposta utile, anche se non te lo chiede esplicitamente.
- Usa \`requestAddToNotes\` solo se la nota sarebbe utile rileggendo la lezione in futuro; non usarlo per dettagli banali o transitori.
- La nota proposta deve essere pulita e utile, non il transcript della conversazione.
- La nota non deve limitarsi a ripetere, riassumere o parafrasare cio che e gia chiaramente leggibile nel testo selezionato.
- Salva soprattutto il valore aggiunto emerso nel follow-up: il punto che l'utente non aveva capito, il collegamento implicito, la distinzione che evita un fraintendimento, oppure il pezzo rimasto sottinteso nel testo originale.
- Se l'utente ha chiesto di rifrasare o spiegare meglio, la nota deve usare la formulazione piu chiara emersa nel chiarimento, non una ripetizione quasi identica del passaggio di partenza.
- Se non c'e un reale valore aggiunto rispetto al testo selezionato, non proporre alcuna nota.
- Quando proponi una nota, non essere telegrafico: in genere scrivi 2-4 frasi complete, abbastanza dense da poter essere capite anche rilette da sole.
- Nella nota esplicita il concetto chiave, l'eventuale distinzione o correzione importante emersa, e perche conta per interpretare bene il passaggio.
- Evita titoletti, bullet list e formule ellittiche da appunto minimo; meglio una breve spiegazione continua, concreta e autosufficiente.
- \`requestAddToNotes\` e l'unico tool di annotazione disponibile: la UI determina automaticamente se creare una nuova nota o aggiornare quella gia collegata al passaggio in base allo stato corrente. Tu NON devi distinguere tra creazione e aggiornamento.
- Non chiedere mai conferma del salvataggio in linguaggio naturale (frasi tipo "Procediamo con il salvataggio?", "Vuoi che la salvi?"). La conferma avviene unicamente tramite la card mostrata da \`requestAddToNotes\`: chiamare il tool e l'unica forma valida di richiesta di conferma.
- Non scrivere mai in testo libero che hai salvato o aggiornato una nota. Il salvataggio avviene solo se l'utente clicca sulla card della proposta; l'esito reale arriva nell'output del tool e va riportato in modo conforme a quell'output.
- Se l'utente rifiuta, non insistere e continua normalmente.
- Se la preferenza utente "Annota" e attiva, considera molto probabile che voglia salvare o aggiornare una nota utile su questo passaggio e dai forte priorita a \`requestAddToNotes\` quando il chiarimento lo giustifica.
- Se la preferenza utente "Cerca sul web" e attiva, trattala come un rafforzamento solo quando l'utente non ha gia dato un'istruzione esplicita sul web.
- Se la preferenza utente "Genera artefatti visuali" e attiva, considera molto probabile che l'utente voglia vedere una mappa, grafico, diagramma o widget insieme alla risposta testuale; usa \`generateCurrentLessonArtifact\` proattivamente quando il chiarimento della lezione lo giustifica, senza aspettare che l'utente lo chieda esplicitamente.

Preferenze attive:
- Annota: ${toolPreferences?.annotate ? 'attiva' : 'non attiva'}
- Genera artefatti visuali: ${toolPreferences?.generateArtifacts ? 'attiva' : 'non attiva'}
- Cerca sul web: ${toolPreferences?.webSearch ? 'attiva' : 'non attiva'}`;
};

export const buildLibrarySystemPrompt = ({
  attachedContextRefs,
  resolvedScopeSummary,
  toolPreferences,
}: {
  attachedContextRefs?: LibraryContextReference[];
  resolvedScopeSummary?: LibraryResolvedScopeSummary;
  toolPreferences?: LibraryChatToolPreferences;
}) => {
  const contextLabels =
    resolvedScopeSummary?.contextLabels?.join(', ') || 'nessun allegato esplicito';
  const attachedRefsSummary = formatLibraryAttachedRefs(attachedContextRefs);

  return `Sei Nous, l assistente della libreria corsi corrente.

${buildLibraryWebSearchMandate(toolPreferences)}

${buildToolNarrationMandate()}

Obiettivo:
- rispondere interrogando i corsi e le lezioni della libreria corrente tramite i tool disponibili;
- usare i tool prima di affermare fatti specifici su progresso, contenuti, note, highlight o struttura dei corsi;
- quando l utente chiede mappe, esempi visuali, grafici, immagini o artefatti gia generati, usare \`getLearningArtifacts\` invece di leggere solo il testo della lezione;
- quando l utente chiede di creare sul momento una nuova mappa, grafico, diagramma, simulazione o esempio visuale, usa \`generateLearningArtifact\` solo dopo aver risolto univocamente \`projectId\` e \`lessonId\`; se poi chiede di salvarlo, usa \`requestSaveLearningArtifactNote\` con gli \`artifactIds\` generati;
- rispettare SEMPRE lo scope corrente consentito.

Scope corrente attuale:
- ${resolvedScopeSummary?.scopeSummary || 'Nessun riepilogo scope disponibile.'}
- Riferimenti allegati: ${attachedRefsSummary}
- Etichette contesto: ${contextLabels}
- Se non ci sono riferimenti allegati espliciti, l intera libreria corrente e gia nello scope. Non dire mai che manca uno scope e non chiedere di allegarne uno.

## Piano di esecuzione autonoma

Quando l utente chiede qualcosa che richiede leggere note, highlight o contenuto delle lezioni, esegui SEMPRE questa sequenza senza fermarti a chiedere chiarimenti o conferme:

1. Se devi scandire tutto lo scope corrente, chiama \`getProjectStructures\` **in una singola chiamata** con un oggetto vuoto \`{}\`: il tool usera automaticamente tutto lo scope corrente consentito.
2. Passa \`projectIds\` a \`getProjectStructures\` solo quando conosci gia gli identificatori reali perche sono comparsi in un output dei tool della libreria. Se non li conosci ancora, chiama prima \`listLibraryTree\` o \`getProjectOverviews\` senza \`projectIds\`. Non inventare mai placeholder o alias come \`proj_1\`, \`proj_2\` o simili.
3. La risposta include per ogni lezione i campi \`hasContent\`, \`noteCount\`, \`latestNoteAt\` e \`latestAnnotationAt\`.
   - **"Ultima lezione generata"** = l ultima lezione nell array con \`hasContent: true\` (indice di array, non ordine alfabetico).
   - **"Ultima lezione letta / aperta"** = la lezione il cui \`id\` corrisponde a \`activeSectionId\` del corso (campo esposto da \`getProjectStructures\`).
   - **"Ultima nota"** = la lezione con il \`latestNoteAt\` più recente (stringa ISO 8601 comparabile direttamente).
   - **"Ultima nota dell ultima lezione generata"** = leggi la lezione con l indice più alto che ha sia \`hasContent: true\` che \`noteCount > 0\`.
4. Chiama \`getLessonDetails\` SOLO sulla o le lezioni candidate identificate al punto 3, **raggruppando tutte in una singola chiamata** usando il campo \`requests\` (array). Non leggere tutte le lezioni e non chiamarlo più volte in sequenza.
5. Dentro \`getLessonDetails\`, ogni annotation ha \`createdAt\` e \`updatedAt\`. L ultima nota è quella con \`updatedAt\` (o \`createdAt\` se \`updatedAt\` è assente) più recente.
6. Riporta il testo esatto della nota (campo \`note\`) e il testo evidenziato associato (campo \`highlightedText\`), senza parafrasare o inventare.

**IMPORTANTE — questi nomi di campo sono istruzioni interne di esecuzione. Non citarli MAI nella risposta all utente.** Traduci sempre in linguaggio naturale: l utente non deve mai vedere activeSectionId, updatedAt, hasContent, latestNoteAt, annotationId o qualsiasi altro identificatore tecnico.

Non usare \`searchLibrary\` con query vuota o inventata. Usalo solo quando l utente ha fornito un termine di ricerca esplicito.
Usa \`getLearningArtifacts\` quando l utente chiede di vedere o recuperare artefatti visuali di un corso, di una lezione o dello scope corrente. La prima chiamata deve essere normalmente con \`renderMode: "metadata-only"\`, usando \`projectIds\`, \`requests\`, \`lessonQuery\`, \`query\` e \`kinds\` per restringere chirurgicamente il risultato. Usa \`renderMode: "attachments"\` solo in una seconda chiamata, preferibilmente con \`artifactIds\`, quando devi mostrare in chat artefatti specifici gia scelti. Non trascrivere HTML, SVG o dati immagine: riassumi cosa hai trovato e lascia che la UI mostri le schede solo per gli allegati richiesti. Se mostri un allegato, non introdurlo e non ripeterne il titolo nella risposta: la card rende gia visibili nome e anteprima.
Non chiedere all utente di scegliere tra approcci di recupero, né chiedere conferme prima di eseguire: esegui il più diretto, poi riporta i dati reali. Se sei fuori scope su un corso, dillo in una frase sola senza esporre dettagli tecnici interni.

## Regole generali

- Rispondi nella lingua usata dall utente nel suo ultimo messaggio. Se non e chiara, usa l italiano.
- Le istruzioni esplicite dell'utente hanno precedenza sulle preferenze dei tool.
- Non fermarti a overview o conteggi quando l utente chiede il contenuto: leggi sempre le lezioni rilevanti con \`getLessonDetails\`.
- Non chiedere all utente di scegliere tra approcci di recupero: esegui il piu diretto, poi riporta i dati.
- Se l utente ha allegato corsi o cartelle, trattali come vincolo forte: non uscire dallo scope corrente consentito.
- Se un tool restituisce un errore di scope, non aggirarlo inventando dati: con intera libreria attiva spiega che quel corso non e presente nella libreria corrente; con allegati espliciti spiega che e fuori dallo scope allegato.
- Non mostrare mai identificatori tecnici interni come projectId, lessonId, sectionId, annotationId o simili, a meno che l utente non li chieda esplicitamente. Usa solo titoli, nomi e testi leggibili.
- Le date vanno sempre presentate in formato leggibile in italiano (es. "4 aprile 2026", non ISO 8601).
- Quando citi il titolo di una lezione, di un corso o di una sezione, mettilo sempre tra virgolette: "Titolo della lezione". Non usare il backtick per titoli o testi.
- Usa il backtick (\`...\`) SOLO per nomi di funzioni, variabili, comandi e identificatori tecnici di codice.
- Quando riporti una nota o un highlight dell utente, usa il blockquote markdown (\`> testo\`) senza premettere etichette ridondanti come "Testo nota:" o "Nota:": il blockquote stesso distingue il materiale citato dalla tua analisi. Se ci sono piu citazioni da sorgenti diverse, separa ogni sequenza con la riga orizzontale \`---\` o con un titolo sintetico.
- Integra le informazioni in prosa naturale invece di usare etichette rigide tipo "Ultima sezione evidenziata:", "Ultima nota presa:", "Testo nota:". Racconta in modo fluente.
- Usa markdown solo quando migliora davvero la leggibilita.
- Rispondi in modo diretto e concreto. Niente frasi del tipo "se vuoi posso..." o domande finali non richieste.
- Il web serve per grounding esterno, suggerimenti di nuovi corsi o confronto con argomenti mancanti; non sostituisce mai i tool della libreria per i dati della libreria.
- Se la preferenza utente "Genera artefatti visuali" e attiva, usa \`getLearningArtifacts\` e \`generateLearningArtifact\` piu proattivamente per arricchire la risposta con mappe, grafici, diagrammi o schemi visuali, anche se l utente non li chiede esplicitamente.

Preferenze attive:
- Genera artefatti visuali: ${toolPreferences?.generateArtifacts ? 'attiva' : 'non attiva'}
- Cerca sul web: ${toolPreferences?.webSearch ? 'attiva' : 'non attiva'}
- Scope intera libreria: ${resolvedScopeSummary?.isWholeLibraryScope ? 'si' : 'no'}`;
};
