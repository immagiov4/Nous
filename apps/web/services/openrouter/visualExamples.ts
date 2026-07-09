import type { LessonGeneratedVisual } from '../../types.ts';
import { timestampIso } from '../../utils/time.ts';
import {
  findMissingStaticHtmlElementIds,
  hasUnsafeHtmlElementDereferences,
} from '../../utils/visuals/htmlElementReferences.ts';
import {
  callOpenRouter,
  MEDIUM_REASONING_CONFIG,
  MODEL_VISUAL_PLANNER,
  MODEL_VISUAL_RENDERER,
  parseCleanJson,
  retryWithBackoff,
} from './shared.ts';

const VISUAL_ID_PREFIX = 'visual-';
const MAX_VISUAL_LESSON_CHARS = 12000;

const VISUAL_PLANNER_PROMPT = `SYSTEM:
Sei un pianificatore pedagogico di esempi visivi per Nous Reader.
Dato il testo finale di una lezione, decidi se serve una rappresentazione visiva generata.

Scegli esattamente un tipo:
- illustrative_svg: intuizione spaziale, meccanismo fisico, metafora visuale, concetto astratto difficile.
- flowchart_svg: processo, pipeline, sequenza, albero decisionale.
- structural_svg: contenimento, architettura, strati, parti dentro un sistema.
- interactive_html: variabile manipolabile o esplorazione passo-passo.
- chart_html: dati quantitativi, confronti numerici, distribuzioni, trend.
- mermaid_erd: solo schema entita-relazioni.
- mermaid_class: solo classi, ereditarieta, interfacce, associazioni.
- none: nessuna visuale utile, oppure la lezione e gia sufficientemente visuale.

Regole:
- Inferisci la lingua dal testo finale della lezione. La visuale deve usare la stessa lingua della lezione.
- Preferisci una visuale quando mancano immagini del PDF e il concetto contiene relazioni, flussi, struttura o variabili.
- Non generare visuali decorative. La visuale deve insegnare qualcosa che il testo da solo rende piu faticoso.
- Se "Immagini PDF gia integrate" e "si", scegli "none": le immagini del PDF sono il materiale visivo primario e non vanno affiancate da visuali generate meno deterministiche.
- Il posizionamento e parte della scelta pedagogica. Se generi una visuale, scegli in "anchor_heading" il heading ESATTO sotto cui il testo usa o introduce quel concetto. Usa null solo per visuali davvero conclusive.
- **Copertura completa di elementi co-presenti.** Se la lezione presenta un insieme di elementi equivalenti (es. un elenco di N regole, N principi, N caratteristiche, N passaggi, N tipologie), la visuale deve rappresentarli TUTTI in un unico grafico. Non e accettabile scegliere un solo sottoelemento e ignorare gli altri. L'unica eccezione e quando un elemento e oggettivamente molto piu complesso degli altri e necessita una visuale dedicata mentre gli altri sono banali e auto-esplicativi; in quel caso la scelta deve essere giustificata nel campo "reason".
- **La visuale deve aggiungere valore informativo, non riassumere.** Se la visuale si limiterebbe a elencare visivamente cio che il testo dice gia chiaramente (es. un elenco puntato di concetti semplici gia ben descritti), scegli "none": la visuale deve insegnare qualcosa che il testo da solo rende piu faticoso da capire, non decorare ne parafrasare.
- **Niente narrazione, takeaway, "moral of the story", riepiloghi.** La visuale non e un'estensione del testo della lezione: e un grafico didattico. Non deve contenere paragrafi narrativi, sintesi finali, "cambio di paradigma", "concetto chiave", "punto fondamentale", "in una frase". Quei contenuti vanno nel testo della lezione, non nella visuale.
- **Scala la complessita in base al numero di elementi.** Se ci sono molti elementi da rappresentare (es. 5+ regole), usa layout a griglia, non una fila orizzontale ne una torre verticale. Se gli elementi sono troppi per un unico grafico leggibile, valuta se una sintesi visuale ha senso o se e meglio "none".
- Usa Mermaid solo per ER e class diagram.
- **Scegli il tipo visuale in base allo spazio disponibile.** Preferisci tipi che richiedono pochi elementi grafici ma sono informativi. Se il concetto ha molti sotto-elementi, prediligi layout verticale o a griglia compatta, non una fila orizzontale di blocchi.
- **Minimizza il numero di entita grafiche.** Ogni blocco, nodo o forma aggiunge complessita visiva. Chiediti se puoi eliminare elementi senza perdere informazione. Meglio 3 blocchi ben spaziati che 5 compressi.
- **Non sovraccaricare ne in orizzontale ne in verticale.** Distribuisci gli elementi in modo bilanciato. Se la visuale richiede piu di 3 elementi con testo, usa griglie compatte o layout a colonne. Evita sia file orizzontali interminabili sia torri verticali senza fine.
- **Stima la larghezza del testo.** Titoli di 1-2 parole sono ideali. Se il testo descrittivo e lungo, scegli un layout verticale che dia spazio sufficiente.
- Rispondi SOLO con JSON:
{
  "visual_type": "...",
  "concept": "una frase sul soggetto visuale",
  "pedagogical_goal": "build_intuition | show_process | show_structure | enable_exploration | show_data",
  "anchor_heading": "heading esatto della lezione oppure null",
  "interaction_level": "none | low | high",
  "complexity": "simple | moderate | complex",
  "coverage": "all_elements | single_complex | complete_synthesis | none",
  "coverage_rationale": "breve spiegazione: perche la visuale copre tutti gli elementi, perche ne rappresenta solo uno, o perche nessuna visuale",
  "reason": "una frase sul valore pedagogico della scelta"
}`;

const RENDERER_SVG_PROMPT = `SYSTEM:
Sei un generatore esperto di SVG didattici per Nous Reader.
Genera una singola visuale SVG auto-contenuta basata sul concept fornito.

Output SOLO JSON:
{
  "title": "snake_case_title",
  "loading_messages": ["uno", "due", "tre"],
  "svg_code": "<svg ...>...</svg>"
}

Regole SVG obbligatorie:
- **Copertura completa.** Se il planner ha indicato "coverage": "all_elements", la visuale SVG deve rappresentare TUTTI gli elementi dell'insieme in un unico grafico. Non puoi sceglierne solo uno. Usa layout a griglia o a colonne per distribuirli bilanciatamente.
- Tutto il testo visibile dentro l'SVG deve essere nella stessa lingua della lezione fornita. Non tradurre in inglese se la lezione non e in inglese.
- svg_code deve essere un singolo elemento <svg>, senza wrapper, DOCTYPE o tag HTML.
- viewBox sempre "0 0 680 H"; larghezza 680 obbligatoria. width="100%".
- Sfondo trasparente. Nessun rettangolo esterno di background.
- Primo figlio: <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
- Usa solo classi gia disponibili: .t, .ts, .th, .box, .arr, .leader, .node, .c-purple, .c-teal, .c-coral, .c-pink, .c-gray, .c-blue, .c-green, .c-amber, .c-red.
- Ogni <text> deve avere class .t, .ts o .th e dominant-baseline="central".
- Usa sentence case, non Title Case e non tutto maiuscolo.
- Connettori <path> e <polyline> sempre fill="none"; frecce con marker-end="url(#arrow)".
- Niente gradienti salvo una sola linearGradient per proprieta fisiche continue.
- Niente shadow, blur, glow, filter, emoji, HTML, commenti, icone dentro box.
- Usa al massimo due rampe colore; c-gray come default, c-amber/c-red/c-green solo semanticamente.
- Altezza viewBox = ultimo elemento + 40px.
- **Larghezza box dal testo:** prima di scrivere un <rect>, trova la label piu lunga tra titolo e sottotitolo. A 14px weight-500: ~8px/char; a 12px: ~7px/char. Formula: rect_width = max(titolo_chars × 8, sottotitolo_chars × 7) + 24. Esempio: sottotitolo di 20 char → min 164px. Se il testo e piu lungo del box, abbrevia il testo — non sperare che vada bene.
- **Altezze canoniche:** single-line box = 44px; two-line box (titolo + sottotitolo) = 56px con 22px di distanza tra le due righe. y del titolo = cy - 9; y del sottotitolo = cy + 13 (dove cy e il centro verticale del box).
- **Spaziatura:** padding interno box ≥ 24px; gap minimo tra box adiacenti = 60px; gap freccia-bordo ≥ 10px.
- **Tier packing:** prima di posizionare una riga di N box, verifica che N × box_width + (N-1) × gap ≤ 600. Se non entra, riduci la larghezza dei box oppure distribuisci su 2 righe. Mai stimare a occhio.
- **Frecce che deviano:** se il percorso diretto di una freccia attraversa un box non collegato, usa un L-bend: <path d="M x1 y1 L x1 ymid L x2 ymid L x2 y2" fill="none" class="arr" marker-end="url(#arrow)"/>. Scegli ymid in uno spazio libero tra i box.
- **Uso c-{ramp}:** wrappa sempre rect + text in un <g class="c-*"> — cosi sia il fill del box sia il colore del testo vengono applicati. Se metti c-* direttamente sul <rect> il testo sibling non prende il colore. Non annidare un <g> dentro un <g class="c-*"> (le shape diventano nipoti e il CSS non le raggiunge).
- **Label in diagrammi illustrativi:** posiziona le etichette fuori dall'oggetto disegnato, con una linea guida tratteggiata (<line class="leader"/>). Default: lato destro con text-anchor="start". Riserva almeno 140px di margine orizzontale sul lato delle etichette. Usa class="ts" per callout descrittivi, class="th" per nomi di componenti principali.
- **Adatta il testo alla viewBox:** la viewBox e fissa a 680px. Se il testo sfora, abbrevia prima di allargare i box.
- **Niente caption narrativa, niente box di sintesi, niente "takeaway".** Non aggiungere riquadri finali con titoli tipo "Cambio di paradigma", "Concetto chiave", "In sintesi", "In una frase", "Punto chiave", "Conclusione", o simili. Non scrivere paragrafi di prosa dentro l'SVG. Ogni <text> deve essere un'etichetta breve (1-6 parole) o una label di nodo, MAI una frase narrativa multi-riga che riassume la lezione. Se senti il bisogno di "spiegare" la visuale dentro l'SVG, la visuale e gia sbagliata: rifalla con etichette piu chiare.
- **Vietate frasi complete di prosa.** Niente periodi che iniziano con "Il...", "La...", "Quando...", "Mentre...", "Perche...", "In Rust...", "Nei linguaggi...", o costruzioni soggetto-verbo-complemento estese. Le label sono nominali e telegrafiche, non discorsive.`;

const RENDERER_HTML_PROMPT = `SYSTEM:
Sei un generatore esperto di widget HTML interattivi per Nous Reader.
Genera un frammento HTML auto-contenuto che insegna tramite interazione diretta.

Output SOLO JSON:
{
  "title": "snake_case_title",
  "loading_messages": ["uno", "due", "tre"],
  "widget_code": "<style>...</style>\\n...HTML...\\n<script>...</script>"
}

Regole:
- **Copertura completa.** Se il planner ha indicato "coverage": "all_elements", il widget deve rappresentare TUTTI gli elementi dell'insieme, non solo uno. Usa schede, stepper, pannelli o layout a griglia per distribuirli.
- Tutto il testo visibile nel widget deve essere nella stessa lingua della lezione fornita. Non tradurre in inglese se la lezione non e in inglese.
- Nessun DOCTYPE, <html>, <head>, <body>.
- Ordine immutabile: <style> prima, HTML in mezzo, <script> ultimo.
- Ogni ID usato in document.getElementById deve esistere letteralmente nell'HTML prima dello script. Non creare quegli elementi via JavaScript.
- Vietato dereferenziare direttamente document.getElementById(...).property. Salva prima il risultato in una variabile e gestisci esplicitamente il caso null prima di leggere o assegnare proprieta. Questa regola vale anche nei cicli e nei forEach.
- In modalita replacement-draft non copiare ciecamente il JavaScript sorgente: correggi eventuali lookup DOM incoerenti o errori runtime prima di restituire la bozza.
- Usa sempre variabili CSS: --bg-paper, --bg-surface, --ink-primary, --ink-secondary, --accent, --border-subtle, --border-strong.
- Niente @media (prefers-color-scheme: dark); host gestisce .dark.
- Niente position:fixed, shadow pesanti, blur, filter, backdrop-filter, gradienti.
- Container in flow: display:block; width:100%.
- Range input sempre con step.
- Numeri mostrati sempre arrotondati/formattati.
- CDN consentiti solo: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh.
- Non creare pulsanti finti per link esterni o chat.
- Interazione appropriata: calculator, stepper, comparison, state-machine, layered-view, simulation o chart.
- **Gestione dello spazio:** il container e width:100% ma non devi riempirlo tutto. Usa lo spazio in modo parsimonioso. Preferisci colonne verticali a righe orizzontali quando ci sono molti elementi.
- **Aria tra sezioni:** aggiungi margin-bottom e padding generosi. Non accostare elementi senza spazio intermedio.
- **Titoli compatti:** usa titoli brevi (1-3 parole). Il testo lungo va in descrizioni sotto il titolo, non nel titolo stesso.
- **Non sovraccaricare:** se l'interazione richiede molti elementi di UI, scegli un design essenziale. Ogni input, label, bottone extra aumenta la densita visiva. Non accumulare troppi widget in verticale ne in orizzontale.
- **Niente caption narrativa, niente box di sintesi, niente "takeaway".** Non aggiungere sezioni finali con titoli tipo "Cambio di paradigma", "Concetto chiave", "In sintesi", "In una frase", "Punto chiave", "Conclusione". Non scrivere paragrafi di prosa dentro il widget. Le label sono nominali e brevi (1-6 parole), non frasi discorsive che riassumono la lezione. Il widget insegna interagendo, non recitando un riepilogo.`;

const RENDERER_MERMAID_PROMPT = `SYSTEM:
Sei un generatore di diagrammi Mermaid solo per database e classi.

Output SOLO JSON:
{
  "title": "snake_case_title",
  "diagram_type": "erDiagram | classDiagram",
  "mermaid_code": "..."
}

Regole:
- **Copertura completa.** Se il planner ha indicato "coverage": "all_elements", il diagramma deve includere TUTTE le entita o classi dell'insieme, non un sottoinsieme.
- Tutti i nomi visibili, campi e relazioni devono essere nella stessa lingua della lezione fornita quando non sono termini tecnici obbligati.
- Usa erDiagram solo per modelli entita-relazione.
- Usa classDiagram solo per strutture OOP.
- Non usare flowchart, sequenceDiagram o altri tipi Mermaid.
- Nessun markdown fence.
- **Entita minime:** tieni il diagramma compatto. Non aggiungere campi o relazioni decorative. Mostra solo le entita essenziali per il concetto.
- **Nomi brevi:** usa nomi di entita e campi brevi (1-3 parole). Se un nome naturale e lungo, accorcialo e usa un alias descrittivo.
- **Spaziatura:** Mermaid gestisce il layout automaticamente, ma istruisci il diagramma per evitare sovraffollamento in qualsiasi direzione. Poche entita per riga e poche righe totali. Se servono molte entita, suddividi in piu diagrammi.
- Etichetta relazioni chiaramente; annota tipi, PK/FK quando pertinenti.`;

type VisualType =
  | 'chart_html'
  | 'flowchart_svg'
  | 'illustrative_svg'
  | 'interactive_html'
  | 'mermaid_class'
  | 'mermaid_erd'
  | 'none'
  | 'structural_svg';

interface VisualPlan {
  anchor_heading?: null | string;
  complexity?: 'simple' | 'moderate' | 'complex';
  concept?: string;
  coverage?: 'all_elements' | 'single_complex' | 'complete_synthesis' | 'none';
  coverage_rationale?: string;
  interaction_level?: 'none' | 'low' | 'high';
  pedagogical_goal?: string;
  reason?: string;
  split_into_multiple?: boolean;
  visual_type?: VisualType;
}

interface SvgVisualResponse {
  loading_messages?: unknown;
  svg_code?: unknown;
  title?: unknown;
}

interface HtmlVisualResponse {
  loading_messages?: unknown;
  title?: unknown;
  widget_code?: unknown;
}

interface MermaidVisualResponse {
  diagram_type?: unknown;
  mermaid_code?: unknown;
  title?: unknown;
}

export interface GenerateLessonVisualExampleInput {
  generationNotes?: string;
  hasPdfImages: boolean;
  lessonMarkdown: string;
  sectionDescription: string;
  sectionTitle: string;
}

const stripFence = (code: string, language?: string): string => {
  const trimmed = code.trim();
  if (!trimmed.startsWith('```')) {
    if (language && trimmed.toLowerCase().startsWith(`${language.toLowerCase()}\n`)) {
      return trimmed.slice(language.length).trim();
    }
    return trimmed;
  }

  const lines = trimmed.split('\n');
  const openingFence = lines[0] || '';
  const expectedFence = language
    ? new RegExp(`^\\\`\\\`\\\`${language}\\s*$`, 'i')
    : /^```\w*\s*$/i;
  if (!expectedFence.test(openingFence)) {
    return trimmed
      .replace(/^```\w*\s*/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  if (lines.at(-1)?.trim() === '```') {
    return lines.slice(1, -1).join('\n').trim();
  }

  return lines.slice(1).join('\n').replace(/```$/i, '').trim();
};

const sanitizeTitle = (title: unknown, fallback: string): string => {
  if (typeof title !== 'string') {
    return fallback;
  }

  let normalized = '';
  let previousWasSeparator = false;

  for (const rawCharacter of title.toLowerCase()) {
    const isAlphaNumeric =
      (rawCharacter >= 'a' && rawCharacter <= 'z') || (rawCharacter >= '0' && rawCharacter <= '9');
    const isSeparator = rawCharacter === '_' || rawCharacter === ' ' || rawCharacter === '-';

    if (isAlphaNumeric) {
      normalized += rawCharacter;
      previousWasSeparator = false;
      continue;
    }

    if (!isSeparator || previousWasSeparator) {
      continue;
    }

    normalized += '_';
    previousWasSeparator = true;
  }

  normalized = normalized.trim();

  let startIndex = 0;
  while (normalized[startIndex] === '_') {
    startIndex += 1;
  }

  let endIndex = normalized.length;
  while (endIndex > startIndex && normalized[endIndex - 1] === '_') {
    endIndex -= 1;
  }

  const sanitizedTitle = normalized.slice(startIndex, endIndex);

  return sanitizedTitle || fallback;
};

const normalizeLoadingMessages = (messages: unknown): string[] =>
  Array.isArray(messages)
    ? messages.filter((message): message is string => typeof message === 'string').slice(0, 3)
    : [];

const hasFullHtmlDocument = (code: string): boolean =>
  /<!doctype|<html\b|<head\b|<body\b/i.test(code);

const buildVisualPlaceholder = (visual: LessonGeneratedVisual): string =>
  `{{VISUAL_EXAMPLE:${visual.id}|title=${visual.title.replace(/[|}]/g, ' ').trim()}}}`;

const normalizeHeadingTitle = (value: string): string =>
  value
    .replace(/^#{1,6}\s+/, '')
    .replace(/[*_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const getMarkdownHeadingTitles = (markdown: string): string[] =>
  markdown
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^#{1,6}\s+/.test(line))
    .map(line => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean);

const resolvePlannedAnchorHeading = (
  plannedAnchorHeading: unknown,
  availableHeadings: string[]
): string | undefined => {
  if (typeof plannedAnchorHeading !== 'string' || !plannedAnchorHeading.trim()) {
    return undefined;
  }

  const headingByNormalized = new Map(
    availableHeadings.map(heading => [normalizeHeadingTitle(heading), heading])
  );
  return headingByNormalized.get(normalizeHeadingTitle(plannedAnchorHeading));
};

const normalizeSvgVisual = (
  response: SvgVisualResponse,
  id: string
): LessonGeneratedVisual | null => {
  const code = typeof response.svg_code === 'string' ? stripFence(response.svg_code, 'svg') : '';
  if (!/^<svg\b[\s\S]*<\/svg>$/i.test(code) || hasFullHtmlDocument(code)) {
    return null;
  }

  return {
    id,
    title: sanitizeTitle(response.title, 'esempio_visivo'),
    kind: 'svg',
    code,
    loadingMessages: normalizeLoadingMessages(response.loading_messages),
    createdAt: timestampIso(),
  };
};

const normalizeHtmlVisual = (
  response: HtmlVisualResponse,
  id: string
): LessonGeneratedVisual | null => {
  const code =
    typeof response.widget_code === 'string' ? stripFence(response.widget_code, 'html') : '';
  if (
    !code ||
    hasFullHtmlDocument(code) ||
    !/^\s*<style[\s>]/i.test(code) ||
    !/<script[\s>]/i.test(code) ||
    findMissingStaticHtmlElementIds(code).length > 0 ||
    hasUnsafeHtmlElementDereferences(code)
  ) {
    return null;
  }

  return {
    id,
    title: sanitizeTitle(response.title, 'esempio_interattivo'),
    kind: 'html',
    code,
    loadingMessages: normalizeLoadingMessages(response.loading_messages),
    createdAt: timestampIso(),
  };
};

const normalizeMermaidVisual = (
  response: MermaidVisualResponse,
  id: string
): LessonGeneratedVisual | null => {
  const diagramType =
    response.diagram_type === 'erDiagram' || response.diagram_type === 'classDiagram'
      ? response.diagram_type
      : null;
  const code =
    typeof response.mermaid_code === 'string' ? stripFence(response.mermaid_code, 'mermaid') : '';

  if (!diagramType || !code.trim().startsWith(diagramType)) {
    return null;
  }

  return {
    id,
    title: sanitizeTitle(response.title, 'diagramma'),
    kind: 'mermaid',
    code,
    diagramType,
    createdAt: timestampIso(),
  };
};

const getRendererPrompt = (visualType: VisualType): string | null => {
  if (visualType.includes('svg')) {
    return RENDERER_SVG_PROMPT;
  }

  if (visualType === 'interactive_html' || visualType === 'chart_html') {
    return RENDERER_HTML_PROMPT;
  }

  if (visualType === 'mermaid_erd' || visualType === 'mermaid_class') {
    return RENDERER_MERMAID_PROMPT;
  }

  return null;
};

const normalizeRenderedVisual = (
  visualType: VisualType,
  rendererResponse: string,
  id: string
): LessonGeneratedVisual | null => {
  const parsed = parseCleanJson<SvgVisualResponse | HtmlVisualResponse | MermaidVisualResponse>(
    rendererResponse
  );

  if (visualType.includes('svg')) {
    return normalizeSvgVisual(parsed as SvgVisualResponse, id);
  }

  if (visualType === 'interactive_html' || visualType === 'chart_html') {
    return normalizeHtmlVisual(parsed as HtmlVisualResponse, id);
  }

  return normalizeMermaidVisual(parsed as MermaidVisualResponse, id);
};

const buildPlannerRequest = ({
  generationNotes,
  hasPdfImages,
  lessonMarkdown,
  sectionDescription,
  sectionTitle,
}: GenerateLessonVisualExampleInput): string => `Lezione: "${sectionTitle}"
Descrizione: "${sectionDescription}"
Immagini PDF gia integrate: ${hasPdfImages ? 'si' : 'no'}
Note corso: ${generationNotes?.trim() || 'nessuna'}
Lingua target: inferiscila dal testo della lezione e mantienila in ogni testo visibile dell'esempio.
Heading disponibili per il posizionamento:
${
  getMarkdownHeadingTitles(lessonMarkdown)
    .map(heading => `- ${heading}`)
    .join('\n') || '- nessun heading disponibile'
}

Testo lezione:
${lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}`;

export const generateLessonVisualExample = async (
  input: GenerateLessonVisualExampleInput
): Promise<{
  anchorHeading?: string;
  contentSuffix: string;
  visual: LessonGeneratedVisual;
} | null> => {
  const planResponse = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_VISUAL_PLANNER,
        disableModelOverride: true,
        messages: [
          { role: 'system', content: VISUAL_PLANNER_PROMPT },
          { role: 'user', content: buildPlannerRequest(input) },
        ],
        reasoning: MEDIUM_REASONING_CONFIG,
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    1,
    500
  );
  const plan = parseCleanJson<VisualPlan>(planResponse || '{}');
  const visualType = plan.visual_type;
  if (!visualType || visualType === 'none') {
    return null;
  }

  const rendererPrompt = getRendererPrompt(visualType);
  if (!rendererPrompt) {
    return null;
  }

  const rendererMessages: Array<{
    content: string;
    role: 'assistant' | 'system' | 'user';
  }> = [
    { role: 'system' as const, content: rendererPrompt },
    {
      role: 'user' as const,
      content: `Lesson title: ${input.sectionTitle}
Lesson description: ${input.sectionDescription}
Target language: infer it from the lesson excerpt. Every visible label, caption, control, button, axis, state, relation, field name, and explanatory phrase in the generated visual must use that same language.
Planner output:
${JSON.stringify(plan, null, 2)}

Relevant lesson excerpt:
${input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}`,
    },
  ];
  const requestRenderedVisual = (messages: typeof rendererMessages) =>
    retryWithBackoff(
      () =>
        callOpenRouter({
          model: MODEL_VISUAL_RENDERER,
          disableModelOverride: true,
          messages,
          reasoning: MEDIUM_REASONING_CONFIG,
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
      1,
      500
    );
  const rendererResponse = await requestRenderedVisual(rendererMessages);

  let visual = normalizeRenderedVisual(
    visualType,
    rendererResponse || '{}',
    `${VISUAL_ID_PREFIX}001`
  );
  if (!visual) {
    const repairedResponse = await requestRenderedVisual([
      ...rendererMessages,
      { role: 'assistant', content: rendererResponse || '{}' },
      {
        role: 'user',
        content:
          'La bozza precedente non e valida o contiene accessi DOM non sicuri. Rigenerala correggendo ogni riferimento a elementi mancanti: nessun document.getElementById(...) puo essere dereferenziato direttamente e ogni lookup deve gestire null. Restituisci nuovamente solo il JSON richiesto.',
      },
    ]);
    visual = normalizeRenderedVisual(
      visualType,
      repairedResponse || '{}',
      `${VISUAL_ID_PREFIX}001`
    );
  }
  if (!visual) {
    return null;
  }

  return {
    anchorHeading: resolvePlannedAnchorHeading(
      plan.anchor_heading,
      getMarkdownHeadingTitles(input.lessonMarkdown)
    ),
    visual,
    contentSuffix: `\n\n${buildVisualPlaceholder(visual)}`,
  };
};
