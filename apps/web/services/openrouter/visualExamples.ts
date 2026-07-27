import {
  MAX_GENERATED_VISUALS_PER_LESSON,
  MAX_VISUAL_LESSON_CHARS,
  NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT,
} from '@shared/lessonGenerationPolicy';
import {
  buildEmbeddedArtifactImagePrompt,
  buildLessonRasterImagePrompt,
  getLessonRasterImageSubject,
  HTML_ARTIFACT_RENDER_RULES,
  type HtmlArtifactImageRequest,
  LESSON_VISUAL_PLANNING_RULES,
  MERMAID_ARTIFACT_RENDER_RULES,
  normalizeHtmlArtifactImageRequests,
  SVG_ARTIFACT_RENDER_RULES,
} from '@shared/lessonVisualContracts';
import type {
  LessonGeneratedVisual,
  LessonVisualPlan,
  LessonVisualPlanningDecision,
  LessonVisualPlanningPass,
  LessonVisualRetryPlan,
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
import { type DurableImageGenerationScope, requestGeneratedImage } from './imageClient.ts';
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

export {
  INTERACTIVE_VISUAL_VALUE_RULE,
  MAX_GENERATED_VISUALS_PER_LESSON,
  NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT,
  VISUAL_FORMAT_SELECTION_RULE,
} from '@shared/lessonGenerationPolicy';

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
    format: plan.visual_type,
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
${LESSON_VISUAL_PLANNING_RULES}
- Per una richiesta esplicita pianifica un solo artefatto.
- Inferisci la lingua dal testo finale della lezione. La visuale deve usare la stessa lingua della lezione.
- Se "Immagini PDF gia integrate" e "si", trattale come materiale visivo primario. Aggiungi una visuale generata solo se risponde a una domanda pedagogica distinta che le immagini della fonte non coprono; altrimenti non pianificare nulla.
- Il posizionamento e parte della scelta pedagogica. Se generi una visuale, scegli in "anchor_heading" il heading ESATTO sotto cui il testo usa o introduce quel concetto. Usa null solo per visuali davvero conclusive.
- In "anchor_excerpt" copia un breve estratto ESATTO dell'ultimo paragrafo che lo studente deve leggere prima della visuale. Questo estratto decide la posizione tra i paragrafi; il codice non la reinterpretara. Usa null solo se non esiste un punto locale sensato.
- Usa Mermaid solo per ER e class diagram.
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

${SVG_ARTIFACT_RENDER_RULES}`;

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

${HTML_ARTIFACT_RENDER_RULES}`;

const RENDERER_MERMAID_PROMPT = `SYSTEM:
Sei un generatore di diagrammi Mermaid solo per database e classi.

Output SOLO JSON:
{
  "title": "snake_case_title",
  "diagram_type": "erDiagram | classDiagram",
  "mermaid_code": "..."
}

${MERMAID_ARTIFACT_RENDER_RULES}`;

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

export type VerifiedVisualSlotPlan = LessonVisualRetryPlan & {
  visualType: GeneratedVisualType;
};

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

type HtmlImageRequest = HtmlArtifactImageRequest;

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
  durableImageScope?: DurableImageGenerationScope;
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
  const imageRequests = normalizeHtmlArtifactImageRequests(response.image_requests, code);
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
      image: await requestGeneratedImage(
        buildEmbeddedArtifactImagePrompt(request, {
          concept: plan.concept || '',
          lessonMarkdown: input.lessonMarkdown,
          sectionDescription: input.sectionDescription,
          sectionTitle: input.sectionTitle,
        }),
        input.durableImageScope
          ? {
              ...input.durableImageScope,
              dedupeKey: `${input.durableImageScope.dedupeKey}:${request.id}`,
            }
          : undefined
      ),
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
  const promptInput = {
    concept: plan.concept || '',
    factualRequirements: plan.factual_requirements || [],
    lessonMarkdown: input.lessonMarkdown,
    pedagogicalGoal: plan.pedagogical_goal || '',
    sectionDescription: input.sectionDescription,
    sectionTitle: input.sectionTitle,
    visualDirection: plan.visual_direction || '',
  };
  const subject = getLessonRasterImageSubject(promptInput);
  const image = await requestGeneratedImage(
    buildLessonRasterImagePrompt(promptInput),
    input.durableImageScope
  );

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
  for (const plan of plans) {
    pushNousDebugTrace('lesson:visual-slot-attempt', {
      concept: plan.concept,
      format: plan.visualType,
      phase: 'started',
      slotId: plan.slotId,
      visualType: plan.visualType,
    });
  }
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
      const plan = plans[index];
      pushNousDebugTrace('lesson:visual-slot-attempt', {
        concept: plan.concept,
        format: plan.visualType,
        phase: result.value ? 'completed' : 'invalid-draft',
        slotId: plan.slotId,
        visualType: plan.visualType,
      });
      return result.value ? [{ slotId: plan.slotId, visual: result.value.visual }] : [];
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
