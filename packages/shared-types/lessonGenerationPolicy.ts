export const MAX_GENERATED_VISUALS_PER_LESSON = 3;
export const MAX_LESSON_QUIZ_QUESTIONS = 3;
export const MAX_VISUAL_LESSON_CHARS = 12_000;

export const ACTIVE_PAUSE_EXERCISE_TYPES = [
  'concept-check',
  'application-card',
  'prediction',
  'error-diagnosis',
  'classification',
  'compare-contrast',
  'sequence',
  'micro-synthesis',
] as const;

export type ActivePauseExerciseType = (typeof ACTIVE_PAUSE_EXERCISE_TYPES)[number];

export const ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE: ReadonlyArray<{
  instruction: string;
  type: ActivePauseExerciseType;
}> = [
  {
    type: 'concept-check',
    instruction:
      'Controllo concettuale: discrimina tra affermazioni plausibili usando il significato del concetto. Non chiedere mai di riconoscere un termine o una definizione appena dichiarati quasi con le stesse parole.',
  },
  {
    type: 'application-card',
    instruction:
      'Applicazione lampo: applica un concetto a un mini-caso nuovo, concreto e risolvibile in pochi secondi. Cambia i dettagli superficiali rispetto agli esempi gia spiegati, mantenendo la stessa struttura concettuale.',
  },
  {
    type: 'prediction',
    instruction:
      'Previsione: prevedi la conseguenza piu probabile se cambia una condizione, un passaggio o un vincolo. La risposta deve richiedere di usare il modello causale appena costruito, non di ripetere una frase del testo.',
  },
  {
    type: 'error-diagnosis',
    instruction:
      'Diagnosi errore: individua l errore, l assunzione falsa o la correzione migliore in un ragionamento breve e plausibile. L errore deve mettere alla prova una distinzione reale, non essere un distrattore palesemente assurdo.',
  },
  {
    type: 'classification',
    instruction:
      'Classificazione: assegna un esempio nuovo, un caso o un fenomeno alla categoria piu adatta usando i criteri spiegati. Non riutilizzare come domanda lo stesso esempio gia etichettato nel testo.',
  },
  {
    type: 'compare-contrast',
    instruction:
      'Confronto: scegli la differenza, somiglianza o implicazione che separa correttamente due concetti. Richiedi di ricostruire la distinzione, non di individuare quale opzione copia meglio una frase vicina.',
  },
  {
    type: 'sequence',
    instruction:
      'Sequenza: scegli l ordine corretto di passaggi, cause, condizioni o priorita quando l ordine porta informazione. Evita sequenze che possono essere risolte soltanto copiando l elenco immediatamente precedente.',
  },
  {
    type: 'micro-synthesis',
    instruction:
      'Micro-sintesi: integra almeno due idee appena costruite e scegli la sintesi, etichetta o connessione piu fedele. Non trasformarla nel richiamo letterale di una singola definizione.',
  },
];

export const ACTIVE_PAUSE_PLACEMENT_RULE =
  'Ogni pausa e un blocco inline-quiz autosufficiente collocato dopo un blocco markdown che contiene tutte le informazioni necessarie dalla pausa precedente. Visuali generati o clip YouTube pertinenti tra quel markdown e la pausa non interrompono il contesto. Una pausa consuma il contesto esplicativo: non inserire due inline-quiz consecutive, non raggrupparle in fondo e non usare marker o un array quiz separato.';

export const ACTIVE_PAUSE_REASONING_RULE =
  'Ogni pausa deve richiedere almeno discriminazione concettuale, applicazione a un caso nuovo, inferenza, previsione, diagnosi, classificazione, sequenziamento o micro-sintesi. Se la risposta corretta si puo scegliere copiando, parafrasando o riconoscendo per sovrapposizione lessicale una frase o definizione immediatamente vicina, trasformala in un caso nuovo oppure rimuovi la pausa.';

export const ACTIVE_PAUSE_OPTIONS_RULE =
  'Ogni pausa ha quattro opzioni testualmente distinte e distrattori plausibili rispetto al concetto verificato: le alternative errate devono rappresentare confusioni realistiche, non risposte palesemente assurde.';

export const ACTIVE_PAUSE_TEXT_FORMAT_RULE =
  'Domanda e opzioni sono testo normale, mai interamente racchiuso in backticks o code fence; preserva soltanto eventuale codice inline interno.';

export const ORIGINAL_IMAGE_PRIORITY_RULE =
  'Quando nei riferimenti sono disponibili immagini originali chiare, pertinenti e specifiche della fonte — per esempio schermate, oggetti, casi o diagrammi complessi propri del documento — preferiscile a visuali generate equivalenti. Se piu immagini originali coprono lo stesso bisogno pedagogico, usa solo il numero minimo utile e proporzionato alla struttura della lezione, evitando figure ridondanti. Genera una sostituzione solo quando gli originali non coprono la stessa esigenza pedagogica o non sono sufficientemente leggibili.';

export const ORIGINAL_IMAGE_USAGE_RULES = [
  'Ogni immagine originale deve servire una spiegazione vicina: non usarla come decorazione o intermezzo visivo.',
  'Puoi referenziare soltanto gli assetId forniti. Se nessuna immagine e chiaramente pertinente, lascia imageRefs vuoto.',
  'Ogni imageRef deve avere un anchorHeading che corrisponde esattamente a un heading presente in un blocco markdown, senza i simboli #.',
  'Usa soltanto immagini con una caption visiva chiara e autosufficiente. Escludi immagini sfocate, parziali, ritagliate, poco leggibili, decorative, badge, icone, bordi, wrapper o frammenti.',
  ORIGINAL_IMAGE_PRIORITY_RULE,
  'Non usare il contesto testuale per indovinare una figura poco chiara: caption e testo vicino servono soltanto a disambiguare una figura gia riconoscibile.',
  'Il paragrafo vicino deve dire che cosa guardare nell immagine e perche e utile; non citare mai un assetId tecnico nel markdown.',
] as const;

export const LESSON_VISUAL_TYPES = [
  'chart_html',
  'flowchart_svg',
  'illustrative_image',
  'interactive_html',
  'mermaid_class',
  'mermaid_erd',
  'structural_svg',
] as const;

export type LessonVisualType = (typeof LESSON_VISUAL_TYPES)[number];

export const GENERATED_VISUAL_RELEVANCE_RULE =
  'Non generare visuali decorative. Ogni visuale deve insegnare qualcosa che il testo da solo rende piu faticoso da capire, non limitarsi a riassumerlo o parafrasarlo; usa soltanto il numero minimo di visuali necessario.';

export const INTERACTIVE_VISUAL_VALUE_RULE =
  'Tratta interactive_html come un formato costoso: usalo solo quando l’utente deve esplorare, modificare o confrontare stati e questa interazione produce una comprensione importante che testo, video o una o due immagini statiche non possono offrire altrettanto bene. Non usarlo per dimostrazioni cosmetiche, controlli banali o esempi statici travestiti da interattivi; se l’interazione non è essenziale, scegli il formato più semplice.';

export const VISUAL_FORMAT_SELECTION_RULE =
  'Imposta requiresDepiction=true quando lo studente deve vedere l’aspetto di un oggetto, stato, scena, risultato grafico o trasformazione visiva, inclusi passaggi che mostrano come cambia un soggetto. In quel caso usa illustrative_image: un processo visivo non è un flowchart. SVG è consentito soltanto con requiresDepiction=false per relazioni astratte fra brevi etichette testuali, box generici e frecce; i nodi non possono contenere disegni, sagome, pixel art, oggetti, scene o esempi del risultato. Se la visuale deve mostrare esempi programmabili — inclusi pixel art, shader semplici, pattern generativi, confronti di filtri o effetti — usa interactive_html anche quando non richiede controlli; il formato può essere una dimostrazione HTML/JavaScript passiva. Usa interactive_html con controlli solo quando la manipolazione aggiunge valore didattico essenziale. Per una visuale programmabile passiva, imposta interactionLevel=none nel contratto backend oppure interaction_level=none nel contratto client.';

export const NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT = `CONTRATTO VISIVO NOUS:
- Base calda e neutra: avorio/carta, pietra e antracite; superfici sobrie, bordi leggeri, ombre minime e tipografia editoriale.
- Usa un solo accento coerente col soggetto, scelto tra rosso smorzato, borgogna, verde terroso e rame/arancio smorzato.
- Vietate palette SaaS blu/viola, neon, glow, gradienti decorativi e ombre sovradimensionate, salvo colore semanticamente necessario al contenuto.
- Il medium segue lo scopo pedagogico: illustrazioni 2D editoriali sono pienamente ammesse; non usare oggetti o render 3D come default decorativo.
- In HTML e SVG usa le variabili CSS dell'host (--bg-paper, --bg-surface, --ink-primary, --ink-secondary, --accent, --border-subtle, --border-strong) invece di colori tema hard-coded e mantieni leggibili tema chiaro e scuro.`;

export const enforceLessonVisualTypeContract = <
  T extends { requiresDepiction: boolean; visualType: LessonVisualType },
>(
  plan: T
): T =>
  plan.requiresDepiction &&
  (plan.visualType === 'flowchart_svg' || plan.visualType === 'structural_svg')
    ? { ...plan, visualType: 'illustrative_image' }
    : plan;
