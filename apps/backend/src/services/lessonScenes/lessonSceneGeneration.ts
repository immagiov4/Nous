import { INTERNAL_FAST_TASK_INSTRUCTION } from '@shared/aiPromptInstructions';
import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import { LessonSceneAnimationShape } from '@shared/lessonPlaybackSchema';
import {
  findLessonSceneProblems,
  GENERATABLE_LESSON_SCENE_TYPES,
  GUIDED_PATH_MAX_STEPS,
  GUIDED_PATH_MIN_STEPS,
  hasConflictingLessonSceneClosingText,
  isAnimatedLessonScene,
  LESSON_SCENE_CATALOG,
  LESSON_SCENE_DIAGRAM_TYPES,
  LESSON_SCENE_REGISTRY,
  LESSON_SCENE_RELATION_KINDS,
  LESSON_SCENE_VERDICTS,
  type LessonScene,
  LessonSceneSchema,
  type LessonSceneType,
} from '@shared/lessonScene';
import { interactiveSelectionRules } from '@shared/lessonSceneAnimation';
import {
  LESSON_SCENE_CLOSING_TEXT_RULE,
  LESSON_SCENE_INDEPENDENT_CONTENT_RULE,
} from '@shared/lessonVisualContracts';
import * as z from 'zod';
import { getResolvedModelConfigForProvider } from '../../config/modelConfig.js';
import {
  toWorkflowErrorDiagnostic,
  type WorkflowErrorDiagnostic,
} from '../../workflows/workflowErrorDiagnostics.js';
import {
  isInvalidLessonVisualStructuredOutput,
  type RenderResolvedLessonVisualInput,
} from '../lessonGenerationVisuals.js';
import type { LessonSourceProvenance } from '../lessonPrimarySourceContext.js';
import { generateStructuredOutput } from '../structuredGeneration.js';
import { chooseLessonSceneIcons, type SceneIconEntry } from './lessonSceneIconChoice.js';

/**
 * Generates a lesson scene: the model reads the lesson, decides what the reader must understand,
 * picks a catalog form, and fills structured content with search phrases for each icon slot.
 * Deterministic validation grounds quotations and quantities in the lesson; the icon choice then
 * replaces the search phrases with real Tabler icons.
 */

export type LessonSceneOutcome =
  | { readonly kind: 'scene'; readonly scene: LessonScene }
  | {
      readonly kind: 'invalid';
      readonly problems: readonly string[];
      readonly diagnostic?: WorkflowErrorDiagnostic;
    };

export type GenerateLessonSceneInput = Omit<RenderResolvedLessonVisualInput, 'plan'> & {
  readonly allowedSceneTypes?: readonly LessonSceneType[];
  readonly narration?: string;
  readonly sourceProvenance?: LessonSourceProvenance;
  readonly plan?: RenderResolvedLessonVisualInput['plan'];
  /** Starts independent preparation after validation, while icons are chosen. */
  readonly onValidatedScene?: (scene: LessonScene) => void;
};

const SceneIconQueriesSchema = z.strictObject({
  object: z.string(),
  action: z.string(),
  concept: z.string(),
});

const diagramShape = LESSON_SCENE_REGISTRY.flowchart.schema.shape.diagram.unwrap().shape;
const node = diagramShape.nodes.element.shape;
const edge = diagramShape.edges.element.shape;

const SceneDiagramSchema = z.strictObject({
  nodes: z.array(z.strictObject({ id: node.id, label: node.label, kind: node.kind })),
  edges: z.array(
    z.strictObject({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      kind: edge.kind,
      evidence: edge.evidence,
    })
  ),
});

// Key order is the generation order: the model states its intent and evidence before the form.
const SceneDraftFormShape = LessonSceneSchema.omit({
  type: true,
  title: true,
  body: true,
  items: true,
  groups: true,
  quote: true,
  note: true,
  criteria: true,
  relation: true,
  diagram: true,
  durationMs: true,
  panels: true,
  icon: true,
}).shape;

const draftItemShape = {
  label: z.string(),
  detail: z.string(),
  value: z.number().nullable(),
  time: z.number().nullable(),
  iconQueries: SceneIconQueriesSchema,
};

const SceneDraftSchema = z.strictObject({
  intent: z.string(),
  evidence: z.string(),
  type: z.enum(GENERATABLE_LESSON_SCENE_TYPES),
  title: z.string(),
  body: z.string(),
  items: z.array(
    z.strictObject({
      ...draftItemShape,
      ...LessonSceneSchema.shape.items.element.pick({
        id: true,
        parent: true,
        start: true,
        end: true,
        x: true,
        y: true,
      }).shape,
    })
  ),
  groups: z.array(
    z.strictObject({
      label: z.string(),
      items: z.array(z.string()),
      iconQueries: z.array(SceneIconQueriesSchema),
      verdict: z.enum([...LESSON_SCENE_VERDICTS, 'none']),
      details: z.array(z.string()).optional(),
      groupIconQueries: SceneIconQueriesSchema.optional(),
    })
  ),
  criteria: z.array(z.string()),
  quote: z.string(),
  note: z.string(),
  relation: z
    .strictObject({
      kind: z.enum(LESSON_SCENE_RELATION_KINDS),
      label: z.string(),
      evidence: z.string(),
    })
    .nullable(),
  diagram: SceneDiagramSchema.nullable(),
  ...SceneDraftFormShape,
  iconQueries: SceneIconQueriesSchema.optional(),
  panels: z
    .array(
      z.strictObject({
        title: z.string(),
        kind: z.enum(['facts', 'steps']),
        evidence: z.string().optional(),
        items: z.array(
          z.strictObject({
            label: draftItemShape.label,
            detail: draftItemShape.detail,
            iconQueries: SceneIconQueriesSchema,
          })
        ),
      })
    )
    .optional(),
  cues: z.array(LessonSceneAnimationShape.cues.unwrap().element.strict()).optional(),
  steps: z
    .array(LessonSceneAnimationShape.steps.unwrap().element.strict())
    .min(GUIDED_PATH_MIN_STEPS)
    .max(GUIDED_PATH_MAX_STEPS)
    .optional(),
});

type SceneDraft = z.infer<typeof SceneDraftSchema>;

const catalogText = (types: readonly LessonSceneType[]): string =>
  types.map(type => `- ${type}: ${LESSON_SCENE_CATALOG[type]}`).join('\n');

const sceneSystemPrompt = (
  types: readonly LessonSceneType[]
) => String.raw`Design the visual scene that accompanies one concept of a lesson for adults. First state the reader's task: what must the reader understand? Then choose the semantic relation (definition, distinction, comparison by a criterion, check, sequence, limit, question) and only then choose the form from the catalog. Use only the lesson text. Preserve negations, scope, conditions, and uncertainty. All visible text uses the lesson language. Show the passage's structure, relationships or quantities with concise labels. A process needs its actual steps or flow. Never make a text-repeat card or copy narration sentences into the visual; captions already show the narration.

FIELDS
- intent: one concrete sentence about the reader's task; never shown.
- evidence: an EXACT quotation from the lesson that supports the scene's message.
- title: at most 7 words; it states the topic or the criterion.
- body: only an essential condition needed to read the visual; never summarize the narration or restate a definition already explained in captions, otherwise "".
- items: {label (at most 6 words), detail (at most 15 words, or ""), value (a number only for quantitative forms, else null), time (line only: the point's position in time as a number written in the lesson, such as a year; else null), iconQueries}.
- groups: {label, items (each a self-contained phrase), iconQueries (one per item, same order), verdict ("prefer", "avoid", or "none")}.
- quote: an EXACT quotation from the lesson; in decision forms it is the main question, otherwise only an essential closing question; default "".
- note: one necessary limit in at most 18 words; default "".
- criteria: row labels for matrix, otherwise [].
- relation: for comparison and signals with two genuinely related terms, {kind, label, evidence}; otherwise null. kind is greater, less, different, equal, versus, or leads. label is only read by screen readers. evidence is an exact quotation (may be "" for versus). Use different only for an explicit distinction and leads only for an explicit process or consequence. Do not impose a winner when the lesson asks the reader to choose.
- diagram: for flowchart, sequence, and journey only, {nodes: [{id, label, kind}], edges: [{from, to, label, kind, evidence}]}; otherwise null. 2 to 8 nodes, 1 to 12 connections. Node kind is step, decision, start, or end; edge kind is call, return, or event. Every connection carries an EXACT lesson quotation in evidence. Decision branches carry their condition in the label. A sequence keeps message order and distinguishes returns and asynchronous events; a journey follows its nodes in order without branches. Never write SVG, coordinates, CSS, or Mermaid code.
- proportional: items and groups []; supply autoplay, inputLabel, unitLabel, min, max, initial (integers, 1 <= min <= initial <= max), positive amountPerUnit, outputUnit, outputLabel, assumption. The fixed renderer multiplies quantity by amountPerUnit. Use only quantities and a proportional relation stated in the lesson. Optional cues are {anchor, value}: increasing cumulative quantities ending at max.
- formula-spotlight: items and groups []; formula is complete LaTeX with explicit \nousSymbol{id} references, not HTML or CSS. symbols is an ordered array of {id,latex,name,meaning,anchor}. Each id is a letter followed by letters or digits. Replace the original symbol with its reference, never append the reference after the glyph. Substituting every reference with its latex must reproduce the authored formula without adding or removing operators. Every symbol occurs through its reference in formula (including repeated occurrences); explain every symbol in natural language. Bare mathematical identifiers are invalid, including subscripts and macro-expanded identifiers; an operator with its own symbol entry must use its reference at every occurrence. Keep symbols with distinct meanings separate, including an operator and its operands. Bind each anchor to the narration explaining that exact symbol, not adjacent text. Each nonempty anchor is an exact, unique narration quotation covering only the words that refer to that element; stop at the end of that reference. Use an empty anchor when the narration does not specifically refer to that element. Keep the base, subscript, superscript and operator independently targetable whenever the narration distinguishes them: x and its index i use separate references, never a single x_i target for a mention of i. List linked symbols by their first spoken mention; unlinked symbols may follow. The fixed renderer shows the complete formula and symbol names and emphasizes a linked element only for its quoted span; nothing stays emphasized between references. Include every authored term discussed in the canonical narration, including all indices, conditions, arguments and operators. Choose this form when a large formula and its definitions teach the passage; do not select by formula count or keyword. Prefer a useful visual over repeating prose; retain the source meaning and conditions.
- guided-path: items and groups []; supply autoplay and steps: ${GUIDED_PATH_MIN_STEPS} to ${GUIDED_PATH_MAX_STEPS} {label, detail, optional anchor} entries following the explicit path in the lesson. Every label and detail is non-empty.
- Animated forms reuse title and body as the prototype's title and description. Set autoplay true for gradual reader playback. Narration and cue anchors quote the canonical narration when supplied, otherwise the lesson text. Ground quantities and other facts in the lesson text. Supply data only, never executable formulas, scripts, CSS, coordinates, or animation code. The formula-spotlight LaTeX field is mathematical notation, not executable code.
- Additional static forms use their own fields and replace the preceding items/groups constraints. Their field instructions appear below. Items may also carry id, parent, start, end, x, or y for those forms. A group's optional details has one short description per entity. Optional groupIconQueries chooses a group's heading icon; optional top-level iconQueries chooses the center icon. Both use the same three search phrases as item iconQueries.

ANIMATED SCENE SELECTION
${interactiveSelectionRules}

CLOSING TEXT
${LESSON_SCENE_CLOSING_TEXT_RULE}

ICON SEARCH PHRASES
For every item and every group entry write iconQueries with three short English phrases (2 to 5 words) for a generic icon library: object names a common everyday object that symbolises the entry (prefer widely used symbols such as graduation cap, building, star, magnifying glass over specific professions or scenes); action names the action involved; concept names the abstract idea in plain words. When the entry negates or excludes something, describe the negation or absence. Diagram forms have no items and no groups.
Composition panel items use the same iconQueries mechanism. Group entities and optional group or center icons also use this mechanism; supply search phrases rather than icon names. Interpret the whole phrase: a clock represents time, not a generic request; an HTTP method does not represent a response code, and a geographic place does not represent a data field named destination without that meaning in the lesson.

VISUAL ORDER
In grids and lists of independent elements, order elements by their first mention in the text: left to right, then top to bottom. Appearances and emphasis follow the same order; do not start with an element below or to the right. Elements mentioned together retain their relative order. Preserve chronological orders, hierarchies, axes, and directional or mathematical relations: do not move the terms of greater, less, or consequence to fit the narration.

MEANING STRUCTURE
A line break does not represent a relationship. Before filling a group, decide whether its entries are parts of ONE description or distinct entities. For one description, write a natural sentence with a conjunction when needed, preserving essential facts. For distinct entities, give each a name, its own iconQueries, and a distinct graphical element; make convergence, branching, and membership visible. Do not hide different actors in "name: action" lines under a generic title such as Usage. For multiple inputs into an archive followed by multiple recipients, use integration: sources converge on the center, then recipients separate. Components merely hosted together can be described as "API and service"; when their roles are being explained, show them separately. Apply this distinction to every form. Labels and values belong to their described element; avoid separate numbered legends when direct labels fit. Notes explain only substantial limits or assumptions. Group reasons under the subject they belong to. Each group item is a real list entry: a self-contained, concrete phrase, never a phrase split into slogans.

WRITING
Use 2 to 4 elements when needed; never fill space. A label identifies a concept; a detail explains it with ONE idea in a natural sentence. Brevity comes from choosing the message, never from piling up terms. Do not compress different dimensions with slashes, semicolons, parentheses, or noun strings. Keep one criterion, consistent with the title, for all entries. Do not repeat the title in details. Do not add usefulness, causes, or facts absent from the lesson. Avoid meta-textual labels and editorial instructions. Before answering, reread every subtext: is it understandable without reconstructing a relation between scattered words?
Word limits are maxima, not targets. Bad example: "Preservation process, data/operational; indirect impact. Query, procedure and migration test". If the criterion is who is involved, write "The change also involves the preservation process". If the criterion is how to verify it, write "Verify the migration with a test". Choose the criterion consistent with the title and keep it for every entry. When several facts are indispensable, separate them into explicitly labelled entries or columns; otherwise select the fact that helps the reader understand the passage. Other information remains in the lesson text. Apply the same rule to body, note, and groups. Always preserve the conditions and negations needed to make the sentence true.

FORMS
- ${LESSON_SCENE_INDEPENDENT_CONTENT_RULE}
- Make the layout mirror the logical relations the lesson states: parallel criteria, factors, or options sit side by side in one form (checklist, parts, comparison); only steps the lesson explicitly orders become steps or a sequence. Never chain parallel items as consecutive steps.
- checklist: concrete questions in labels, details only when they add information. limits: two items meaning "Shows" and "Does not prove", in the lesson language. roles: people as items with a neutral profile. steps: strictly ordered actions, not alternatives; options after a pause become a checklist with the pause in body.
- comparison, signals, matrix, decision, balance, and beforeafter need exactly two non-empty groups. matrix also needs criteria, with as many rows in both groups. The other original forms need at least two items, except number, flowchart, sequence, journey, proportional, and guided-path; diagram and animated forms keep items and groups []. Additional static forms and composition follow their own bounds below.
- For hierarchies and networks the title names the common node. Do not use maps, cycles, or timelines for plain lists. beforeafter needs an actual transformation; a mere preference between two behaviours is a comparison with verdicts.
- Quantitative forms only with REAL numbers present in the lesson, never invented scores. Each numeric item has a finite value >= 0 and a label with unit or period. interval has exactly three items: minimum, estimate, maximum. line points carry increasing times, which set their real spacing; the label shows how the lesson names each time. number has one item. HTTP codes, versions, and identifiers are not quantities.
- A message exchange with replies and branches is a sequence, not an invented causal chain.
- For comparison and signals, the symbol alone connects the groups: their labels must be comparable terms read left to right, never headings such as "More weight" and "Not enough". Put qualifications about reasonable trust in note, not body before the comparison. The scene title establishes the criterion: for example "What deserves more weight?", with "Verifiable competence" > "Mere appearance". Use different only for an explicit distinction, never for two arbitrarily different lists.
- Group summary example: "Verifiable competence" has entries "Experience with the question at hand" and "Reasons that can be checked"; "Mere appearance" has "Professional title" and "Confident tone". Entries articulate the subject rather than repeating its label in an almost identical sentence. For signals, short names suffice: "Professional title", rather than repeating "may indicate competence" in every entry. Compare signs with their limits using versus; distinguish signs from evidence using different with homogeneous terms. Never fill an Evidence column with limits of signs.
- For source, the first item identifies the source; the others state its competence and relevance to the request, each with a criterion label and concrete detail. A concluding question belongs in quote, an additional limit in note. If one choice is explicitly discouraged and another recommended, group verdicts may be avoid and prefer; never assign verdicts to a quiz.
- Keep quizzes open without suggesting the answer. Supplied code is teaching material: represent its boundaries and relations without executing it. Never invent transitions, branches, emotions, scores, usefulness, or causes.

ADDITIONAL STATIC FORMS
These forms have a title of at most 160 characters, optional body and note of at most 600 characters, at most 12 items (label at most 160 characters, detail at most 240), and at most 6 groups with at most 6 entries each. Groups containing multiple entities need complete iconQueries, one per entity. Colours and geometry belong to the component: never invent palettes, per-entry styles, or colour variations. A different colour requires a necessary semantic distinction. These forms are static: no motion fields, timer, or user commands. Keep every description brief and understandable. Never invent permissions, deadlines, causal categories, or values to fit a form.
- quadrant: exactly four groups, in top-left, top-right, bottom-left, bottom-right order; xLabel and yLabel explain the axes.
- radar/polar: 3–6 items with real non-negative value, at least one positive value, a common positive max, and explicit unit; no value exceeds max.
- flywheel: 3–6 ordered items and center (at most 80 characters), only for a real cycle.
- tree: items with unique id (at most 40 characters), optional parent, exactly one root, acyclic, at most three levels.
- stack/process: 2–6 ordered items. Stack separates levels without implying containment; process preserves successive stages and their owner or result.
- venn: three groups (left only, intersection, right only), with qualitative areas; each label at most 24 characters and at most one description of at most 48 characters per region. If the content does not fit, choose comparison rather than making the text ambiguous.
- funnel/treemap: items with value and explicit unit; funnel values never increase, treemap values are positive. For funnel, the title identifies the common quantity or entity once (for example Requests); labels contain only stage names (Received, Valid, Successful), without repeating units or numbers. The component shows quantities and retention on a common cell scale, including fractions; never draw or count cells yourself.
- heatmap/security: columns:[labels], rows:[{label,values:[values]}], 1–5 columns and 1–8 rows; every row has as many values as columns. heatmap requires positive max and explicit unit, with values between zero and max. security requires an explicit textual permission (at most 60 characters) in every cell, including unknown permissions.
- gantt: items with finite numeric start/end, end greater than start, and a common explicit unit.
- scatter: items with finite numeric x/y, xLabel/yLabel including units, and explicit unit.
- integration: two groups (sources, recipients), center, and optional top-level iconQueries for its icon. Each group contains entity names in items, mandatory matching iconQueries, and optional details with one description per entity (at most 120 characters). Each side allows 1–2 entities; use flowchart for more branches.
- deployment: 2–4 groups; use one item for a coherent description, or separate entities with an iconQueries entry for each. Optional groupIconQueries represents the execution container.
- proportional-static: integer quantity 1–12, positive amountPerUnit, and explicit unit; only explicit data. Every quantitative static form requires unit (at most 80 characters).

RELATIONSHIPS
Choose the relationship before the form. Two alternatives are not before/after: beforeafter requires the same object in two temporal states. Reducing a dependency does not mean it is smaller than another: greater/less require an explicit common criterion. Properties and contracts are not processes. Preserve alternatives expressed with OR as alternatives, never simultaneous activities. Do not invent messages or branches. For a condition, use decision with the question in body; limits means what can be concluded from an example, not any two categories.

COMPOSITION
Choose composition when comparing two alternatives and one has an indispensable internal sequence that a simple list would hide. Do not hide an explicit, relevant sequence in a note or a generic entry: retain its steps in the steps panel. Supply items:[], groups:[], body:"", quote:"", note, and panels:[{title,kind:"facts"|"steps",items:[{label,detail,iconQueries}],evidence}]. Exactly two panels with different forms: one facts and one steps; two facts lists become comparison. At most two levels, with 1–4 items per panel and at least two steps in a steps panel. Panel titles and item labels are at most 160 characters; details at most 600. The steps panel's evidence is an EXACT quotation documenting their order. Each step is a real successive action or state: a negation, requirement, or property is not a step, and a mere enumeration does not prove temporal order. facts contains independent properties. Do not repeat panel content in note. No nested panels, code, or coordinates. Each panel item uses ordinary iconQueries. Composition preserves different internal relationships; it is not a way to vary appearance when two simple lists already explain the concept.

CATALOG
${catalogText(types)}

Final check: does every sentence under a title add something? Are the entries of each group truly examples of that group? Evidence entries must be evidence, never reasons to doubt signs. If the passage provides only signs and limits, use "Visible signs" and "Limits of signs" with versus, or limits. Do not invent evidence to fill a comparison. An attribute repeated for every item moves to body or note. Can the closing text be omitted without losing necessary meaning? If yes, leave it empty. Every note must be necessary; avoid generic warnings such as "often, not always".`;

const MALFORMED_ANSWER_PROBLEM = 'The answer must follow the requested JSON structure.';

const buildScenePrompt = (input: GenerateLessonSceneInput): string => {
  const correction = input.retryFeedback?.trim()
    ? `\nRequired correction from the previous attempt:\n${input.retryFeedback.trim()}\n`
    : '';
  const provenance = input.sourceProvenance
    ? `Source provenance: ${JSON.stringify(input.sourceProvenance)}`
    : '';
  return `Lesson: ${input.sectionTitle}
Description: ${input.sectionDescription}
${provenance}
${
  input.plan
    ? `Planned visual: ${JSON.stringify({
        anchorHeading: input.plan.anchorHeading,
        concept: input.plan.concept,
        factualRequirements: input.plan.factualRequirements,
        pedagogicalGoal: input.plan.pedagogicalGoal,
        title: input.plan.title,
        visualDirection: input.plan.visualDirection,
      })}`
    : ''
}
${correction}
${input.narration ? `TARGET PASSAGE / CANONICAL NARRATION (copy symbol and animation cue anchors exactly from this text):\n${input.narration}\nThe authored context below may supply details referred to by this passage, such as the steps following an introduction. Illustrate this passage's concept, preserving the complete referenced relationship; do not substitute a neighboring topic.\n` : ''}
${input.lessonMarkdown.length > MAX_VISUAL_LESSON_CHARS ? 'LESSON EXCERPT (truncated; only this excerpt is available for analysis):' : 'LESSON TEXT:'}
${input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}`;
};

const toScene = (draft: SceneDraft): LessonScene => ({
  ...Object.fromEntries(
    Object.keys(SceneDraftFormShape)
      .filter(key => draft[key as keyof SceneDraft] !== undefined)
      .map(key => [key, draft[key as keyof SceneDraft]])
  ),
  body: draft.body,
  ...(draft.criteria.length ? { criteria: draft.criteria } : {}),
  ...(draft.diagram && LESSON_SCENE_DIAGRAM_TYPES.has(draft.type)
    ? { diagram: draft.diagram }
    : {}),
  groups: draft.groups.map(group => ({
    icons: group.items.map(() => ''),
    items: group.items,
    label: group.label,
    ...(group.details ? { details: group.details } : {}),
    ...(group.groupIconQueries ? { icon: '' } : {}),
    ...(group.verdict === 'none' ? {} : { verdict: group.verdict }),
  })),
  items: draft.items.map(item => ({
    detail: item.detail,
    icon: '',
    label: item.label,
    ...(item.time === null ? {} : { time: item.time }),
    ...(item.value === null ? {} : { value: item.value }),
    ...Object.fromEntries(
      ['id', 'parent', 'start', 'end', 'x', 'y']
        .filter(key => item[key as keyof typeof item] !== undefined)
        .map(key => [key, item[key as keyof typeof item]])
    ),
  })),
  ...(draft.iconQueries && draft.center?.trim() ? { icon: '' } : {}),
  ...(draft.panels
    ? {
        panels: draft.panels.map(panel => ({
          title: panel.title,
          kind: panel.kind,
          ...(panel.evidence !== undefined ? { evidence: panel.evidence } : {}),
          items: panel.items.map(item => ({ label: item.label, detail: item.detail, icon: '' })),
        })),
      }
    : {}),
  note: draft.note,
  quote: draft.quote,
  ...(draft.relation ? { relation: draft.relation } : {}),
  title: draft.title,
  type: draft.type,
});

const iconEntries = (draft: SceneDraft): SceneIconEntry[] => [
  ...draft.items.map((item, index) => ({
    queries: item.iconQueries,
    slot: { item: index, kind: 'item' as const },
    text: item.detail ? `${item.label} — ${item.detail}` : item.label,
  })),
  ...draft.groups.flatMap((group, groupIndex) =>
    group.items.map((entry, entryIndex) => ({
      queries: group.iconQueries[entryIndex] ?? { action: entry, concept: entry, object: entry },
      slot: { entry: entryIndex, group: groupIndex, kind: 'group' as const },
      text: `${group.label}: ${entry}`,
    }))
  ),
  ...draft.groups.flatMap((group, groupIndex) =>
    group.groupIconQueries
      ? [
          {
            queries: group.groupIconQueries,
            slot: { group: groupIndex, kind: 'group-icon' as const },
            text: group.label,
          },
        ]
      : []
  ),
  ...(draft.iconQueries && draft.center?.trim()
    ? [
        {
          queries: draft.iconQueries,
          slot: { kind: 'center' as const },
          text: draft.center as string,
        },
      ]
    : []),
  ...(draft.panels ?? []).flatMap((panel, panelIndex) =>
    panel.items.map((item, index) => {
      const detail = item.detail ? ` — ${item.detail}` : '';
      return {
        queries: item.iconQueries,
        slot: { item: index, panel: panelIndex, kind: 'panel' as const },
        text: `${panel.title}: ${item.label}${detail}`,
      };
    })
  ),
];

// Support quotations carry no offsets; source line wrapping does not change their words.
const supportQuotationText = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();

const findDraftProblems = (
  draft: SceneDraft,
  scene: LessonScene,
  source: string,
  narration?: string
): string[] => [
  ...(isAnimatedLessonScene(scene) && scene.autoplay !== true
    ? ['Generated animated scenes must enable autoplay.']
    : []),
  ...(draft.evidence.trim() &&
  supportQuotationText(source).includes(supportQuotationText(draft.evidence))
    ? []
    : ['evidence must be an exact quotation from the lesson.']),
  ...(draft.groups.every(group => group.iconQueries.length === group.items.length)
    ? []
    : ['Every group needs one iconQueries entry per item.']),
  ...(hasConflictingLessonSceneClosingText(scene)
    ? ['Use either an essential closing question or a necessary note, or leave both empty.']
    : []),
  ...findLessonSceneProblems(scene, source, narration),
];

/** Generates and validates one lesson scene, then chooses its icons. */
export function generateLessonScene(
  input: GenerateLessonSceneInput & { allowTextFallback: true }
): Promise<LessonSceneOutcome | { readonly kind: 'text' }>;
export function generateLessonScene(input: GenerateLessonSceneInput): Promise<LessonSceneOutcome>;
export async function generateLessonScene(
  input: GenerateLessonSceneInput & { allowTextFallback?: boolean }
): Promise<LessonSceneOutcome | { readonly kind: 'text' }> {
  // Scenes replace the artifact pipeline, so they run on the provider resolved for this run's
  // visuals (the learner's provider), while scene models come from the live configuration.
  const config = await getResolvedModelConfigForProvider(input.config.artifact.provider);
  // A resumed workflow must generate within the catalog admitted by its saved contract.
  // Spotlight definitions need the owning playback's canonical speech, not raw Markdown anchors.
  const types = (input.allowedSceneTypes ?? GENERATABLE_LESSON_SCENE_TYPES).filter(
    type =>
      GENERATABLE_LESSON_SCENE_TYPES.includes(type) &&
      (type !== 'formula-spotlight' || input.narration !== undefined)
  );
  const schema = SceneDraftSchema.extend({
    type: z.enum(input.allowTextFallback ? [...types, 'text'] : types),
  });
  const { $schema: _dialect, ...outputSchema } = z.toJSONSchema(schema);
  // Malformed output surfaces either as an error or as JSON of the wrong shape; both become
  // corrective feedback for the next attempt.
  let outputPath: 'direct' | 'json-envelope' | 'unavailable' = 'unavailable';
  const diagnostic = (stage: 'schema' | 'domain', problems: unknown) =>
    toWorkflowErrorDiagnostic(new Error(JSON.stringify({ outputPath, stage, problems })));
  const response = await generateStructuredOutput<unknown>({
    sourceAware: Boolean(input.sourceProvenance),
    onOutputPath: path => {
      outputPath = path;
    },
    config,
    output: { name: 'lesson_scene', schema: outputSchema },
    prompt: buildScenePrompt(input),
    signal: input.signal,
    slot: 'scene',
    system: `${sceneSystemPrompt(types)}${input.allowTextFallback ? '\nTEXT FALLBACK: When no catalog visual helps this passage, explicitly choose type text with empty items/groups and an exact supporting evidence quotation. The complete authored passage remains in captions. The visual panel shows its sourced mathematics when present and otherwise stays empty. This choice is yours; never force a formula spotlight when it does not fit.' : ''}\n\n${INTERNAL_FAST_TASK_INSTRUCTION}`,
  }).catch(error => {
    input.signal.throwIfAborted();
    if (!isInvalidLessonVisualStructuredOutput(error)) throw error;
    return null;
  });
  const parsed = schema.safeParse(response);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      problems: [MALFORMED_ANSWER_PROBLEM],
      diagnostic: diagnostic(
        'schema',
        parsed.error.issues.map(({ code, path }) => ({ code, path }))
      ),
    };
  }
  if (parsed.data.type === 'text') {
    return parsed.data.evidence.trim() &&
      supportQuotationText(input.lessonMarkdown).includes(
        supportQuotationText(parsed.data.evidence)
      )
      ? { kind: 'text' }
      : { kind: 'invalid', problems: ['Text fallback needs exact source evidence.'] };
  }
  const draft = { ...parsed.data, type: parsed.data.type };
  const scene = toScene(draft);
  const problems = findDraftProblems(
    draft,
    scene,
    input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS),
    input.narration
  );
  if (problems.length)
    return {
      kind: 'invalid',
      problems,
      diagnostic: diagnostic(
        'domain',
        problems.map(problem => {
          // These validator templates interpolate private model labels; retain only the contract.
          if (problem.startsWith('The connection "'))
            return 'A diagram connection needs an exact quotation from the lesson.';
          if (problem.startsWith('Times must appear in the lesson:'))
            return 'Times must appear in the lesson.';
          if (problem.startsWith('Quantitative values must appear in the lesson:'))
            return 'Quantitative values must appear in the lesson.';
          return problem;
        })
      ),
    };
  input.onValidatedScene?.(scene);
  return {
    kind: 'scene',
    scene: await chooseLessonSceneIcons({
      config,
      entries: iconEntries(draft),
      scene,
      signal: input.signal,
    }),
  };
}
