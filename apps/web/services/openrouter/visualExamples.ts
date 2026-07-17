import type { LessonGeneratedVisual } from '../../types.ts';
import { timestampIso } from '../../utils/time.ts';
import {
  findMissingStaticHtmlElementIds,
  hasInvalidInlineJavaScript,
  hasUnsafeHtmlElementDereferences,
} from '../../utils/visuals/htmlElementReferences.ts';
import { requestGeneratedImage } from './imageClient.ts';
import {
  callOpenRouter,
  getArtifactVisualReviewSettings,
  LOW_REASONING_CONFIG,
  MEDIUM_REASONING_CONFIG,
  MODEL_VISUAL_PLANNER,
  MODEL_VISUAL_RENDERER,
  parseCleanJson,
  retryWithBackoff,
} from './shared.ts';
import { lintSvg, renderSvgPreview } from './svgReview.ts';
import type { ChatMessage } from './types.ts';

const VISUAL_ID_PREFIX = 'visual-';
const MAX_VISUAL_LESSON_CHARS = 12000;
const MAX_GENERATED_VISUALS_PER_LESSON = 3;
const ARTIFACT_TOKEN_EFFICIENCY_INSTRUCTION = 'BE VERY TOKEN EFFICIENT.';

const buildArtifactSystemPrompt = (prompt: string): string =>
  `${prompt}\n\n${ARTIFACT_TOKEN_EFFICIENCY_INSTRUCTION}`;

const VISUAL_PLANNER_PROMPT = `SYSTEM:
Sei un pianificatore pedagogico di esempi visivi per Nous Reader.
Dato il testo finale di una lezione, decidi quali rappresentazioni visive generate servono davvero.

Scegli esattamente un tipo per ciascun piano:
- illustrative_image: illustrazione raster per realta fisica o stilizzata, forma dimensionale, luce, ombreggiatura, volume, prospettiva, materiali, superfici, texture, anatomia, gesti, oggetti, scene, luoghi e fenomeni. Puo anche avere una composizione diagrammatica con frecce ed etichette quando queste aiutano a leggere l'immagine.
- flowchart_svg: solo schema informativo semplice di processo, pipeline, sequenza o albero decisionale.
- structural_svg: solo schema informativo semplice di contenimento, architettura, strati o parti dentro un sistema.
- interactive_html: variabile manipolabile o esplorazione passo-passo.
- chart_html: dati quantitativi, confronti numerici, distribuzioni, trend.
- mermaid_erd: solo schema entita-relazioni.
- mermaid_class: solo classi, ereditarieta, interfacce, associazioni.
- none: nessuna visuale utile, oppure la lezione e gia sufficientemente visuale.

Regole:
- Per una richiesta esplicita pianifica un solo artefatto. Per la generazione automatica pianifica normalmente zero o un artefatto, due solo se rispondono a domande pedagogiche diverse e complementari, tre solo se sono tutti indispensabili. Mai produrre varianti estetiche dello stesso contenuto.
- La varieta dei formati non e mai un obiettivo o un vincolo. Scegli ogni formato soltanto in base al contenuto che deve insegnare: due o tre immagini raster sono corrette quando sono la soluzione pedagogica migliore. Non inserire SVG, HTML o Mermaid per diversificare un insieme di artefatti.
- Ogni piano deve essere indipendente e generabile separatamente. Se servono sia "che aspetto ha?" sia "come funziona?", scegli separatamente il formato piu adatto a ciascuna domanda, anche ripetendo illustrative_image.
- La richiesta esplicita dell'utente sul formato e autoritativa. Se chiede un'immagine o un'illustrazione, scegli illustrative_image. Se chiede un SVG, usalo soltanto se il contenuto e davvero uno schema strutturale o un flusso astratto; altrimenti non fingere che un disegno sia uno schema. Non sostituire mai un'immagine richiesta con SVG, HTML o Mermaid.
- SVG significa esclusivamente riepilogo schematico informativo semplice, composto da pochi nodi, box, linee, frecce, etichette e forme geometriche che rappresentano relazioni astratte. Non usarlo per raffigurare realta fisica o stilizzata, forma dimensionale, luce, ombreggiatura, volume, prospettiva, materiali, superfici, texture, illustrazioni o qualunque scena visivamente complessa. In questi casi scegli illustrative_image, anche quando la composizione utile include etichette, frecce o una struttura da schema.
- Inferisci la lingua dal testo finale della lezione. La visuale deve usare la stessa lingua della lezione.
- Preferisci una visuale quando mancano immagini del PDF e il concetto contiene relazioni, flussi, struttura o variabili.
- Non generare visuali decorative. La visuale deve insegnare qualcosa che il testo da solo rende piu faticoso.
- Usa illustrative_image quando aspetto, struttura visiva, texture, luce, volume, spazio o scena sono informazione utile, mai per decorazione. Usa i tipi schematici solo quando il contenuto e davvero semplice, astratto e informativo; un processo o una struttura fisica non diventano automaticamente un SVG.
- Se "Immagini PDF gia integrate" e "si", trattale come materiale visivo primario. Aggiungi una visuale generata solo se risponde a una domanda pedagogica distinta che le immagini della fonte non coprono; altrimenti non pianificare nulla.
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
- Segui esattamente il formato di output richiesto in fondo.`;

const SINGLE_VISUAL_PLANNER_OUTPUT_INSTRUCTION = `Rispondi SOLO con JSON:
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

const MULTI_VISUAL_PLANNER_OUTPUT_INSTRUCTION = `Per la generazione automatica della lezione rispondi SOLO con JSON:
{
  "plans": [
    {
      "visual_type": "...",
      "concept": "soggetto distinto e autosufficiente",
      "pedagogical_goal": "build_intuition | show_process | show_structure | enable_exploration | show_data",
      "anchor_heading": "heading esatto della lezione oppure null",
      "interaction_level": "none | low | high",
      "complexity": "simple | moderate | complex",
      "coverage": "all_elements | single_complex | complete_synthesis | none",
      "coverage_rationale": "breve spiegazione",
      "factual_requirements": ["elementi visivi che devono essere corretti e presenti"],
      "visual_direction": "composizione e punto di vista utili allo scopo didattico",
      "reason": "valore pedagogico distinto"
    }
  ]
}
L'array contiene da zero a ${MAX_GENERATED_VISUALS_PER_LESSON} piani. Non usare visual_type none dentro l'array: se non serve nulla restituisci plans vuoto.`;

const RENDERER_SVG_PROMPT = `SYSTEM:
Sei un generatore esperto di schemi SVG didattici per Nous Reader.
Genera un singolo schema SVG auto-contenuto basato sul concept fornito.

Output SOLO JSON:
{
  "title": "snake_case_title",
  "loading_messages": ["uno", "due", "tre"],
  "svg_code": "<svg ...>...</svg>"
}

Regole SVG obbligatorie:
- SVG e riservato a riepiloghi schematici informativi semplici: pochi nodi, box, linee, frecce ed etichette per relazioni, gerarchie, contenimento e architetture astratte. Sono vietati realta fisica o stilizzata, forma dimensionale, luce, ombreggiatura, volume, prospettiva, materiali, superfici, texture, illustrazioni, forme organiche, persone, anatomia, gesti, oggetti raffigurati e scene. Non approssimare questi soggetti con box, omini stilizzati o disegni geometrici: richiedono un'immagine raster.
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
- Niente shadow, blur, glow, filter, emoji, HTML o commenti.
- Usa al massimo due rampe colore; c-gray come default, c-amber/c-red/c-green solo semanticamente.
- Altezza viewBox = ultimo elemento + 40px.
- **Larghezza box dal testo:** prima di scrivere un <rect>, trova la label piu lunga tra titolo e sottotitolo. A 14px weight-500: ~8px/char; a 12px: ~7px/char. Formula: rect_width = max(titolo_chars × 8, sottotitolo_chars × 7) + 24. Esempio: sottotitolo di 20 char → min 164px. Se il testo e piu lungo del box, abbrevia il testo — non sperare che vada bene.
- **Altezze canoniche:** single-line box = 44px; two-line box (titolo + sottotitolo) = 56px con 22px di distanza tra le due righe. y del titolo = cy - 9; y del sottotitolo = cy + 13 (dove cy e il centro verticale del box).
- **Spaziatura:** padding interno box ≥ 24px; gap minimo tra box adiacenti = 60px; gap freccia-bordo ≥ 10px.
- **Tier packing:** prima di posizionare una riga di N box, verifica che N × box_width + (N-1) × gap ≤ 600. Se non entra, riduci la larghezza dei box oppure distribuisci su 2 righe. Mai stimare a occhio.
- **Frecce che deviano:** se il percorso diretto di una freccia attraversa un box non collegato, usa un L-bend: <path d="M x1 y1 L x1 ymid L x2 ymid L x2 y2" fill="none" class="arr" marker-end="url(#arrow)"/>. Scegli ymid in uno spazio libero tra i box.
- **Uso c-{ramp}:** wrappa sempre rect + text in un <g class="c-*"> — cosi sia il fill del box sia il colore del testo vengono applicati. Se metti c-* direttamente sul <rect> il testo sibling non prende il colore. Non annidare un <g> dentro un <g class="c-*"> (le shape diventano nipoti e il CSS non le raggiunge).
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
- **Controlli e risultato insieme:** input, slider, pulsanti e il risultato che modificano devono stare nello stesso pannello o nella stessa riga logica, senza costringere a scorrere per vedere l'effetto dell'interazione.
- **Griglia compatta:** per piu controlli o valori usa una griglia compatta e responsive, evitando una lunga colonna di schede a tutta larghezza.
- **Altezza contenuta:** progetta il widget per mostrare interazione e risultato nell'altezza minima utile. Evita spazi vuoti, sezioni decorative e contenitori con min-height arbitrari.
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
  | 'illustrative_image'
  | 'interactive_html'
  | 'mermaid_class'
  | 'mermaid_erd'
  | 'none'
  | 'structural_svg';

type GeneratedVisualType = Exclude<VisualType, 'none'>;

interface VisualPlan {
  anchor_heading?: null | string;
  complexity?: 'simple' | 'moderate' | 'complex';
  concept?: string;
  coverage?: 'all_elements' | 'single_complex' | 'complete_synthesis' | 'none';
  coverage_rationale?: string;
  factual_requirements?: string[];
  interaction_level?: 'none' | 'low' | 'high';
  pedagogical_goal?: string;
  reason?: string;
  visual_direction?: string;
  visual_type?: VisualType;
}

interface VisualPlansResponse {
  plans?: VisualPlan[];
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

const VISUAL_PLAN_RESPONSE_SCHEMA = {
  name: 'visual_plan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      anchor_heading: { type: ['string', 'null'] },
      complexity: { type: 'string', enum: ['simple', 'moderate', 'complex'] },
      concept: { type: 'string' },
      coverage: {
        type: 'string',
        enum: ['all_elements', 'single_complex', 'complete_synthesis', 'none'],
      },
      coverage_rationale: { type: 'string' },
      interaction_level: { type: 'string', enum: ['none', 'low', 'high'] },
      pedagogical_goal: { type: 'string' },
      reason: { type: 'string' },
      visual_type: {
        type: 'string',
        enum: [
          'chart_html',
          'flowchart_svg',
          'illustrative_image',
          'interactive_html',
          'mermaid_class',
          'mermaid_erd',
          'none',
          'structural_svg',
        ],
      },
    },
    required: [
      'anchor_heading',
      'complexity',
      'concept',
      'coverage',
      'coverage_rationale',
      'interaction_level',
      'pedagogical_goal',
      'reason',
      'visual_type',
    ],
  },
} as const;

const VISUAL_PLAN_ITEM_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    anchor_heading: { type: ['string', 'null'] },
    complexity: { type: 'string', enum: ['simple', 'moderate', 'complex'] },
    concept: { type: 'string' },
    coverage: {
      type: 'string',
      enum: ['all_elements', 'single_complex', 'complete_synthesis', 'none'],
    },
    coverage_rationale: { type: 'string' },
    factual_requirements: { type: 'array', items: { type: 'string' } },
    interaction_level: { type: 'string', enum: ['none', 'low', 'high'] },
    pedagogical_goal: { type: 'string' },
    reason: { type: 'string' },
    visual_direction: { type: 'string' },
    visual_type: {
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
    'anchor_heading',
    'complexity',
    'concept',
    'coverage',
    'coverage_rationale',
    'factual_requirements',
    'interaction_level',
    'pedagogical_goal',
    'reason',
    'visual_direction',
    'visual_type',
  ],
} as const;

const MULTI_VISUAL_PLAN_RESPONSE_SCHEMA = {
  name: 'lesson_visual_plans',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      plans: {
        type: 'array',
        maxItems: MAX_GENERATED_VISUALS_PER_LESSON,
        items: VISUAL_PLAN_ITEM_RESPONSE_SCHEMA,
      },
    },
    required: ['plans'],
  },
} as const;
const SVG_VISUAL_RESPONSE_SCHEMA = {
  name: 'svg_visual',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      loading_messages: { type: 'array', items: { type: 'string' } },
      svg_code: { type: 'string' },
    },
    required: ['title', 'loading_messages', 'svg_code'],
  },
} as const;
const HTML_VISUAL_RESPONSE_SCHEMA = {
  name: 'html_visual',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      loading_messages: { type: 'array', items: { type: 'string' } },
      widget_code: { type: 'string' },
    },
    required: ['title', 'loading_messages', 'widget_code'],
  },
} as const;
const MERMAID_VISUAL_RESPONSE_SCHEMA = {
  name: 'mermaid_visual',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      diagram_type: { type: 'string', enum: ['erDiagram', 'classDiagram'] },
      mermaid_code: { type: 'string' },
    },
    required: ['title', 'diagram_type', 'mermaid_code'],
  },
} as const;

export interface GenerateLessonVisualExampleInput {
  generationNotes?: string;
  hasPdfImages: boolean;
  lessonMarkdown: string;
  sectionDescription: string;
  sectionTitle: string;
  visualTypeHint?: GeneratedVisualType;
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
    hasInvalidInlineJavaScript(code) ||
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

const getRendererResponseSchema = (visualType: VisualType) => {
  if (visualType.includes('svg')) {
    return SVG_VISUAL_RESPONSE_SCHEMA;
  }
  if (visualType === 'interactive_html' || visualType === 'chart_html') {
    return HTML_VISUAL_RESPONSE_SCHEMA;
  }
  return MERMAID_VISUAL_RESPONSE_SCHEMA;
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

const PEDAGOGICAL_GOAL_BY_VISUAL_TYPE: Record<GeneratedVisualType, string> = {
  chart_html: 'show_data',
  flowchart_svg: 'show_process',
  illustrative_image: 'build_intuition',
  interactive_html: 'enable_exploration',
  mermaid_class: 'show_structure',
  mermaid_erd: 'show_structure',
  structural_svg: 'show_structure',
};

const buildExplicitVisualPlan = (
  input: GenerateLessonVisualExampleInput,
  visualType: GeneratedVisualType
): VisualPlan => ({
  visual_type: visualType,
  concept: input.sectionDescription,
  pedagogical_goal: PEDAGOGICAL_GOAL_BY_VISUAL_TYPE[visualType],
  interaction_level:
    visualType === 'interactive_html' ? 'high' : visualType === 'chart_html' ? 'low' : 'none',
  complexity: 'simple',
  coverage: 'complete_synthesis',
  coverage_rationale: 'Il formato visuale è stato richiesto esplicitamente dall’utente.',
  reason: 'Il tipo è inequivocabile, quindi il planner LLM non è necessario.',
});

const getImageSubject = (plan: VisualPlan, input: GenerateLessonVisualExampleInput): string => {
  const plannedConcept = typeof plan.concept === 'string' ? plan.concept.trim() : '';
  const subject = plannedConcept || input.sectionDescription.trim() || input.sectionTitle;
  return subject.split(/\n+\s*Richiesta:/i)[0]?.trim() || input.sectionTitle;
};

const buildImageGenerationPrompt = (
  plan: VisualPlan,
  input: GenerateLessonVisualExampleInput
): string => {
  const subject = getImageSubject(plan, input);
  const factualRequirements = plan.factual_requirements?.filter(Boolean).join('\n- ') || subject;
  const visualDirection =
    plan.visual_direction?.trim() ||
    'Composizione orizzontale chiara, soggetto principale immediatamente riconoscibile e gerarchia visiva semplice.';

  return [
    'SCOPO',
    `Crea una singola immagine pedagogica accurata per aiutare a comprendere: ${plan.pedagogical_goal || 'il concetto centrale'}.`,
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
    '',
    'VINCOLI',
    '- Usa testo, numeri, etichette o frecce solo quando sono necessari per leggere il contenuto pedagogico; mantienili brevi, corretti e nella lingua della lezione.',
    '- Nessun logo, watermark, didascalia narrativa o testo decorativo.',
    '- Nessuna interfaccia grafica, cornice decorativa o elemento estraneo.',
    '- Non trasformare il soggetto in un diagramma di blocchi: questa richiesta è raster perché il suo aspetto concreto o la sua complessità spaziale sono informativi.',
    '',
    `CONTESTO FATTUALE DELLA LEZIONE\n${input.lessonMarkdown.slice(0, 4_000)}`,
  ].join('\n');
};

const generateImageVisual = async (
  plan: VisualPlan,
  input: GenerateLessonVisualExampleInput,
  visualId: string
): Promise<LessonGeneratedVisual> => {
  const subject = getImageSubject(plan, input);
  const image = await requestGeneratedImage(buildImageGenerationPrompt(plan, input));

  return {
    id: visualId,
    title: sanitizeTitle(subject, 'illustrazione_pedagogica'),
    kind: 'image',
    code: image.dataUrl,
    altText: subject,
    mediaType: image.mediaType,
    createdAt: timestampIso(),
  };
};

const buildGeneratedImageResult = (
  input: GenerateLessonVisualExampleInput,
  plan: VisualPlan,
  visual: LessonGeneratedVisual
) => ({
  anchorHeading: resolvePlannedAnchorHeading(
    plan.anchor_heading,
    getMarkdownHeadingTitles(input.lessonMarkdown)
  ),
  visual,
  contentSuffix: `\n\n${buildVisualPlaceholder(visual)}`,
});
const requestVisualPlan = async (input: GenerateLessonVisualExampleInput): Promise<VisualPlan> => {
  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_VISUAL_PLANNER,
        modelSlot: 'artifact',
        messages: [
          {
            role: 'system',
            content: buildArtifactSystemPrompt(
              `${VISUAL_PLANNER_PROMPT}\n\n${SINGLE_VISUAL_PLANNER_OUTPUT_INSTRUCTION}`
            ),
          },
          { role: 'user', content: buildPlannerRequest(input) },
        ],
        reasoning: LOW_REASONING_CONFIG,
        response_format: { type: 'json_schema', json_schema: VISUAL_PLAN_RESPONSE_SCHEMA },
        temperature: 0.2,
      }),
    1,
    500
  );

  return parseCleanJson<VisualPlan>(response || '{}');
};

const requestVisualPlans = async (
  input: GenerateLessonVisualExampleInput
): Promise<VisualPlan[]> => {
  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_VISUAL_PLANNER,
        modelSlot: 'artifact',
        messages: [
          {
            role: 'system',
            content: buildArtifactSystemPrompt(
              `${VISUAL_PLANNER_PROMPT}\n\n${MULTI_VISUAL_PLANNER_OUTPUT_INSTRUCTION}`
            ),
          },
          { role: 'user', content: buildPlannerRequest(input) },
        ],
        reasoning: LOW_REASONING_CONFIG,
        response_format: { type: 'json_schema', json_schema: MULTI_VISUAL_PLAN_RESPONSE_SCHEMA },
        temperature: 0.2,
      }),
    1,
    500
  );
  const parsed = parseCleanJson<VisualPlansResponse>(response || '{}');
  return Array.isArray(parsed.plans) ? parsed.plans.slice(0, MAX_GENERATED_VISUALS_PER_LESSON) : [];
};

export interface GeneratedLessonVisualResult {
  anchorHeading?: string;
  contentSuffix: string;
  visual: LessonGeneratedVisual;
}

const generateVisualFromPlan = async (
  input: GenerateLessonVisualExampleInput,
  plan: VisualPlan,
  index: number
): Promise<GeneratedLessonVisualResult | null> => {
  const visualType = plan.visual_type;
  if (!visualType || visualType === 'none') {
    return null;
  }
  const visualId = `${VISUAL_ID_PREFIX}${String(index + 1).padStart(3, '0')}`;

  if (visualType === 'illustrative_image') {
    const imageVisual = await generateImageVisual(plan, input, visualId);
    return buildGeneratedImageResult(input, plan, imageVisual);
  }

  const rendererPrompt = getRendererPrompt(visualType);
  if (!rendererPrompt) {
    return null;
  }

  const rendererMessages: ChatMessage[] = [
    { role: 'system' as const, content: buildArtifactSystemPrompt(rendererPrompt) },
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
  const rendererModelSlot =
    visualType === 'interactive_html' || visualType === 'chart_html'
      ? 'artifactInteractive'
      : 'artifact';
  const requestRenderedVisual = (messages: typeof rendererMessages) =>
    retryWithBackoff(
      () =>
        callOpenRouter({
          model: MODEL_VISUAL_RENDERER,
          modelSlot: rendererModelSlot,
          allowTextOnlyImageFallback: true,
          messages,
          reasoning: MEDIUM_REASONING_CONFIG,
          response_format: {
            type: 'json_schema',
            json_schema: getRendererResponseSchema(visualType),
          },
          temperature: 0.2,
        }),
      1,
      500
    );
  const rendererResponse = await requestRenderedVisual(rendererMessages);

  let visual = normalizeRenderedVisual(visualType, rendererResponse || '{}', visualId);
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
    visual = normalizeRenderedVisual(visualType, repairedResponse || '{}', visualId);
  }
  if (!visual) {
    return null;
  }

  if (visual.kind === 'svg') {
    const reviewSettings = await getArtifactVisualReviewSettings();
    for (let round = 0; reviewSettings.enabled && round < reviewSettings.maxRounds; round += 1) {
      const lintIssues = lintSvg(visual.code);
      if (lintIssues.length === 0) {
        break;
      }
      const preview = await renderSvgPreview(visual.code);
      const reviewedResponse = await requestRenderedVisual([
        ...rendererMessages,
        { role: 'assistant', content: JSON.stringify({ svg_code: visual.code }) },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: preview } },
            {
              type: 'text',
              text: `Questa e la versione renderizzata della bozza SVG. Esegui un round di revisione multimodale: correggi problemi visivi reali di leggibilita, sovrapposizione, spaziatura, contrasto e bordi, mantenendo contenuto e intento pedagogico. Il linter seguente e euristico: usalo come indizio, non come verita assoluta.\n\n${lintIssues.map(issue => `- ${issue}`).join('\n')}\n\nRestituisci il JSON completo richiesto con l'SVG revisionato.`,
            },
          ],
        },
      ]);
      const reviewedVisual = normalizeRenderedVisual(
        visualType,
        reviewedResponse || '{}',
        visualId
      );
      if (!reviewedVisual || reviewedVisual.kind !== 'svg') {
        break;
      }
      visual = reviewedVisual;
    }
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

export const generateLessonVisualExample = async (
  input: GenerateLessonVisualExampleInput
): Promise<GeneratedLessonVisualResult | null> => {
  const plan = input.visualTypeHint
    ? buildExplicitVisualPlan(input, input.visualTypeHint)
    : await requestVisualPlan(input);
  return generateVisualFromPlan(input, plan, 0);
};

export const generateLessonVisualExamples = async (
  input: GenerateLessonVisualExampleInput
): Promise<GeneratedLessonVisualResult[]> => {
  const plans = await requestVisualPlans(input);
  const settledResults = await Promise.allSettled(
    plans.map((plan, index) => generateVisualFromPlan(input, plan, index))
  );

  const generatedVisuals = settledResults.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value ? [result.value] : [];
    }
    console.warn('[Nous][Lesson] Generated visual worker failed.', {
      index,
      error: result.reason,
    });
    return [];
  });
  if (plans.length > 0 && generatedVisuals.length === 0) {
    throw new Error('Nessun worker visuale ha prodotto un artefatto valido.');
  }
  return generatedVisuals;
};
