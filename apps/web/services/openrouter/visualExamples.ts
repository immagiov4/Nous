import type { LessonGeneratedVisual } from '../../types.ts';
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
- Se il concetto e complesso, setta split_into_multiple=true, ma per questa versione scegli comunque il primo sottoconcetto piu utile.
- Usa Mermaid solo per ER e class diagram.
- Rispondi SOLO con JSON:
{
  "visual_type": "...",
  "concept": "una frase sul soggetto visuale",
  "pedagogical_goal": "build_intuition | show_process | show_structure | enable_exploration | show_data",
  "interaction_level": "none | low | high",
  "complexity": "simple | moderate | complex",
  "split_into_multiple": true | false,
  "reason": "una frase"
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
- Le frecce non devono attraversare box non collegati.`;

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
- Tutto il testo visibile nel widget deve essere nella stessa lingua della lezione fornita. Non tradurre in inglese se la lezione non e in inglese.
- Nessun DOCTYPE, <html>, <head>, <body>.
- Ordine immutabile: <style> prima, HTML in mezzo, <script> ultimo.
- Usa sempre variabili CSS: --bg-paper, --bg-surface, --ink-primary, --ink-secondary, --accent, --border-subtle, --border-strong.
- Niente @media (prefers-color-scheme: dark); host gestisce .dark.
- Niente position:fixed, shadow pesanti, blur, filter, backdrop-filter, gradienti.
- Container in flow: display:block; width:100%.
- Range input sempre con step.
- Numeri mostrati sempre arrotondati/formattati.
- CDN consentiti solo: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh.
- Non creare pulsanti finti per link esterni o chat.
- Interazione appropriata: calculator, stepper, comparison, state-machine, layered-view, simulation o chart.`;

const RENDERER_MERMAID_PROMPT = `SYSTEM:
Sei un generatore di diagrammi Mermaid solo per database e classi.

Output SOLO JSON:
{
  "title": "snake_case_title",
  "diagram_type": "erDiagram | classDiagram",
  "mermaid_code": "..."
}

Regole:
- Tutti i nomi visibili, campi e relazioni devono essere nella stessa lingua della lezione fornita quando non sono termini tecnici obbligati.
- Usa erDiagram solo per modelli entita-relazione.
- Usa classDiagram solo per strutture OOP.
- Non usare flowchart, sequenceDiagram o altri tipi Mermaid.
- Nessun markdown fence.
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
  complexity?: 'simple' | 'moderate' | 'complex';
  concept?: string;
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
  const normalized =
    typeof title === 'string'
      ? title
          .replace(/[^a-z0-9_ -]/gi, ' ')
          .replace(/\s+/g, '_')
          .toLowerCase()
          .replace(/_+/g, '_')
          .replace(/^_+|_+$/g, '')
      : '';

  return normalized || fallback;
};

const normalizeLoadingMessages = (messages: unknown): string[] =>
  Array.isArray(messages)
    ? messages.filter((message): message is string => typeof message === 'string').slice(0, 3)
    : [];

const hasFullHtmlDocument = (code: string): boolean =>
  /<!doctype|<html\b|<head\b|<body\b/i.test(code);

const buildVisualPlaceholder = (visual: LessonGeneratedVisual): string =>
  `{{VISUAL_EXAMPLE:${visual.id}|title=${visual.title.replace(/[|}]/g, ' ').trim()}}}`;

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
    createdAt: new Date().toISOString(),
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
    !/<script[\s>]/i.test(code)
  ) {
    return null;
  }

  return {
    id,
    title: sanitizeTitle(response.title, 'esempio_interattivo'),
    kind: 'html',
    code,
    loadingMessages: normalizeLoadingMessages(response.loading_messages),
    createdAt: new Date().toISOString(),
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
    createdAt: new Date().toISOString(),
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

Testo lezione:
${lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}`;

export const generateLessonVisualExample = async (
  input: GenerateLessonVisualExampleInput
): Promise<{ contentSuffix: string; visual: LessonGeneratedVisual } | null> => {
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

  const rendererResponse = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_VISUAL_RENDERER,
        disableModelOverride: true,
        messages: [
          { role: 'system', content: rendererPrompt },
          {
            role: 'user',
            content: `Lesson title: ${input.sectionTitle}
Lesson description: ${input.sectionDescription}
Target language: infer it from the lesson excerpt. Every visible label, caption, control, button, axis, state, relation, field name, and explanatory phrase in the generated visual must use that same language.
Planner output:
${JSON.stringify(plan, null, 2)}

Relevant lesson excerpt:
${input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}`,
          },
        ],
        reasoning: MEDIUM_REASONING_CONFIG,
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    1,
    500
  );

  const visual = normalizeRenderedVisual(
    visualType,
    rendererResponse || '{}',
    `${VISUAL_ID_PREFIX}001`
  );
  if (!visual) {
    return null;
  }

  return {
    visual,
    contentSuffix: `\n\n${buildVisualPlaceholder(visual)}`,
  };
};
