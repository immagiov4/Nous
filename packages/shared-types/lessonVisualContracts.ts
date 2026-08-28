import {
  GENERATED_VISUAL_RELEVANCE_RULE,
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
    (line, index) => index > 0 && /^(?:request|richiesta):/u.test(line.trimStart().toLowerCase())
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
    'Clear horizontal composition, an immediately recognizable main subject, and simple visual hierarchy.';

  return [
    'PURPOSE',
    `Create one accurate pedagogical image to help explain: ${input.pedagogicalGoal || 'the central concept'}.`,
    '',
    'SUBJECT AND CONTEXT',
    `Subject: ${subject}`,
    `Lesson: ${input.sectionTitle}. ${input.sectionDescription}`,
    '',
    'REQUIRED FACTUAL DETAILS',
    `- ${factualRequirements}`,
    '',
    'COMPOSITION',
    visualDirection,
    'Use a horizontal 16:9 format. Show only elements that help understanding.',
    '',
    'STYLE',
    'Use a precise, readable, visually coherent, non-decorative educational illustration. Materials, lighting, anatomy, perspective, and spatial relationships must be plausible for the subject.',
    NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT,
    '',
    'CONSTRAINTS',
    '- Use text, numbers, labels, or arrows only when needed to read the pedagogical content. Keep them short, correct, and in the lesson language.',
    '- No logos, watermarks, narrative captions, or decorative text.',
    '- No graphical interface, decorative frame, or unrelated element.',
    '- Do not turn the subject into a block diagram. This request is raster because its concrete appearance or spatial complexity carries information.',
    '',
    `FACTUAL LESSON CONTEXT\n${input.lessonMarkdown.slice(0, 4_000)}`,
  ].join('\n');
};

export const buildEmbeddedArtifactImagePrompt = (
  request: HtmlArtifactImageRequest,
  input: Pick<
    LessonRasterImagePromptInput,
    'concept' | 'lessonMarkdown' | 'sectionDescription' | 'sectionTitle'
  >
): string => `Generate one raster asset to insert into an educational HTML artifact.

Requested asset: ${request.prompt}
Expected alt text: ${request.alt}
Lesson: ${input.sectionTitle}. ${input.sectionDescription}
Artifact: ${input.concept || 'interactive visual example'}

${NOUS_ARTIFACT_VISUAL_STYLE_CONTRACT}

The image must be self-contained, accurate, and immediately readable. Do not add an interface, frame, watermark, logo, or unrelated decoration. Add no text unless the prompt explicitly requires it. In that case, use the lesson language. Keep the main subject well inside the edges and leave enough margin for responsive cropping.

FACTUAL LESSON CONTEXT
${input.lessonMarkdown.slice(0, 3_000)}`;

export const LESSON_VISUAL_PLANNING_RULES = `- ${GENERATED_VISUAL_RELEVANCE_RULE}
- ${INTERACTIVE_VISUAL_VALUE_RULE}
- ${VISUAL_FORMAT_SELECTION_RULE}
- For automatic generation, normally plan zero or one artifact. Plan two only when they answer different, complementary pedagogical questions, and three only when all are indispensable. Never produce aesthetic variants of the same content.
- Format variety is never a goal. Two or three raster images are correct when they are the best pedagogical solution.
- Do not simulate images with ASCII art, monospace text, cells, coordinates, geometric boxes, or SVG. If concrete appearance matters, use illustrative_image.
- Every plan must stay within the local section where it is placed. Do not preview concepts from later sections or merge distant topics.
- The visual must be understandable within seconds using natural terms already introduced in nearby text. Do not use invented jargon, esoteric labels, ambiguous nominal formulas, or controls whose result cannot be observed.
- If the lesson presents a set of equivalent elements, the visual must represent all of them. Use single_complex only when one element is objectively more complex, and justify the exception in reason.
- Do not add narration, takeaways, recaps, or concluding boxes inside the visual. Visible text must help read entities, states, relationships, or controls.
- Scale the layout to the number of elements. With many elements, use compact grids or columns, minimize graphical entities, and shorten labels instead of compressing the content.
- Return from zero to ${MAX_GENERATED_VISUALS_PER_LESSON} plans.`;

export const LESSON_VISUAL_PLANNER_SYSTEM_PROMPT = `SYSTEM:
You are a pedagogical planner of visual examples for Nous Reader.
Given the final lesson text, decide which generated visual representations are genuinely needed.

Choose exactly one type for each plan:
- illustrative_image: a raster illustration for physical or stylized reality, dimensional form, lighting, shading, volume, perspective, materials, surfaces, texture, anatomy, gestures, objects, scenes, places, and phenomena. It may also use a diagram-like composition with arrows and labels when they help read the image.
- flowchart_svg: abstract relationships among textual steps in a process, pipeline, or decision tree only. Nodes cannot depict the visual states produced by the steps.
- structural_svg: a simple informational diagram of containment, architecture, layers, or parts within a system only.
- interactive_html: an HTML, CSS, and JavaScript lab where real interaction is indispensable to explore, modify, or compare the concept.
- chart_html: quantitative data, numerical comparisons, distributions, and trends.
- mermaid_erd: entity relationship diagrams only.
- mermaid_class: classes, inheritance, interfaces, and associations only.
- none: no useful visual, or the lesson is already sufficiently visual.

Rules:
${LESSON_VISUAL_PLANNING_RULES}
- For an explicit request, plan exactly one artifact.
- Infer the language from the final lesson text. The visual must use the same language as the lesson.
- If "PDF images already integrated" is "yes," treat them as primary visual material. Add a generated visual only when it answers a distinct pedagogical question not covered by the source images. Otherwise plan nothing.
- Placement is part of the pedagogical choice. When generating a visual, set "anchor_heading" to the EXACT heading under which the text uses or introduces that concept. Use null only for genuinely concluding visuals.
- Use Mermaid only for ER and class diagrams.
- Follow the output format requested at the end exactly.`;

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
  `Lesson: "${input.sectionTitle}"
Description: "${input.sectionDescription}"
PDF images already integrated: ${input.hasPdfImages ? 'yes' : 'no'}
Course notes: ${input.generationNotes?.trim() || 'none'}
Target language: infer it from the lesson text and preserve it in every visible part of the example.
Available placement headings:
${
  getMarkdownHeadingTitles(input.lessonMarkdown)
    .map(heading => `- ${heading}`)
    .join('\n') || '- no headings available'
}

Lesson text:
${input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}`;

export const SVG_ARTIFACT_RENDER_RULES = `Required SVG rules:
- Reserve SVG for simple informational diagrams with a few nodes, boxes, lines, arrows, and labels showing abstract relationships, hierarchies, containment, and architectures. Do not use it for physical or stylized reality, dimensional form, lighting, volume, perspective, materials, surfaces, textures, illustrations, organic forms, people, anatomy, gestures, depicted objects, or scenes. Do not approximate these subjects with boxes or geometric drawings. They require a raster image.
- If coverage is all_elements, represent every element in the set in one graphic. Use a grid or columns to distribute them.
- All visible text must use the lesson language and natural terms already present in the local text.
- Produce one <svg> element without a wrapper, DOCTYPE, HTML, scripts, event handlers, or network resources.
- Use viewBox "0 0 680 H", width="100%", a transparent background, and no outer background rectangle.
- The first child must be <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>.
- Use only these available classes: .t, .ts, .th, .box, .arr, .leader, .node, .c-purple, .c-teal, .c-coral, .c-pink, .c-gray, .c-blue, .c-green, .c-amber, .c-red.
- Every <text> must have class .t, .ts, or .th and dominant-baseline="central". Use sentence case, not Title Case or all caps.
- Connector <path> and <polyline> elements must have fill="none". Arrows must use marker-end="url(#arrow)".
- Do not use shadow, blur, glow, filter, emoji, HTML, or comments. Use at most two color ramps. c-gray is the default, while c-amber, c-red, and c-green are semantic only.
- Set viewBox height to the final element plus 40px.
- Calculate box width from the text at roughly 8px per character for 14px text and 7px for 12px text, plus 24px padding. Shorten text before it overflows.
- A one-line box is 44px high. A two-line box is 56px high, with 22px between title and subtitle. Place the title at cy - 9 and the subtitle at cy + 13.
- Use at least 24px internal padding, at least 60px between adjacent boxes, and at least 10px between an arrow and a border.
- Before placing a row, verify that N * box_width + (N - 1) * gap is at most 600. If it does not fit, use multiple rows.
- If an arrow would cross an unrelated box, route it in an L shape through free space.
- Apply c-* classes to a group containing rect and text without nesting another intermediate group.
- Keep every label between one and six words. Do not use narrative captions, summary boxes, takeaways, or complete prose sentences.`;

export const HTML_ARTIFACT_RENDER_RULES = `Required HTML rules:
- If coverage is all_elements, represent every element in the set with cards, a stepper, panels, or a grid.
- All visible text must use the lesson language and natural terms already introduced in the local text. Every control must state an observable effect and actually produce it.
- Do not use DOCTYPE, <html>, <head>, or <body>. Keep this immutable order: <style> first, HTML in the middle, and <script> last.
- Every ID used in document.getElementById must literally exist in the HTML before the script. Do not create those elements through JavaScript.
- Do not dereference document.getElementById(...).property directly. Store the result, check for null, and then use the variable.
- Use the CSS variables --bg-paper, --bg-surface, --ink-primary, --ink-secondary, --accent, --border-subtle, and --border-strong.
- Do not use @media (prefers-color-scheme: dark), position:fixed, heavy shadows, blur, filter, backdrop-filter, or gradients. The host manages the dark theme.
- Keep containers in flow with display:block and width:100%. Every range input must have a step, and displayed numbers must be rounded or formatted.
- Restrict the code to the educational example shown in its own panel. It must not perform malicious, deceptive, or unrelated actions.
- Do not use the network, fetch, XMLHttpRequest, WebSocket, EventSource, external scripts, or dynamic imports. Do not navigate the page, open popups, start downloads, use storage, cookies, the clipboard, device APIs, or attempt to communicate with the parent page. Do not create fake buttons for external links or chat.
- Use HTML, CSS, and JavaScript for naturally programmable graphics such as generative patterns, CSS comparisons, simulations, states, transformations, and simple shaders. Do not render ASCII art or pseudo-pixels with monospace text.
- Graphics must derive from a verifiable law or procedure. Do not hand-code illustrations, 3D models, or complex pixel art as arrays of coordinates, cells, or colors.
- If the result needs artistic judgment or real spatial understanding, use an image generated through imageRequests rather than improvised coordinates, CSS, canvas, or SVG.
- Every artistic asset must appear only as <img src="{{GENERATED_IMAGE:unique-asset-id}}" alt="...">. Every placeholder must have a request with the same id and vice versa.
- Asset ids must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, or underscores. Prompts must be self-contained and must not use references such as "as above."
- Request only indispensable images. Prefer one composite image when it is enough. If no images are needed, imageRequests must be empty.
- Do not add fake controls to a passive demonstration. Place an input, the controls, and the result they modify in the same panel or logical row.
- Use space, margins, and padding sparingly. For multiple controls, use a compact responsive grid. Avoid arbitrary min-height values and long full-width columns.
- Keep titles between one and three words and labels between one and six words. Do not use narrative captions, summary boxes, takeaways, or paragraphs that summarize the lesson.`;

export const MERMAID_ARTIFACT_RENDER_RULES = `Required Mermaid rules:
- If coverage is all_elements, include every entity or class in the set.
- All visible names, fields, and relationships must use the lesson language unless they are required technical terms.
- Use erDiagram only for entity relationship models and classDiagram only for object-oriented structures.
- Do not use flowchart, sequenceDiagram, other Mermaid types, or Markdown fences.
- Keep the diagram compact with only essential entities, fields, and relationships, using short names of one to three words.
- Clearly label relationships and annotate types and primary or foreign keys when relevant.`;
