import type {
  LessonGeneratedVisual,
  LessonVisualPlan,
  LessonVisualPlanningDecision,
  LessonVisualPlanningPass,
} from '../../types.ts';
import { timestampIso } from '../../utils/time.ts';
import {
  findMissingStaticHtmlElementIds,
  hasInvalidInlineJavaScript,
  hasUnsafeHtmlElementDereferences,
} from '../../utils/visuals/htmlElementReferences.ts';
import { renderHtmlPreview } from '../../utils/visuals/htmlPreview.ts';
import { pushNousDebugTrace } from '../core/debugTrace.ts';
import { getErrorDiagnostic } from '../core/errorMessage.ts';
import { requestGeneratedImage } from './imageClient.ts';
import {
  INTERNAL_FAST_TASK_INSTRUCTION,
  INTERNAL_REASONING_EFFICIENCY_INSTRUCTION,
} from './prompts.ts';
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
const GENERATED_IMAGE_PLACEHOLDER_PATTERN = /\{\{GENERATED_IMAGE:([a-z][a-z0-9_-]{0,63})\}\}/g;
const MAX_VISUAL_LESSON_CHARS = 12000;
export const MAX_GENERATED_VISUALS_PER_LESSON = 3;
export const INTERACTIVE_VISUAL_VALUE_RULE =
  'Tratta interactive_html come un formato costoso: usalo solo quando l’utente deve esplorare, modificare o confrontare stati e questa interazione produce una comprensione importante che testo, video o una o due immagini statiche non possono offrire altrettanto bene. Non usarlo per dimostrazioni cosmetiche, controlli banali o esempi statici travestiti da interattivi; se l’interazione non è essenziale, scegli il formato più semplice.';
export const VISUAL_FORMAT_SELECTION_RULE =
  'Imposta requiresDepiction=true quando lo studente deve vedere l’aspetto di un oggetto, stato, scena, risultato grafico o trasformazione visiva, inclusi passaggi che mostrano come cambia un soggetto. In quel caso usa illustrative_image: un processo visivo non è un flowchart. SVG è consentito soltanto con requiresDepiction=false per relazioni astratte fra brevi etichette testuali, box generici e frecce; i nodi non possono contenere disegni, sagome, pixel art, oggetti, scene o esempi del risultato. Se la visuale deve mostrare esempi programmabili — inclusi pixel art, shader semplici, pattern generativi, confronti di filtri o effetti — usa interactive_html anche quando non richiede controlli; il formato può essere una dimostrazione HTML/JavaScript passiva. Usa interactive_html con controlli solo quando la manipolazione aggiunge valore didattico essenziale. Per una visuale programmabile passiva, imposta interaction_justification=null.';
export const NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT = `CONTRATTO VISIVO NOUS:
- Base calda e neutra: avorio/carta, pietra e antracite; superfici sobrie, bordi leggeri, ombre minime e tipografia editoriale.
- Usa un solo accento coerente col soggetto, scelto tra rosso smorzato, borgogna, verde terroso e rame/arancio smorzato.
- Vietate palette SaaS blu/viola, neon, glow, gradienti decorativi e ombre sovradimensionate, salvo colore semanticamente necessario al contenuto.
- Il medium segue lo scopo pedagogico: illustrazioni 2D editoriali sono pienamente ammesse; non usare oggetti o render 3D come default decorativo.
- In HTML e SVG usa le variabili CSS dell'host (--bg-paper, --bg-surface, --ink-primary, --ink-secondary, --accent, --border-subtle, --border-strong) invece di colori tema hard-coded e mantieni leggibili tema chiaro e scuro.`;
const GENERATED_IMAGE_PREVIEW_DATA_URL =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 9%22%3E%3Crect width=%2216%22 height=%229%22 fill=%22%23eeeae4%22/%3E%3C/svg%3E';

const reportVisualWorkerFailure = ({
  error,
  index,
  plan,
  slotId,
}: {
  error: unknown;
  index: number;
  plan: VisualPlan;
  slotId?: string;
}) => {
  const diagnostic = {
    concept: plan.concept,
    error: getErrorDiagnostic(error),
    index,
    phase: 'visual-artifact-generation',
    ...(slotId ? { slotId } : {}),
    visualType: plan.visual_type,
  };
  console.warn('[Nous][Lesson] Visual worker failed.', JSON.stringify(diagnostic));
  pushNousDebugTrace('lesson:visual-worker-failed', diagnostic);
};

const buildArtifactSystemPrompt = (prompt: string, isVerification = false): string =>
  `${prompt}\n\n${NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT}\n\n${
    isVerification ? INTERNAL_REASONING_EFFICIENCY_INSTRUCTION : INTERNAL_FAST_TASK_INSTRUCTION
  }`;

const VISUAL_PLANNER_PROMPT = `SYSTEM:
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
- ${INTERACTIVE_VISUAL_VALUE_RULE}
- Per una richiesta esplicita pianifica un solo artefatto. Per la generazione automatica pianifica normalmente zero o un artefatto, due solo se rispondono a domande pedagogiche diverse e complementari, tre solo se sono tutti indispensabili. Mai produrre varianti estetiche dello stesso contenuto.
- La varieta dei formati non e mai un obiettivo o un vincolo. Scegli ogni formato soltanto in base al contenuto che deve insegnare: due o tre immagini raster sono corrette quando sono la soluzione pedagogica migliore. Non inserire SVG, HTML o Mermaid per diversificare un insieme di artefatti.
- **Decisione obbligatoria, in quest'ordine.** (1) Se lo studente deve vedere l'aspetto di un oggetto, stato, scena, risultato grafico o trasformazione visiva, imposta "requires_depiction": true e scegli illustrative_image oppure un video pertinente. (2) Se una regola o simulazione verificabile deve essere manipolata dallo studente, scegli interactive_html. (3) Se servono dati quantitativi, scegli chart_html. (4) Scegli SVG soltanto per relazioni astratte fra etichette testuali: nodi, box e frecce generici, senza raffigurare oggetti o risultati visivi. (5) Altrimenti scegli none.
- "requires_depiction" e true anche quando una sequenza mostra come cambia visivamente un soggetto a ogni passaggio. Un processo visivo non diventa un flowchart: se i nodi dovrebbero contenere disegni, sagome, pixel art, icone illustrative, scene o esempi del risultato, SVG e vietato.
- interactive_html e valido soltanto quando l'interazione aggiunge valore essenziale e la grafica deriva da una regola o algoritmo verificabile. Non disegnare a mano scene, oggetti complessi o pixel art; per asset artistici usa immagini generate.
- Non simulare immagini con ASCII art, testo monospace, celle, coordinate, box geometrici o SVG. Se l'aspetto concreto conta, usa illustrative_image.
- Inferisci la lingua dal testo finale della lezione. La visuale deve usare la stessa lingua della lezione.
- Non generare visuali decorative. La visuale deve insegnare qualcosa che il testo da solo rende piu faticoso.
- Se "Immagini PDF gia integrate" e "si", trattale come materiale visivo primario. Aggiungi una visuale generata solo se risponde a una domanda pedagogica distinta che le immagini della fonte non coprono; altrimenti non pianificare nulla.
- Il posizionamento e parte della scelta pedagogica. Se generi una visuale, scegli in "anchor_heading" il heading ESATTO sotto cui il testo usa o introduce quel concetto. Usa null solo per visuali davvero conclusive.
- In "anchor_excerpt" copia un breve estratto ESATTO dell'ultimo paragrafo che lo studente deve leggere prima della visuale. Questo estratto decide la posizione tra i paragrafi; il codice non la reinterpretara. Usa null solo se non esiste un punto locale sensato.
- **Un piano, una sezione locale.** Il contenuto della visuale deve derivare soltanto dalla sezione identificata da "anchor_heading" e dal suo testo, fino al heading successivo. Non anticipare concetti introdotti in sezioni successive e non fondere argomenti lontani solo per riempire il widget. Se il valore pedagogico nasce da un concetto successivo, usa il heading successivo corretto oppure crea un piano separato.
- **Comprensibile senza decifrazione.** Lo studente deve capire in pochi secondi cosa sta guardando e perche. Usa soltanto termini naturali gia introdotti nel testo vicino oppure definizioni immediatamente comprensibili. Vietati gergo inventato, etichette esoteriche, formule nominali ambigue e controlli il cui effetto non sia osservabile. Se il concetto richiede molte spiegazioni dentro la visuale per avere senso, semplificalo o scegli none.
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
  "requires_depiction": true | false,
  "concept": "una frase sul soggetto visuale",
  "pedagogical_goal": "build_intuition | show_process | show_structure | enable_exploration | show_data",
  "anchor_heading": "heading esatto della lezione oppure null",
  "anchor_excerpt": "breve estratto testuale esatto dopo cui inserire la visuale oppure null",
  "interaction_level": "none | low | high",
  "complexity": "simple | moderate | complex",
  "coverage": "all_elements | single_complex | complete_synthesis | none",
  "coverage_rationale": "breve spiegazione: perche la visuale copre tutti gli elementi, perche ne rappresenta solo uno, o perche nessuna visuale",
  "reason": "una frase sul valore pedagogico della scelta"
}`;

const MULTI_VISUAL_PLANNER_OUTPUT_INSTRUCTION = `Per la generazione automatica della lezione rispondi SOLO con JSON:
{
  "rationale": "motivazione sintetica della decisione complessiva, obbligatoria anche quando plans e vuoto",
  "plans": [
    {
      "visual_type": "...",
      "requires_depiction": true | false,
      "concept": "soggetto distinto e autosufficiente",
      "pedagogical_goal": "build_intuition | show_process | show_structure | enable_exploration | show_data",
      "anchor_heading": "heading esatto della lezione oppure null",
      "anchor_excerpt": "breve estratto testuale esatto dopo cui inserire la visuale oppure null",
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

const VISUAL_PLAN_REVIEW_INSTRUCTION = `Sei il revisore finale della pianificazione visuale.
Controlla la decisione iniziale contro l'intera lezione e correggila quando serve.
Valuta in particolare se l'assenza di visuali lascia senza supporto concetti spaziali, fisici, visivi, comparativi o sequenziali, senza forzare artefatti decorativi o poco pertinenti.
Rifiuta o riposiziona ogni piano che anticipa contenuti di un heading successivo, mescola sezioni diverse o usa un anchor_heading il cui testo locale non spiega direttamente cio che la visuale mostra.
Rifiuta o semplifica ogni piano che richiederebbe etichette oscure, gergo inventato o controlli non autoesplicativi. La visuale deve essere leggibile in pochi secondi usando il lessico naturale della lezione.
Puoi aggiungere, rimuovere, sostituire o riposizionare piani. Non applicare regole meccaniche o keyword: giudica il valore pedagogico concreto.
Restituisci una motivazione sintetica e la decisione finale nello stesso formato JSON richiesto al pianificatore.`;

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
- Le tue capacita di disegnare a mano asset grafici sono quelle di un bambino di seconda elementare non particolarmente dotato. Se quel livello non sarebbe accettabile, non tentare di rappresentare il soggetto in SVG: questo renderer deve produrre soltanto schemi astratti semplici e deterministici.
- **Copertura completa.** Se il planner ha indicato "coverage": "all_elements", la visuale SVG deve rappresentare TUTTI gli elementi dell'insieme in un unico grafico. Non puoi sceglierne solo uno. Usa layout a griglia o a colonne per distribuirli bilanciatamente.
- Tutto il testo visibile dentro l'SVG deve essere nella stessa lingua della lezione fornita. Non tradurre in inglese se la lezione non e in inglese.
- Usa soltanto termini naturali gia presenti nel testo locale della lezione. Ogni etichetta deve indicare senza ambiguita un'entita, uno stato o una relazione visibile; non inventare gergo, categorie o sintesi che il testo vicino non introduce.
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

const RENDERER_HTML_PROMPT = String.raw`SYSTEM:
Sei un generatore esperto di visuali programmate HTML per Nous Reader.
Genera un frammento HTML auto-contenuto che insegna tramite una visualizzazione prodotta dal browser. Può avere controlli quando aiutano, oppure essere una dimostrazione passiva e animata o statica.

Output SOLO JSON:
{
  "title": "snake_case_title",
  "loading_messages": ["uno", "due", "tre"],
  "widget_code": "<style>...</style>\n...HTML...\n<script>...</script>",
  "image_requests": [
    {
      "id": "asset-id-univoco",
      "prompt": "descrizione autonoma e precisa dell'immagine da generare",
      "alt": "testo alternativo nella lingua della lezione"
    }
  ]
}

Regole:
- **Copertura completa.** Se il planner ha indicato "coverage": "all_elements", il widget deve rappresentare TUTTI gli elementi dell'insieme, non solo uno. Usa schede, stepper, pannelli o layout a griglia per distribuirli.
- Tutto il testo visibile nel widget deve essere nella stessa lingua della lezione fornita. Non tradurre in inglese se la lezione non e in inglese.
- Il widget deve spiegarsi in pochi secondi. Titoli, label, badge e controlli usano soltanto termini naturali gia introdotti nel testo locale della lezione; non inventare gergo o descrizioni astratte. Ogni controllo deve dichiarare un effetto osservabile e produrre davvero quell'effetto.
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
- Usa HTML/CSS/JavaScript per ciò che è naturalmente programmabile: griglie di pixel/pixel art, pattern generativi, confronti visivi CSS, simulazioni, stati, trasformazioni e shader semplici compatibili con il browser. Non renderizzare ASCII art, mosaici di caratteri o pseudo-pixel con testo monospace.
- Ragiona come programmatore, non come illustratore: il JavaScript deve generare la grafica da una legge o procedura verificabile. Per un bordo pixel, crea una silhouette elementare e calcola il bordo dai vicini; per un pattern, calcola ogni elemento dalla formula. Non codificare a mano illustrazioni, modelli 3D o pixel art complessa come array di coordinate/celle/colori. Se il soggetto richiede giudizio artistico o comprensione spaziale reale, il formato corretto è illustrative_image, non HTML.
- Le tue capacita di disegnare a mano asset grafici nel codice sono quelle di un bambino di seconda elementare non particolarmente dotato. Applica questo test letteralmente: se quel risultato non sarebbe accettabile, non disegnarlo con coordinate, CSS, celle, canvas o SVG improvvisati.
- Quando il widget ha davvero bisogno di asset artistici, usa image_requests. Inserisci ogni asset nel widget esclusivamente come <img src="{{GENERATED_IMAGE:asset-id-univoco}}" alt="...">; la pipeline generera le immagini in parallelo e sostituira i placeholder prima del salvataggio.
- Ogni placeholder deve avere una image_request con lo stesso id e ogni image_request deve essere usata nel widget. Gli id usano solo minuscole, numeri, trattini e underscore e iniziano con una lettera.
- I prompt delle immagini devono essere autonomi, concreti e coerenti tra loro quando mostrano varianti o confronti. Non usare riferimenti vaghi come "come sopra".
- Fai economia: non esiste un limite numerico artificiale, ma ogni richiesta costa tempo e denaro. Richiedi soltanto le immagini indispensabili; se una sola immagine composita comunica bene il concetto, preferiscila.
- Se non servono immagini generate, restituisci image_requests come array vuoto. Non usare URL esterni, base64 inventati o placeholder diversi dal formato prescritto.
- Interazione appropriata quando serve: calculator, stepper, comparison, state-machine, layered-view, simulation o chart. Se l'esplorazione non aggiunge valore, non aggiungere controlli finti: una dimostrazione passiva è valida.
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
  anchor_excerpt?: null | string;
  anchor_heading?: null | string;
  complexity?: 'simple' | 'moderate' | 'complex';
  concept?: string;
  coverage?: 'all_elements' | 'single_complex' | 'complete_synthesis' | 'none';
  coverage_rationale?: string;
  factual_requirements?: string[];
  interaction_level?: 'none' | 'low' | 'high';
  pedagogical_goal?: string;
  reason?: string;
  requires_depiction?: boolean;
  visual_direction?: string;
  visual_type?: VisualType;
}

interface VisualPlansResponse {
  rationale?: string;
  plans?: VisualPlan[];
}

export interface VerifiedVisualSlotPlan {
  slotId: string;
  complexity: 'simple' | 'moderate' | 'complex';
  concept: string;
  coverage: 'all_elements' | 'single_complex' | 'complete_synthesis' | 'none';
  coverageRationale: string;
  factualRequirements: string[];
  interactionLevel: 'none' | 'low' | 'high';
  pedagogicalGoal: string;
  reason: string;
  requiresDepiction: boolean;
  visualDirection: string;
  visualType: GeneratedVisualType;
}

interface SvgVisualResponse {
  loading_messages?: unknown;
  svg_code?: unknown;
  title?: unknown;
}

interface HtmlVisualResponse {
  image_requests?: unknown;
  loading_messages?: unknown;
  title?: unknown;
  widget_code?: unknown;
}

interface HtmlImageRequest {
  alt: string;
  id: string;
  prompt: string;
}

interface RenderedVisualDraft {
  imageRequests: HtmlImageRequest[];
  visual: LessonGeneratedVisual;
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
      anchor_excerpt: { type: ['string', 'null'] },
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
      requires_depiction: { type: 'boolean' },
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
      'anchor_excerpt',
      'anchor_heading',
      'complexity',
      'concept',
      'coverage',
      'coverage_rationale',
      'interaction_level',
      'pedagogical_goal',
      'reason',
      'requires_depiction',
      'visual_type',
    ],
  },
} as const;

const VISUAL_PLAN_ITEM_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    anchor_excerpt: { type: ['string', 'null'] },
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
    requires_depiction: { type: 'boolean' },
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
    'anchor_excerpt',
    'anchor_heading',
    'complexity',
    'concept',
    'coverage',
    'coverage_rationale',
    'factual_requirements',
    'interaction_level',
    'pedagogical_goal',
    'reason',
    'requires_depiction',
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
      rationale: { type: 'string' },
      plans: {
        type: 'array',
        maxItems: MAX_GENERATED_VISUALS_PER_LESSON,
        items: VISUAL_PLAN_ITEM_RESPONSE_SCHEMA,
      },
    },
    required: ['rationale', 'plans'],
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
      image_requests: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            prompt: { type: 'string' },
            alt: { type: 'string' },
          },
          required: ['id', 'prompt', 'alt'],
        },
      },
    },
    required: ['title', 'loading_messages', 'widget_code', 'image_requests'],
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
    ? new RegExp(String.raw`^\`\`\`${language}\s*$`, 'i')
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

const normalizeHtmlImageRequests = (requests: unknown, code: string): HtmlImageRequest[] | null => {
  const placeholderIds = new Set(
    Array.from(code.matchAll(GENERATED_IMAGE_PLACEHOLDER_PATTERN), match => match[1])
  );
  const normalized: HtmlImageRequest[] = [];
  const requestIds = new Set<string>();

  for (const request of Array.isArray(requests) ? requests : []) {
    if (!request || typeof request !== 'object') {
      return null;
    }
    const record = request as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
    const alt = typeof record.alt === 'string' ? record.alt.trim() : '';
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(id) ||
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

  const hasMalformedPlaceholder = code
    .replaceAll(GENERATED_IMAGE_PLACEHOLDER_PATTERN, '')
    .includes('{{GENERATED_IMAGE:');
  return !hasMalformedPlaceholder && placeholderIds.size === requestIds.size ? normalized : null;
};

const hasFullHtmlDocument = (code: string): boolean =>
  /<!doctype|<html\b|<head\b|<body\b/i.test(code);

const buildVisualPlaceholder = (visual: LessonGeneratedVisual): string =>
  `{{VISUAL_EXAMPLE:${visual.id}|title=${visual.title.replaceAll(/[|}]/g, ' ').trim()}}}`;

const normalizeHeadingTitle = (value: string): string =>
  value
    .replace(/^#{1,6}\s+/, '')
    .replaceAll(/[*_`]/g, ' ')
    .replaceAll(/\s+/g, ' ')
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
): RenderedVisualDraft | null => {
  const code =
    typeof response.widget_code === 'string' ? stripFence(response.widget_code, 'html') : '';
  const imageRequests = normalizeHtmlImageRequests(response.image_requests, code);
  if (
    !code ||
    !imageRequests ||
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
    imageRequests,
    visual: {
      id,
      title: sanitizeTitle(response.title, 'esempio_interattivo'),
      kind: 'html',
      code,
      loadingMessages: normalizeLoadingMessages(response.loading_messages),
      createdAt: timestampIso(),
    },
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
): RenderedVisualDraft | null => {
  const parsed = parseCleanJson<SvgVisualResponse | HtmlVisualResponse | MermaidVisualResponse>(
    rendererResponse
  );

  if (visualType.includes('svg')) {
    const visual = normalizeSvgVisual(parsed as SvgVisualResponse, id);
    return visual ? { imageRequests: [], visual } : null;
  }

  if (visualType === 'interactive_html' || visualType === 'chart_html') {
    return normalizeHtmlVisual(parsed as HtmlVisualResponse, id);
  }

  const visual = normalizeMermaidVisual(parsed as MermaidVisualResponse, id);
  return visual ? { imageRequests: [], visual } : null;
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
  requires_depiction: visualType === 'illustrative_image',
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
    NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT,
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

const buildEmbeddedImageGenerationPrompt = (
  request: HtmlImageRequest,
  plan: VisualPlan,
  input: GenerateLessonVisualExampleInput
): string =>
  [
    'SCOPO',
    'Genera un singolo asset raster che verra inserito dentro un artefatto didattico HTML.',
    '',
    'ASSET RICHIESTO',
    request.prompt,
    `Testo alternativo previsto: ${request.alt}`,
    '',
    'COERENZA DIDATTICA',
    `Lezione: ${input.sectionTitle}. ${input.sectionDescription}`,
    `Artefatto: ${plan.concept || 'esempio visuale interattivo'}`,
    '',
    NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT,
    '',
    'VINCOLI',
    '- L’immagine deve essere autonoma, accurata e immediatamente leggibile nel widget.',
    '- Nessuna interfaccia, cornice, watermark, logo o decorazione estranea.',
    '- Non aggiungere testo salvo quando esplicitamente necessario nel prompt; in quel caso usa la lingua della lezione.',
    '- Mantieni il soggetto principale ben dentro i bordi e lascia margine sufficiente per eventuali ritagli responsive.',
    '',
    `CONTESTO FATTUALE DELLA LEZIONE\n${input.lessonMarkdown.slice(0, 3_000)}`,
  ].join('\n');

const buildHtmlReviewPreviewCode = (code: string): string =>
  code.replaceAll(GENERATED_IMAGE_PLACEHOLDER_PATTERN, GENERATED_IMAGE_PREVIEW_DATA_URL);

const materializeHtmlImages = async (
  visual: LessonGeneratedVisual,
  requests: HtmlImageRequest[],
  plan: VisualPlan,
  input: GenerateLessonVisualExampleInput
): Promise<LessonGeneratedVisual> => {
  const generatedImages = await Promise.all(
    requests.map(async request => ({
      id: request.id,
      image: await requestGeneratedImage(buildEmbeddedImageGenerationPrompt(request, plan, input)),
    }))
  );
  let code = visual.code;
  for (const { id, image } of generatedImages) {
    code = code.split(`{{GENERATED_IMAGE:${id}}}`).join(image.dataUrl);
  }
  if (code.includes('{{GENERATED_IMAGE:')) {
    throw new Error('Un placeholder immagine dell’artefatto non è stato risolto.');
  }
  return { ...visual, code };
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
  anchorExcerpt: plan.anchor_excerpt?.trim() || undefined,
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

const enforceVisualTypeContract = (plan: VisualPlan): VisualPlan =>
  plan.requires_depiction &&
  (plan.visual_type === 'flowchart_svg' || plan.visual_type === 'structural_svg')
    ? { ...plan, visual_type: 'illustrative_image' }
    : plan;

export const enforceVerifiedVisualTypeContract = (
  plan: VerifiedVisualSlotPlan
): VerifiedVisualSlotPlan =>
  plan.requiresDepiction &&
  (plan.visualType === 'flowchart_svg' || plan.visualType === 'structural_svg')
    ? { ...plan, visualType: 'illustrative_image' }
    : plan;

const toStoredVisualPlan = (rawPlan: VisualPlan): LessonVisualPlan => {
  const plan = enforceVisualTypeContract(rawPlan);
  return {
    anchorExcerpt: plan.anchor_excerpt?.trim() || null,
    anchorHeading: plan.anchor_heading ?? null,
    concept: plan.concept || '',
    pedagogicalGoal: plan.pedagogical_goal || '',
    reason: plan.reason || '',
    visualType: plan.visual_type as LessonVisualPlan['visualType'],
  };
};

const normalizeVisualPlanningPass = (
  response: VisualPlansResponse,
  fallbackRationale: string
): LessonVisualPlanningPass => {
  const plans = Array.isArray(response.plans)
    ? response.plans
        .filter(
          (plan): plan is VisualPlan & { visual_type: LessonVisualPlan['visualType'] } =>
            Boolean(plan.visual_type) && plan.visual_type !== 'none'
        )
        .slice(0, MAX_GENERATED_VISUALS_PER_LESSON)
    : [];

  return {
    outcome: plans.length > 0 ? 'visuals' : 'none',
    plans: plans.map(toStoredVisualPlan),
    rationale: response.rationale?.trim() || fallbackRationale,
  };
};

const toExecutablePlans = (response: VisualPlansResponse): VisualPlan[] =>
  Array.isArray(response.plans)
    ? response.plans
        .filter(plan => Boolean(plan.visual_type) && plan.visual_type !== 'none')
        .map(enforceVisualTypeContract)
        .slice(0, MAX_GENERATED_VISUALS_PER_LESSON)
    : [];

const requestVisualPlanningPass = async (
  input: GenerateLessonVisualExampleInput,
  initialDecision?: VisualPlansResponse
): Promise<VisualPlansResponse> => {
  const systemInstruction = initialDecision
    ? `${VISUAL_PLANNER_PROMPT}\n\n${VISUAL_PLAN_REVIEW_INSTRUCTION}\n\n${MULTI_VISUAL_PLANNER_OUTPUT_INSTRUCTION}`
    : `${VISUAL_PLANNER_PROMPT}\n\n${MULTI_VISUAL_PLANNER_OUTPUT_INSTRUCTION}`;
  const userContent = initialDecision
    ? `${buildPlannerRequest(input)}

DECISIONE INIZIALE DA REVISIONARE:
${JSON.stringify(initialDecision, null, 2)}`
    : buildPlannerRequest(input);
  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_VISUAL_PLANNER,
        modelSlot: 'artifact',
        messages: [
          {
            role: 'system',
            content: buildArtifactSystemPrompt(systemInstruction, Boolean(initialDecision)),
          },
          { role: 'user', content: userContent },
        ],
        reasoning: initialDecision ? MEDIUM_REASONING_CONFIG : LOW_REASONING_CONFIG,
        response_format: { type: 'json_schema', json_schema: MULTI_VISUAL_PLAN_RESPONSE_SCHEMA },
        temperature: 0.2,
      }),
    1,
    500
  );
  return parseCleanJson<VisualPlansResponse>(response || '{}');
};

export interface GeneratedLessonVisualResult {
  anchorExcerpt?: string;
  anchorHeading?: string;
  contentSuffix: string;
  visual: LessonGeneratedVisual;
}

export interface GeneratedLessonVisualsResult {
  decision: LessonVisualPlanningDecision;
  results: GeneratedLessonVisualResult[];
}

export interface GeneratedVerifiedVisualSlot {
  slotId: string;
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

  const rendererUserMessage: ChatMessage = {
    role: 'user' as const,
    content: `Lesson title: ${input.sectionTitle}
Lesson description: ${input.sectionDescription}
Target language: infer it from the lesson excerpt. Every visible label, caption, control, button, axis, state, relation, field name, and explanatory phrase in the generated visual must use that same language.
Planner output:
${JSON.stringify(plan, null, 2)}

Relevant lesson excerpt:
${input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}`,
  };
  const rendererMessages: ChatMessage[] = [
    { role: 'system' as const, content: buildArtifactSystemPrompt(rendererPrompt) },
    rendererUserMessage,
  ];
  const rendererReviewMessages: ChatMessage[] = [
    {
      role: 'system' as const,
      content: buildArtifactSystemPrompt(rendererPrompt, true),
    },
    rendererUserMessage,
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

  let draft = normalizeRenderedVisual(visualType, rendererResponse || '{}', visualId);
  if (!draft) {
    const repairedResponse = await requestRenderedVisual([
      ...rendererReviewMessages,
      { role: 'assistant', content: rendererResponse || '{}' },
      {
        role: 'user',
        content:
          'La bozza precedente non e valida, contiene accessi DOM non sicuri oppure ha image_requests e placeholder incoerenti. Rigenerala correggendo ogni riferimento a elementi mancanti: nessun document.getElementById(...) puo essere dereferenziato direttamente e ogni lookup deve gestire null. Ogni {{GENERATED_IMAGE:id}} deve corrispondere esattamente a una image_request. Restituisci nuovamente solo il JSON richiesto.',
      },
    ]);
    draft = normalizeRenderedVisual(visualType, repairedResponse || '{}', visualId);
  }
  if (!draft) {
    return null;
  }
  let { imageRequests, visual } = draft;

  const reviewSettings = await getArtifactVisualReviewSettings();
  if (visual.kind === 'svg') {
    for (let round = 0; reviewSettings.enabled && round < reviewSettings.maxRounds; round += 1) {
      const lintIssues = lintSvg(visual.code);
      if (lintIssues.length === 0) {
        break;
      }
      let preview: string;
      try {
        preview = await renderSvgPreview(visual.code);
      } catch (error) {
        throw new Error('SVG preview rendering failed.', { cause: error });
      }
      const reviewedResponse = await requestRenderedVisual([
        ...rendererReviewMessages,
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
      const reviewedDraft = normalizeRenderedVisual(visualType, reviewedResponse || '{}', visualId);
      if (!reviewedDraft || reviewedDraft.visual.kind !== 'svg') {
        break;
      }
      visual = reviewedDraft.visual;
    }
  }

  if (visual.kind === 'html') {
    for (let round = 0; reviewSettings.enabled && round < reviewSettings.maxRounds; round += 1) {
      let preview: string | null = null;
      try {
        preview = await renderHtmlPreview(buildHtmlReviewPreviewCode(visual.code));
      } catch (error) {
        console.warn(
          '[Nous][Lesson] Interactive visual preview failed; reviewing code only.',
          error
        );
      }
      const reviewText =
        'Verifica questa bozza HTML come software didattico, analizzando sia il codice sia il risultato visivo quando allegato. Controlla che venga eseguita senza errori, che ogni controllo produca davvero il cambiamento dichiarato e che la grafica sia generata da regole o algoritmi verificabili. Le capacita del renderer di disegnare a mano asset nel codice sono quelle di un bambino di seconda elementare non particolarmente dotato: se quel livello non sarebbe accettabile, usa image_requests invece di coordinate, celle, canvas o CSS improvvisati. Mantieni una corrispondenza esatta tra image_requests e placeholder {{GENERATED_IMAGE:id}}, richiedendo solo gli asset indispensabili. Correggi qualunque discrepanza tra etichette e risultato. Restituisci il JSON completo richiesto con il widget revisionato.';
      const reviewedResponse = await requestRenderedVisual([
        ...rendererReviewMessages,
        {
          role: 'assistant',
          content: JSON.stringify({
            widget_code: visual.code,
            image_requests: imageRequests,
          }),
        },
        {
          role: 'user',
          content: preview
            ? [
                { type: 'image_url', image_url: { url: preview } },
                { type: 'text', text: reviewText },
              ]
            : reviewText,
        },
      ]);
      const reviewedDraft = normalizeRenderedVisual(visualType, reviewedResponse || '{}', visualId);
      if (!reviewedDraft || reviewedDraft.visual.kind !== 'html') {
        break;
      }
      visual = reviewedDraft.visual;
      imageRequests = reviewedDraft.imageRequests;
    }
  }

  if (visual.kind === 'html' && imageRequests.length > 0) {
    visual = await materializeHtmlImages(visual, imageRequests, plan, input);
  }

  return {
    anchorExcerpt: plan.anchor_excerpt?.trim() || undefined,
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
): Promise<GeneratedLessonVisualsResult> => {
  const initialResponse = await requestVisualPlanningPass(input);
  const initial = normalizeVisualPlanningPass(
    initialResponse,
    'Il pianificatore non ha fornito una motivazione.'
  );
  let reviewedResponse: VisualPlansResponse;
  let reviewed: LessonVisualPlanningPass;
  try {
    reviewedResponse = await requestVisualPlanningPass(input, initialResponse);
    reviewed = normalizeVisualPlanningPass(
      reviewedResponse,
      'Il revisore non ha fornito una motivazione.'
    );
  } catch (error) {
    console.warn('[Nous][Lesson] Visual planning review failed; using initial decision.', error);
    reviewedResponse = initialResponse;
    reviewed = {
      outcome: 'failed',
      plans: initial.plans,
      rationale: 'Revisione visuale non completata; applicata la decisione iniziale.',
    };
  }
  const decision: LessonVisualPlanningDecision = {
    initial,
    reviewed,
    reviewedAt: timestampIso(),
  };
  console.info('[Nous][Lesson] Visual planning decision.', decision);
  pushNousDebugTrace('lesson:visual-planning-decision', {
    decision,
    sectionTitle: input.sectionTitle,
  });

  const plans = toExecutablePlans(reviewedResponse);
  const settledResults = await Promise.allSettled(
    plans.map((plan, index) => generateVisualFromPlan(input, plan, index))
  );

  const generatedVisuals = settledResults.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value ? [result.value] : [];
    }
    reportVisualWorkerFailure({
      error: result.reason,
      index,
      plan: plans[index],
    });
    return [];
  });
  if (plans.length > 0 && generatedVisuals.length === 0) {
    console.warn('[Nous][Lesson] No visual worker produced a valid artifact.', {
      decision,
      plannedVisualCount: plans.length,
    });
  }
  return { decision, results: generatedVisuals };
};

export const generateVerifiedVisualSlots = async (
  input: GenerateLessonVisualExampleInput,
  plans: VerifiedVisualSlotPlan[]
): Promise<GeneratedVerifiedVisualSlot[]> => {
  const settledResults = await Promise.allSettled(
    plans.map((plan, index) =>
      generateVisualFromPlan(
        input,
        {
          complexity: plan.complexity,
          concept: plan.concept,
          coverage: plan.coverage,
          coverage_rationale: plan.coverageRationale,
          factual_requirements: plan.factualRequirements,
          interaction_level: plan.interactionLevel,
          pedagogical_goal: plan.pedagogicalGoal,
          reason: plan.reason,
          visual_direction: plan.visualDirection,
          visual_type: plan.visualType,
        },
        index
      )
    )
  );

  return settledResults.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value ? [{ slotId: plans[index].slotId, visual: result.value.visual }] : [];
    }
    reportVisualWorkerFailure({
      error: result.reason,
      index,
      plan: {
        complexity: plans[index].complexity,
        concept: plans[index].concept,
        coverage: plans[index].coverage,
        coverage_rationale: plans[index].coverageRationale,
        factual_requirements: plans[index].factualRequirements,
        interaction_level: plans[index].interactionLevel,
        pedagogical_goal: plans[index].pedagogicalGoal,
        reason: plans[index].reason,
        visual_direction: plans[index].visualDirection,
        visual_type: plans[index].visualType,
      },
      slotId: plans[index].slotId,
    });
    return [];
  });
};
