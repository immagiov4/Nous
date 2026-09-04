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
  'When the references contain clear, relevant original images specific to the source, such as screenshots, objects, cases, or complex diagrams from the document, prefer them over equivalent generated visuals. If several original images address the same pedagogical need, use only the minimum useful number proportional to the lesson structure and avoid redundant figures. Generate a replacement only when the originals do not address the same pedagogical need or are not sufficiently readable.';

export const ORIGINAL_IMAGE_USAGE_RULES = [
  'Every original image must support a nearby explanation. Do not use it as decoration or a visual interlude.',
  'Reference only the supplied assetIds. If no image is clearly relevant, leave imageRefs empty.',
  'For every selected imageRef, insert {{PDF_IMAGE:assetId}} in a Markdown content block where the image belongs. Replace assetId with the supplied image identifier. Choose its position as part of writing the lesson; metadata alone does not display the image.',
  'Use only images with a clear, self-contained visual caption. Exclude blurred, partial, cropped, hard-to-read, or decorative images, as well as badges, icons, borders, wrappers, or fragments.',
  ORIGINAL_IMAGE_PRIORITY_RULE,
  'Do not use textual context to guess what an unclear figure shows. Captions and nearby text may only disambiguate an already recognizable figure.',
  'The nearby paragraph must say what to observe in the image and why it is useful. Use technical assetIds only inside PDF_IMAGE placeholders, never in the surrounding prose.',
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
  'Do not generate decorative visuals. Every visual must teach something that text alone makes harder to understand, not merely summarize or paraphrase it. Use only the minimum necessary number of visuals.';

export const INTERACTIVE_VISUAL_VALUE_RULE =
  'Treat interactive_html as an expensive format. Use it only when the user must explore, modify, or compare states and that interaction produces important understanding that text, video, or one or two static images cannot provide equally well. Do not use it for cosmetic demonstrations, trivial controls, or static examples disguised as interactive. If interaction is not essential, choose the simpler format.';

export const VISUAL_FORMAT_SELECTION_RULE =
  'Set requiresDepiction=true when the student must see the appearance of an object, state, scene, graphical result, or visual transformation, including steps that show how a subject changes. In that case use illustrative_image. A visual process is not a flowchart. SVG is allowed only with requiresDepiction=false for abstract relationships among short text labels, generic boxes, and arrows. Nodes cannot contain drawings, silhouettes, pixel art, objects, scenes, or examples of the result. If the visual must show programmable examples, including pixel art, simple shaders, generative patterns, or filter and effect comparisons, use interactive_html even when controls are unnecessary. The format may be a passive HTML and JavaScript demonstration. Use interactive_html with controls only when manipulation adds essential teaching value. For a passive programmable visual, set interactionLevel=none in the backend contract or interaction_level=none in the client contract.';

export const NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT = `NOUS VISUAL CONTRACT:
- Use a warm neutral base of ivory or paper, stone, and charcoal, with restrained surfaces, light borders, minimal shadows, and editorial typography.
- Use one accent consistent with the subject, chosen from muted red, burgundy, earthy green, and muted copper or orange.
- Do not use blue or purple SaaS palettes, neon, glow, decorative gradients, or oversized shadows unless the content requires the color semantically.
- Let the pedagogical purpose determine the medium. Editorial 2D illustrations are fully allowed. Do not default to decorative 3D objects or renders.
- In HTML and SVG, use the host CSS variables (--bg-paper, --bg-surface, --ink-primary, --ink-secondary, --accent, --border-subtle, --border-strong) instead of hard-coded theme colors, and keep both light and dark themes readable.`;

export const enforceLessonVisualTypeContract = <
  T extends { requiresDepiction: boolean; visualType: LessonVisualType },
>(
  plan: T
): T =>
  plan.requiresDepiction &&
  (plan.visualType === 'flowchart_svg' || plan.visualType === 'structural_svg')
    ? { ...plan, visualType: 'illustrative_image' }
    : plan;
