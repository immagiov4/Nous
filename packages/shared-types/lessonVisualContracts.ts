import {
  INTERACTIVE_VISUAL_VALUE_RULE,
  MAX_GENERATED_VISUALS_PER_LESSON,
  MAX_VISUAL_LESSON_CHARS,
  NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT,
  VISUAL_FORMAT_SELECTION_RULE,
} from './lessonGenerationPolicy';

export interface HtmlArtifactImageRequest {
  alt: string;
  id: string;
  prompt: string;
}

const GENERATED_IMAGE_PLACEHOLDER_PREFIX = '{{GENERATED_IMAGE:';
const GENERATED_IMAGE_PLACEHOLDER_SUFFIX = '}}';

const isValidGeneratedImageId = (id: string): boolean => {
  if (id.length === 0 || id.length > 64 || id[0] < 'a' || id[0] > 'z') return false;
  for (const character of id.slice(1)) {
    const isLetter = character >= 'a' && character <= 'z';
    const isDigit = character >= '0' && character <= '9';
    if (!isLetter && !isDigit && character !== '-' && character !== '_') return false;
  }
  return true;
};

const readGeneratedImagePlaceholderIds = (code: string): Set<string> | null => {
  const ids = new Set<string>();
  let searchFrom = 0;
  while (searchFrom < code.length) {
    const start = code.indexOf(GENERATED_IMAGE_PLACEHOLDER_PREFIX, searchFrom);
    if (start < 0) return ids;
    const idStart = start + GENERATED_IMAGE_PLACEHOLDER_PREFIX.length;
    const end = code.indexOf(GENERATED_IMAGE_PLACEHOLDER_SUFFIX, idStart);
    if (end < 0) return null;
    const id = code.slice(idStart, end);
    if (!isValidGeneratedImageId(id)) return null;
    ids.add(id);
    searchFrom = end + GENERATED_IMAGE_PLACEHOLDER_SUFFIX.length;
  }
  return ids;
};

export const normalizeHtmlArtifactImageRequests = (
  requests: unknown,
  code: string
): HtmlArtifactImageRequest[] | null => {
  const placeholderIds = readGeneratedImagePlaceholderIds(code);
  if (!placeholderIds) return null;
  const normalized: HtmlArtifactImageRequest[] = [];
  const requestIds = new Set<string>();

  for (const request of Array.isArray(requests) ? requests : []) {
    if (!request || typeof request !== 'object') return null;
    const record = request as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
    const alt = typeof record.alt === 'string' ? record.alt.trim() : '';
    if (
      !isValidGeneratedImageId(id) ||
      !prompt ||
      !alt ||
      requestIds.has(id) ||
      !placeholderIds.has(id)
    ) {
      return null;
    }
    requestIds.add(id);
    normalized.push({ alt, id, prompt });
  }

  return placeholderIds.size === requestIds.size ? normalized : null;
};

interface LessonRasterImagePromptInput {
  concept: string;
  factualRequirements: readonly string[];
  lessonMarkdown: string;
  pedagogicalGoal: string;
  sectionDescription: string;
  sectionTitle: string;
  visualDirection: string;
}

export const getLessonRasterImageSubject = (input: LessonRasterImagePromptInput): string => {
  const subject = input.concept.trim() || input.sectionDescription.trim() || input.sectionTitle;
  const lines = subject.split('\n');
  const requestLineIndex = lines.findIndex(
    (line, index) => index > 0 && line.trimStart().toLowerCase().startsWith('richiesta:')
  );
  const subjectWithoutRequest =
    requestLineIndex < 0 ? subject : lines.slice(0, requestLineIndex).join('\n');
  return subjectWithoutRequest.trim() || input.sectionTitle;
};

export const buildLessonRasterImagePrompt = (input: LessonRasterImagePromptInput): string => {
  const subject = getLessonRasterImageSubject(input);
  const factualRequirements = input.factualRequirements.filter(Boolean).join('\n- ') || subject;
  const visualDirection =
    input.visualDirection.trim() ||
    'Composizione orizzontale chiara, soggetto principale immediatamente riconoscibile e gerarchia visiva semplice.';

  return [
    'SCOPO',
    `Crea una singola immagine pedagogica accurata per aiutare a comprendere: ${input.pedagogicalGoal || 'il concetto centrale'}.`,
    '',
    'SOGGETTO E CONTESTO',
    `Soggetto: ${subject}`,
    `Lezione: ${input.sectionTitle}. ${input.sectionDescription}`,
    '',
    'REQUISITI FATTUALI OBBLIGATORI',
    `- ${factualRequirements}`,
    '',
    'COMPOSIZIONE',
    visualDirection,
    'Formato orizzontale 16:9. Mostra solo elementi utili alla comprensione.',
    '',
    'STILE',
    'Illustrazione educativa precisa, leggibile, visivamente coerente e non decorativa. Materiali, luce, anatomia, prospettiva e relazioni spaziali devono essere plausibili per il soggetto.',
    NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT,
    '',
    'VINCOLI',
    '- Usa testo, numeri, etichette o frecce solo quando sono necessari per leggere il contenuto pedagogico; mantienili brevi, corretti e nella lingua della lezione.',
    '- Nessun logo, watermark, didascalia narrativa o testo decorativo.',
    '- Nessuna interfaccia grafica, cornice decorativa o elemento estraneo.',
    '- Non trasformare il soggetto in un diagramma di blocchi: questa richiesta e raster perche il suo aspetto concreto o la sua complessita spaziale sono informativi.',
    '',
    `CONTESTO FATTUALE DELLA LEZIONE\n${input.lessonMarkdown.slice(0, 4_000)}`,
  ].join('\n');
};

export const buildEmbeddedArtifactImagePrompt = (
  request: HtmlArtifactImageRequest,
  input: Pick<
    LessonRasterImagePromptInput,
    'concept' | 'lessonMarkdown' | 'sectionDescription' | 'sectionTitle'
  >
): string => `Genera un singolo asset raster da inserire in un artefatto didattico HTML.

Asset richiesto: ${request.prompt}
Testo alternativo previsto: ${request.alt}
Lezione: ${input.sectionTitle}. ${input.sectionDescription}
Artefatto: ${input.concept || 'esempio visuale interattivo'}

${NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT}

L'immagine deve essere autonoma, accurata e immediatamente leggibile. Nessuna interfaccia, cornice, watermark, logo o decorazione estranea. Non aggiungere testo salvo quando il prompt lo richiede esplicitamente; in quel caso usa la lingua della lezione. Mantieni il soggetto principale ben dentro i bordi e lascia margine sufficiente per eventuali ritagli responsive.

CONTESTO FATTUALE DELLA LEZIONE
${input.lessonMarkdown.slice(0, 3_000)}`;

export const LESSON_VISUAL_PLANNING_RULES = `- ${INTERACTIVE_VISUAL_VALUE_RULE}
- ${VISUAL_FORMAT_SELECTION_RULE}
- Per la generazione automatica pianifica normalmente zero o un artefatto, due solo se rispondono a domande pedagogiche diverse e complementari, tre solo se sono tutti indispensabili. Mai produrre varianti estetiche dello stesso contenuto.
- La varieta dei formati non e mai un obiettivo. Due o tre immagini raster sono corrette quando sono la soluzione pedagogica migliore.
- Non simulare immagini con ASCII art, testo monospace, celle, coordinate, box geometrici o SVG. Se l'aspetto concreto conta, usa illustrative_image.
- Non generare visuali decorative. Ogni visuale deve insegnare qualcosa che il testo da solo rende piu faticoso da capire, non limitarsi a riassumerlo o parafrasarlo.
- Ogni piano deve restare nella sezione locale in cui e collocato: non anticipare concetti di sezioni successive e non fondere argomenti lontani.
- La visuale deve essere comprensibile in pochi secondi usando termini naturali gia introdotti nel testo vicino. Vietati gergo inventato, etichette esoteriche, formule nominali ambigue e controlli dal risultato non osservabile.
- Se la lezione presenta un insieme di elementi equivalenti, la visuale deve rappresentarli tutti. Usa single_complex soltanto quando un elemento e oggettivamente piu complesso e giustifica l'eccezione in reason.
- Niente narrazione, takeaway, riepiloghi o box conclusivi dentro la visuale. Il testo visibile deve servire a leggere entita, stati, relazioni o controlli.
- Scala il layout al numero di elementi: con molti elementi usa griglie o colonne compatte, minimizza le entita grafiche e abbrevia le etichette invece di comprimere il contenuto.
- Restituisci da zero a ${MAX_GENERATED_VISUALS_PER_LESSON} piani e usa soltanto il numero minimo necessario.`;

export const LESSON_VISUAL_PLANNER_SYSTEM_PROMPT = `SYSTEM:
Sei un pianificatore pedagogico di esempi visivi per Nous Reader.
Dato il testo finale di una lezione, decidi quali rappresentazioni visive generate servono davvero.

Scegli esattamente un tipo per ciascun piano:
- illustrative_image: illustrazione raster per realta fisica o stilizzata, forma dimensionale, luce, ombreggiatura, volume, prospettiva, materiali, superfici, texture, anatomia, gesti, oggetti, scene, luoghi e fenomeni. Puo anche avere una composizione diagrammatica con frecce ed etichette quando queste aiutano a leggere l'immagine.
- flowchart_svg: solo relazioni astratte tra passaggi testuali di un processo, pipeline o albero decisionale. I nodi non possono raffigurare gli stati visivi prodotti dai passaggi.
- structural_svg: solo schema informativo semplice di contenimento, architettura, strati o parti dentro un sistema.
- interactive_html: laboratorio HTML/CSS/JavaScript in cui l'interazione reale e indispensabile per esplorare, modificare o confrontare il concetto.
- chart_html: dati quantitativi, confronti numerici, distribuzioni, trend.
- mermaid_erd: solo schema entita-relazioni.
- mermaid_class: solo classi, ereditarieta, interfacce, associazioni.
- none: nessuna visuale utile, oppure la lezione e gia sufficientemente visuale.

Regole:
${LESSON_VISUAL_PLANNING_RULES}
- Per una richiesta esplicita pianifica un solo artefatto.
- Inferisci la lingua dal testo finale della lezione. La visuale deve usare la stessa lingua della lezione.
- Se "Immagini PDF gia integrate" e "si", trattale come materiale visivo primario. Aggiungi una visuale generata solo se risponde a una domanda pedagogica distinta che le immagini della fonte non coprono; altrimenti non pianificare nulla.
- Il posizionamento e parte della scelta pedagogica. Se generi una visuale, scegli in "anchor_heading" il heading ESATTO sotto cui il testo usa o introduce quel concetto. Usa null solo per visuali davvero conclusive.
- Usa Mermaid solo per ER e class diagram.
- Segui esattamente il formato di output richiesto in fondo.`;

const normalizeHeadingTitle = (value: string): string =>
  value
    .replace(/^#{1,6}\s+/, '')
    .replaceAll(/[*_`]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export const getMarkdownHeadingTitles = (markdown: string): string[] =>
  markdown
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^#{1,6}\s+/.test(line))
    .map(line => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean);

export const resolveLessonVisualAnchorHeading = (
  plannedAnchorHeading: unknown,
  availableHeadings: readonly string[]
): string | undefined => {
  if (typeof plannedAnchorHeading !== 'string' || !plannedAnchorHeading.trim()) return undefined;
  const headingByNormalized = new Map(
    availableHeadings.map(heading => [normalizeHeadingTitle(heading), heading])
  );
  return headingByNormalized.get(normalizeHeadingTitle(plannedAnchorHeading));
};

interface LessonVisualPlannerRequestInput {
  readonly generationNotes?: string;
  readonly hasPdfImages: boolean;
  readonly lessonMarkdown: string;
  readonly sectionDescription: string;
  readonly sectionTitle: string;
}

export const buildLessonVisualPlannerRequest = (input: LessonVisualPlannerRequestInput): string =>
  `Lezione: "${input.sectionTitle}"
Descrizione: "${input.sectionDescription}"
Immagini PDF gia integrate: ${input.hasPdfImages ? 'si' : 'no'}
Note corso: ${input.generationNotes?.trim() || 'nessuna'}
Lingua target: inferiscila dal testo della lezione e mantienila in ogni testo visibile dell'esempio.
Heading disponibili per il posizionamento:
${
  getMarkdownHeadingTitles(input.lessonMarkdown)
    .map(heading => `- ${heading}`)
    .join('\n') || '- nessun heading disponibile'
}

Testo lezione:
${input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}`;

export const SVG_ARTIFACT_RENDER_RULES = `Regole SVG obbligatorie:
- SVG e riservato a schemi informativi semplici: pochi nodi, box, linee, frecce ed etichette per relazioni, gerarchie, contenimento e architetture astratte. Sono vietati realta fisica o stilizzata, forma dimensionale, luce, volume, prospettiva, materiali, superfici, texture, illustrazioni, forme organiche, persone, anatomia, gesti, oggetti raffigurati e scene. Non approssimare questi soggetti con box o disegni geometrici: richiedono un'immagine raster.
- Se coverage e all_elements, rappresenta tutti gli elementi dell'insieme in un unico grafico. Usa una griglia o colonne per distribuirli.
- Tutto il testo visibile deve essere nella lingua della lezione e usare termini naturali gia presenti nel testo locale.
- Produci un singolo elemento <svg>, senza wrapper, DOCTYPE, HTML, script, event handler o risorse di rete.
- Usa viewBox "0 0 680 H", width="100%", sfondo trasparente e nessun rettangolo esterno di background.
- Il primo figlio e <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>.
- Usa solo classi gia disponibili: .t, .ts, .th, .box, .arr, .leader, .node, .c-purple, .c-teal, .c-coral, .c-pink, .c-gray, .c-blue, .c-green, .c-amber, .c-red.
- Ogni <text> ha class .t, .ts o .th e dominant-baseline="central". Usa sentence case, non Title Case o tutto maiuscolo.
- Connettori <path> e <polyline> hanno fill="none"; le frecce usano marker-end="url(#arrow)".
- Niente shadow, blur, glow, filter, emoji, HTML o commenti. Usa al massimo due rampe colore; c-gray e il default e c-amber/c-red/c-green sono solo semantici.
- Altezza viewBox = ultimo elemento + 40px.
- Calcola la larghezza dei box dal testo: circa 8px per carattere a 14px e 7px a 12px, piu 24px di padding. Abbrevia il testo prima di farlo sforare.
- Box a una riga: 44px. Box a due righe: 56px, con 22px tra titolo e sottotitolo; titolo a cy - 9 e sottotitolo a cy + 13.
- Padding interno almeno 24px, gap tra box adiacenti almeno 60px e gap freccia-bordo almeno 10px.
- Prima di posizionare una riga verifica che N * box_width + (N - 1) * gap sia al massimo 600. Se non entra, usa piu righe.
- Se una freccia attraverserebbe un box non collegato, usa un percorso a L in spazio libero.
- Applica le classi c-* a un gruppo che contiene rect e text, senza annidare un altro gruppo intermedio.
- Ogni etichetta ha da una a sei parole. Vietati caption narrative, box di sintesi, takeaway e frasi complete di prosa.`;

export const HTML_ARTIFACT_RENDER_RULES = `Regole HTML obbligatorie:
- Se coverage e all_elements, rappresenta tutti gli elementi dell'insieme con schede, stepper, pannelli o una griglia.
- Tutto il testo visibile deve essere nella lingua della lezione e usare termini naturali gia introdotti nel testo locale. Ogni controllo dichiara un effetto osservabile e lo produce davvero.
- Nessun DOCTYPE, <html>, <head> o <body>. Ordine immutabile: <style> prima, HTML in mezzo, <script> ultimo.
- Ogni ID usato in document.getElementById esiste letteralmente nell'HTML prima dello script. Non creare quegli elementi via JavaScript.
- Non dereferenziare direttamente document.getElementById(...).property: salva il risultato, verifica il caso null e poi usa la variabile.
- Usa le variabili CSS --bg-paper, --bg-surface, --ink-primary, --ink-secondary, --accent, --border-subtle, --border-strong.
- Niente @media (prefers-color-scheme: dark), position:fixed, ombre pesanti, blur, filter, backdrop-filter o gradienti. L'host gestisce il tema scuro.
- Container in flow con display:block e width:100%. Ogni range input ha step e i numeri mostrati sono arrotondati o formattati.
- Il codice deve limitarsi all'esempio didattico mostrato nel proprio pannello e non deve eseguire azioni malevole, ingannevoli o estranee alla richiesta.
- Non usare rete, fetch, XMLHttpRequest, WebSocket, EventSource, script esterni o import dinamici. Non navigare la pagina, aprire popup, avviare download, usare storage, cookie, clipboard, API del dispositivo o tentare di comunicare con la pagina parent. Non creare pulsanti finti per link esterni o chat.
- Usa HTML/CSS/JavaScript per grafica naturalmente programmabile: pattern generativi, confronti CSS, simulazioni, stati, trasformazioni e shader semplici. Non renderizzare ASCII art o pseudo-pixel con testo monospace.
- La grafica deve derivare da una legge o procedura verificabile. Non codificare a mano illustrazioni, modelli 3D o pixel art complessa come array di coordinate, celle o colori.
- Se serve giudizio artistico o comprensione spaziale reale, usa un'immagine generata tramite imageRequests, non coordinate, CSS, canvas o SVG improvvisati.
- Ogni asset artistico appare esclusivamente come <img src="{{GENERATED_IMAGE:asset-id-univoco}}" alt="...">. Ogni placeholder ha una richiesta con lo stesso id e viceversa.
- Gli id degli asset iniziano con una lettera minuscola e contengono solo minuscole, numeri, trattini o underscore. I prompt sono autonomi e non usano riferimenti come "come sopra".
- Richiedi soltanto immagini indispensabili; se una sola immagine composita basta, preferiscila. Se non servono immagini, imageRequests e vuoto.
- Non aggiungere controlli finti a una dimostrazione passiva. Input, controlli e risultato che modificano stanno nello stesso pannello o nella stessa riga logica.
- Usa spazio, margini e padding con parsimonia. Per piu controlli usa una griglia compatta e responsive; evita min-height arbitrari e lunghe colonne a tutta larghezza.
- Titoli da una a tre parole e label da una a sei parole. Vietati caption narrative, box di sintesi, takeaway e paragrafi che riassumono la lezione.`;

export const MERMAID_ARTIFACT_RENDER_RULES = `Regole Mermaid obbligatorie:
- Se coverage e all_elements, includi tutte le entita o classi dell'insieme.
- Tutti i nomi visibili, campi e relazioni sono nella lingua della lezione quando non sono termini tecnici obbligati.
- Usa erDiagram soltanto per modelli entita-relazione e classDiagram soltanto per strutture orientate agli oggetti.
- Non usare flowchart, sequenceDiagram o altri tipi Mermaid e non usare markdown fence.
- Tieni il diagramma compatto: soltanto entita, campi e relazioni essenziali, con nomi brevi da una a tre parole.
- Etichetta chiaramente le relazioni e annota tipi e chiavi primarie o esterne quando pertinenti.`;
