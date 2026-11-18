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
  LESSON_SCENE_LIMITS,
  LESSON_SCENE_REGISTRY,
  LESSON_SCENE_RELATION_KINDS,
  LESSON_SCENE_VERDICTS,
  type LessonScene,
  type LessonSceneRelationKind,
  LessonSceneSchema,
  type LessonSceneType,
  PROCESS_SCENE_MAX_STAGES,
  selectableLessonSceneTypes,
  supportsComparisonRelations,
} from '@shared/lessonScene';
import { interactiveSelectionRules } from '@shared/lessonSceneAnimation';
import {
  LESSON_SCENE_CLOSING_TEXT_RULE,
  LESSON_SCENE_INDEPENDENT_CONTENT_RULE,
} from '@shared/lessonVisualContracts';
import { LESSON_MATH_DELIMITERS_RULE } from '@shared/lessonWritingContract';
import remarkMath from '@shared/remarkPandocMath';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
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
  readonly allowedSceneRelationKinds?: readonly LessonSceneRelationKind[];
  readonly allowedSceneTypes?: readonly LessonSceneType[];
  readonly supportsConceptLayout?: boolean;
  readonly useOrderedSceneSelection?: boolean;
  readonly useClosedLoopSelection?: boolean;
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
  conceptLayout: true,
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

const ConceptSceneDraftSchema = SceneDraftSchema.extend({
  conceptLayout: LessonSceneSchema.shape.conceptLayout,
});
const BoundarySceneDraftSchema = ConceptSceneDraftSchema.extend({
  scopeEvidence: z.string().optional(),
  groups: SceneDraftSchema.shape.groups.element
    .extend({
      scopeSide: z.enum(['inside', 'outside']).optional(),
    })
    .array(),
});
type SceneDraft = z.infer<typeof BoundarySceneDraftSchema>;

const selectDraftSchema = (types: readonly LessonSceneType[], supportsConceptLayout: boolean) => {
  if (!supportsConceptLayout) return SceneDraftSchema;
  return types.includes('boundary') ? BoundarySceneDraftSchema : ConceptSceneDraftSchema;
};

const conceptLayoutRules = `- concepts: use items and leave groups empty. Omit conceptLayout for a vertical described list. Set conceptLayout to grid for equally important parts or independent calculations. Keep the same item order at all widths. Preserve concise item-specific details needed to read the grid. For one scope, name the scope in the title and list what belongs to it. For a counterexample, label the rule and the case in the lesson language and show which condition fails. For limits, name what the observation shows and what it cannot establish in the item labels.
- Set conceptLayout to roles for people or system components with distinct responsibilities. Each item label names the actor or role, and its detail gives the responsibility. Supply an icon for each actor.
- Set conceptLayout to featured when the first item is the principal entity. For a source, the first item identifies the source and the remaining items name its attributes, such as scope and relevance, with their details. For an argument, state the thesis in the title with an evidence list or place it in the featured first item and label the subsequent items as supporting evidence. Use comparison for evidence that teaches an explicit comparative relation. State the names and relationships visibly in the lesson language.`;

const legacyConceptRules = (types: readonly LessonSceneType[]) =>
  [
    types.includes('limits') &&
      '- limits: two items meaning "Shows" and "Does not prove", in the lesson language.',
    types.includes('roles') && '- roles: people as items with a neutral profile.',
    types.includes('source') &&
      '- source: the first item identifies the source. The others state its competence and relevance with a criterion label and concrete detail.',
  ]
    .filter(Boolean)
    .join('\n');

const sceneVariantFamilies = {
  'proportional-static': 'proportional',
} as const satisfies Partial<Record<LessonSceneType, LessonSceneType>>;

const sceneVariants = Object.keys(sceneVariantFamilies) as (keyof typeof sceneVariantFamilies)[];

type SceneSelection = Required<
  Pick<
    GenerateLessonSceneInput,
    'supportsConceptLayout' | 'useOrderedSceneSelection' | 'useClosedLoopSelection'
  >
>;

const catalogText = (
  types: readonly LessonSceneType[],
  variants: readonly (typeof sceneVariants)[number][],
  { supportsConceptLayout, useClosedLoopSelection }: SceneSelection
): string =>
  types
    .map(type => {
      if (type === 'flywheel' && !useClosedLoopSelection) {
        return '- flywheel: Un ciclo esplicito che aggiorna un elemento comune.';
      }
      const choices = variants
        .filter(variant => sceneVariantFamilies[variant] === type)
        .map(variant => ` Variant ${variant}: ${LESSON_SCENE_CATALOG[variant]}`);
      const description =
        type === 'boundary' && !supportsConceptLayout
          ? 'Name a scope and list at least two items it contains.'
          : LESSON_SCENE_CATALOG[type];
      return `- ${type}: ${description}${choices.join('')}`;
    })
    .join('\n');

const orderedStageRules = (
  types: readonly LessonSceneType[],
  useOrderedSceneSelection: boolean
) => {
  const { minItems, items: compactLimit } = LESSON_SCENE_LIMITS;
  const processLimit = useOrderedSceneSelection ? PROCESS_SCENE_MAX_STAGES : compactLimit;
  const longerProcess = useOrderedSceneSelection
    ? ` Include all necessary stages even above ${compactLimit}.`
    : '';
  return [
    'ORDERED STAGES',
    "Keep the lesson's explicit order and the granularity needed for its teaching goal. Identify the actor when responsibility matters and the outcome when it explains the next stage. When both matter, keep both in the stage's label and detail. Preserve the person's perspective in a linear path. Use an item for each necessary stage and leave groups empty.",
    types.includes('process') &&
      `- process: the standard card for ordered actions, successive stages, or linear journeys. Use ${minItems}–${processLimit} labeled items with iconQueries.${longerProcess}`,
    types.includes('steps') &&
      `- steps: use the compact numbered reference when the reader needs a short list of ordered actions and ordinal numbers and text are enough. Use ${minItems}–${compactLimit} items.`,
  ]
    .filter(Boolean)
    .join('\n');
};

const flywheelContract = (useClosedLoopSelection: boolean): string =>
  useClosedLoopSelection
    ? '2–6 ordered items, only when the last station explicitly leads to the first. Keep each necessary station detail with that item. If a cycle of 3–6 stations explicitly updates a shared subject, put that subject in center (at most 80 characters). Leave center absent for an ordinary repeating sequence.'
    : '3–6 ordered items and center (at most 80 characters), only for a real cycle.';

const sceneSystemPrompt = (
  types: readonly LessonSceneType[],
  variants: readonly (typeof sceneVariants)[number][],
  relationKinds: readonly LessonSceneRelationKind[],
  selection: SceneSelection
) => {
  const { supportsConceptLayout, useOrderedSceneSelection, useClosedLoopSelection } = selection;
  const comparisonConsolidated =
    types.includes('comparison') && supportsComparisonRelations(relationKinds);
  const comparisonForms = comparisonConsolidated
    ? 'comparison, matrix, decision, and beforeafter'
    : 'comparison, signals, matrix, decision, balance, and beforeafter';
  const comparisonTargets = comparisonConsolidated ? 'comparison' : 'comparison and signals';
  const relationKindRule = comparisonConsolidated
    ? `Available kinds: ${relationKinds.join(', ')}.`
    : 'kind is greater, less, different, equal, versus, or leads.';
  return String.raw`Design the visual scene that accompanies one concept of a lesson for adults. First state the reader's task: what must the reader understand? Then choose the semantic relation (parts and whole, distinction, comparison by a criterion, check, sequence, limit, question) and only then choose the form from the catalog. Use only the lesson text. Preserve negations, scope, conditions, and uncertainty. All visible text uses the lesson language. Show the passage's structure, relationships or quantities with concise labels. A process needs its actual steps or flow. Never make a text-repeat card or copy narration sentences into the visual; captions already show the narration.

${LESSON_MATH_DELIMITERS_RULE}

FIELDS
- intent: one concrete sentence about the reader's task; never shown.
- evidence: an EXACT quotation from the lesson that supports the scene's message.
- title: at most 7 words; it states the topic or the criterion.
- body: only an essential condition needed to read the visual; never summarize the narration or restate a definition already explained in captions, otherwise "".
- items: {label (at most 6 words), detail (at most 15 words, or ""), value (a number only for quantitative forms, else null), time (line only: the point's position in time as a number written in the lesson, such as a year; else null), iconQueries}.
- groups: {label, items (each a self-contained phrase), iconQueries (one per item, same order), verdict ("prefer", "avoid", or "none")}.
- quote: an EXACT quotation from the lesson; for type decision, it is the main question. For other types it is only an essential closing question distinct from the scene content. Default "".
- note: one necessary limit in at most 18 words; default "".
- criteria: row labels for matrix, otherwise [].
- relation: for ${comparisonTargets} with two genuinely related terms, {kind, label, evidence}; otherwise null. ${relationKindRule} label is only read by screen readers. evidence is an exact quotation (may be "" for versus). Use different only for an explicit distinction and leads only for an explicit process or consequence. Do not impose a winner when the lesson asks the reader to choose.
- diagram: for flowchart, sequence${types.includes('journey') ? ', and journey' : ''} only, {nodes: [{id, label, kind}], edges: [{from, to, label, kind, evidence}]}; otherwise null. 2 to 8 nodes, 1 to 12 connections. Node kind is step, decision, start, or end; edge kind is call, return, or event. Every connection carries an EXACT lesson quotation in evidence. Decision branches carry their condition in the label. In a sequence, nodes name participants and edges name their messages; never put actions or sentences in participant boxes. A sequence keeps message order and distinguishes returns and asynchronous events.${types.includes('journey') ? ' A journey follows its nodes in order without branches.' : ''} When available, use flowchart when connections themselves must be visible, including a linear path with a meaningful transition between stages. Never write SVG, coordinates, CSS, or Mermaid code.
- Animated proportional: items and groups []; supply autoplay, inputLabel, unitLabel, min, max, initial (integers, 1 <= min <= initial <= max), positive amountPerUnit, outputUnit, outputLabel, assumption. Use this mode for a taught progression of equal groups. The renderer multiplies quantity by amountPerUnit. Use only quantities and a proportional relation stated in the lesson. Optional cues are {anchor, value}: increasing cumulative quantities ending at max.
- formula-spotlight: items and groups []; formula is complete LaTeX with explicit \nousSymbol{id} references, not HTML or CSS. symbols is an ordered array of {id,latex,name,meaning,anchor}. Each id is a letter followed by letters or digits. Replace the original symbol with its reference, never append the reference after the glyph. Substituting every reference with its latex must reproduce the authored formula without adding or removing operators. Every symbol occurs through its reference in formula (including repeated occurrences); explain every symbol in natural language. Bare mathematical identifiers are invalid, including subscripts and macro-expanded identifiers; an operator with its own symbol entry must use its reference at every occurrence. Keep symbols with distinct meanings separate, including an operator and its operands. Bind each anchor to the narration explaining that exact symbol, not adjacent text. Each nonempty anchor is an exact, unique narration quotation covering only the words that refer to that element; stop at the end of that reference. Use an empty anchor when the narration does not specifically refer to that element. Keep the base, subscript, superscript and operator independently targetable whenever the narration distinguishes them: x and its index i use separate references, never a single x_i target for a mention of i. List linked symbols by their first spoken mention; unlinked symbols may follow. The fixed renderer shows the complete formula and symbol names and emphasizes a linked element only for its quoted span; nothing stays emphasized between references. Include every authored term discussed in the canonical narration, including all indices, conditions, arguments and operators. Choose this form when a large formula and its definitions teach the passage; do not select by formula count or keyword. Prefer a useful visual over repeating prose; retain the source meaning and conditions.
- guided-path: use when revealing the active stage alongside narration or over time is necessary to understand the path. Supply autoplay and steps: ${GUIDED_PATH_MIN_STEPS} to ${GUIDED_PATH_MAX_STEPS} {label, detail, optional anchor} entries following the explicit path in the lesson. Every label and detail is non-empty. Use items and groups [].
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
A line break does not represent a relationship. Before filling a group, decide whether its entries are parts of ONE description or distinct entities. For one description, keep its facts in one visual element with concise labels and necessary conditions. For distinct entities, give each a name, its own iconQueries, and a distinct graphical element; make convergence, branching, and membership visible. Do not hide different actors in "name: action" lines under a generic title such as Usage. For multiple inputs into an archive followed by multiple recipients, use integration: sources converge on the center, then recipients separate. Components merely hosted together can be described as "API and service"; when their roles are being explained, show them separately. Apply this distinction to every form. Labels and values belong to their described element; avoid separate numbered legends when direct labels fit. Notes explain only substantial limits or assumptions. Group reasons under the subject they belong to. Each group item is a real list entry: a self-contained, concrete phrase, never a phrase split into slogans.

WRITING
Use 2 to 4 elements when needed; never fill space. Labels identify the objects, actions or values shown. A detail is an optional concise qualifier, quantity or condition, not an explanatory sentence or glossary definition. Full explanations remain in captions. Show the relationship through connections, order, comparison, grouping, quantities or symbolic structure rather than list sentences from the narration. Never copy or paraphrase a caption sentence as an item detail, body, group entry or note. Word limits are maxima, not targets.
Keep one criterion, consistent with the title, for all entries. When several facts are indispensable, separate their visual elements or columns. Preserve every condition, negation and qualification needed for accuracy. Do not add usefulness, causes or facts absent from the lesson. Do not repeat titles in details or add editorial instructions. Before answering, check that the visual teaches the source relationship through its layout and labels without requiring a second prose reading.
Diagram labels use brief entity names, symbols, quantities or messages, not explanatory clauses. Express a shared qualification once through grouping rather than repeating it under every element.

FORMS
- ${LESSON_SCENE_INDEPENDENT_CONTENT_RULE}
- Make the layout mirror the logical relations the lesson states: parallel criteria, factors, or options sit side by side; only actions the lesson explicitly orders become steps. Sequence diagrams show message exchanges between participants. Never chain parallel items as consecutive steps.
- checklist: concrete questions or practical checks in labels, including how to test a hypothesis. State the question being tested in the title or a label. Use details only when they add information. Independent options after a pause become a checklist with the pause in body.
- ${comparisonForms} need exactly two non-empty groups. matrix also needs criteria, with as many rows in both groups. Original item-based forms need at least two items, except number. Diagram and animated forms keep items and groups []. Additional static forms and composition follow their own bounds below.
${supportsConceptLayout && types.includes('concepts') ? conceptLayoutRules : ''}
${supportsConceptLayout && types.includes('boundary') ? '- boundary: use only when the passage says what is inside and outside the same scope. Copy the exact words that show this relationship into scopeEvidence. Two facts about the same place do not make a boundary. For example, books on two floors and an opening time belong in a plain concepts list. Name the scope in the title and use exactly two named, non-empty groups with no items at scene level. Mark the first group with scopeSide "inside" and the second with scopeSide "outside". Write visible labels in the lesson language. Leave scopeEvidence and scopeSide unset for other forms.' : ''}
${supportsConceptLayout ? '' : legacyConceptRules(types)}
- matrix: use short criterion and alternative labels. Each cell states the result for its criterion as a short phrase with any qualifier needed for accuracy. Use a comparison or explain the alternatives in the lesson when understanding them requires several sentences per alternative.
- For hierarchy (when offered) and network, the title names the common node. Do not use maps, cycles, or timelines for plain lists. beforeafter needs an actual transformation; a mere preference between two behaviours is a comparison with verdicts.
- Quantitative forms only with REAL numbers present in the lesson, never invented scores. Each numeric item has a finite value >= 0 and a label with unit or period. interval has exactly three items: minimum, estimate, maximum. line points carry increasing times, which set their real spacing; the label shows how the lesson names each time. number has one item. HTTP codes, versions, and identifiers are not quantities.
- A message exchange with replies and branches is a sequence, not an invented causal chain.
- For ${comparisonTargets}, the symbol alone connects the groups: their labels must be comparable terms read left to right, never headings such as "More weight" and "Not enough". Put qualifications about reasonable trust in note, not body before the comparison. The scene title establishes the criterion: for example "What deserves more weight?", with "Verifiable competence" > "Mere appearance". Use different only for an explicit distinction, never for two arbitrarily different lists.
${comparisonConsolidated ? '- For clues that should be read alongside their interpretation, use comparison with complementary and name what each side contributes. For needs in tension, use comparison with tradeoff and retain both named panels, with every indispensable entry on each side. These relations require an exact quotation and no group verdicts.\n' : ''}- Group summary example: "Verifiable competence" has entries "Experience with the question at hand" and "Reasons that can be checked"; "Mere appearance" has "Professional title" and "Confident tone". Entries articulate the subject rather than repeating its label in an almost identical sentence. ${!comparisonConsolidated ? 'For signals, short names suffice: "Professional title", rather than repeating "may indicate competence" in every entry. ' : ''}Compare signs with their limits using versus; distinguish signs from evidence using different with homogeneous terms. Never fill an Evidence column with limits of signs.
- A concluding question belongs in quote, an additional limit in note. If one choice is explicitly discouraged and another recommended, group verdicts may be avoid and prefer; never assign verdicts to a quiz.
- Keep quizzes open without suggesting the answer. Supplied code is teaching material: represent its boundaries and relations without executing it. Never invent transitions, branches, emotions, scores, usefulness, or causes.

${orderedStageRules(types, useOrderedSceneSelection)}

ADDITIONAL STATIC FORMS
These forms have a title of at most 160 characters, optional body and note of at most 600 characters, at most 12 items (label at most 160 characters, detail at most 240), and at most 6 groups with at most 6 entries each. Groups containing multiple entities need complete iconQueries, one per entity. Colours and geometry belong to the component: never invent palettes, per-entry styles, or colour variations. A different colour requires a necessary semantic distinction. These forms are static: no motion fields, timer, or user commands. Keep every description brief and understandable. Never invent permissions, deadlines, causal categories, or values to fit a form.
- quadrant: exactly four groups, in top-left, top-right, bottom-left, bottom-right order; xLabel and yLabel explain the axes.
- radar/polar: 3–6 items with real non-negative value, at least one positive value, a common positive max, and explicit unit; no value exceeds max.
- flywheel: ${flywheelContract(useClosedLoopSelection)}
- tree: items with unique id (at most 40 characters), optional parent, exactly one root, acyclic, at most three levels. Use it for a direct parent and its children as well as for deeper hierarchies. Give the root the title when both name the same thing. Keep each child's description in its own detail.
- stack: 2–6 ordered levels, without implying that one level leads to the next or contains it.
- venn: three groups (left only, intersection, right only), with qualitative areas; each label at most 24 characters and at most one description of at most 48 characters per region. If the content does not fit, choose comparison rather than making the text ambiguous.
- funnel/treemap: items with value and explicit unit; funnel values never increase, treemap values are positive. For funnel, the title identifies the common quantity or entity once (for example Requests); labels contain only stage names (Received, Valid, Successful), without repeating units or numbers. The component shows quantities and retention on a common cell scale, including fractions; never draw or count cells yourself.
- heatmap/security: columns:[labels], rows:[{label,values:[values]}], 1–5 columns and 1–8 rows; every row has as many values as columns. heatmap requires positive max and explicit unit, with values between zero and max. security requires an explicit textual permission (at most 60 characters) in every cell, including unknown permissions.
- security: use brief, unambiguous permission phrases and keep the lesson's full role and resource names where shortening them would obscure the meaning.
- gantt: items with finite numeric start/end, end greater than start, and a common explicit unit.
- scatter: items with finite numeric x/y, xLabel/yLabel including units, and explicit unit.
- integration: two groups (sources, recipients), center, and optional top-level iconQueries for its icon. Each group contains entity names in items, mandatory matching iconQueries, and optional details with one description per entity (at most 120 characters). Each side allows 1–2 entities; use flowchart for more branches.
- deployment: 2–4 groups; use one item for a coherent description, or separate entities with an iconQueries entry for each. Optional groupIconQueries represents the execution container.
- Fixed proportional: use a fixed number of equal groups for a completed product, such as three trays with two seedlings per tray. ${variants.includes('proportional-static') ? 'Return type "proportional" and variant "proportional-static". ' : ''}Supply integer quantity 1–12, positive amountPerUnit, and unit. Keep items and groups empty. Omit animation fields, including min, max, initial, cues and outputUnit. Every quantitative static form requires unit (at most 80 characters).

RELATIONSHIPS
Choose the relationship before the form. Two alternatives are not before/after: beforeafter requires the same object in two temporal states. Reducing a dependency does not mean it is smaller than another: greater/less require an explicit common criterion. Properties and contracts are not processes. Preserve alternatives expressed with OR as alternatives, never simultaneous activities. Do not invent messages or branches. For a source-supported conditional flow, even a single fork, put the question only in the flowchart's decision node. Put each condition on its edge and the action or result with its necessary detail in the destination node. Keep any explicit return edge. Use decision panels for two answers with independent facts that need to stay grouped. For type decision, put the exact main question in quote, or use body to phrase it when the scene is uncaptioned. Limits means what can be concluded from an example, not any two categories.

COMPOSITION
Choose composition when comparing two alternatives and one has an indispensable internal sequence that a simple list would hide. Do not hide an explicit, relevant sequence in a note or a generic entry: retain its steps in the steps panel. Supply items:[], groups:[], body:"", quote:"", note, and panels:[{title,kind:"facts"|"steps",items:[{label,detail,iconQueries}],evidence}]. Exactly two panels with different forms: one facts and one steps; two facts lists become comparison. At most two levels, with 1–4 items per panel and at least two steps in a steps panel. Panel titles and item labels are at most 160 characters; details at most 600. The steps panel's evidence is an EXACT quotation documenting their order. Each step is a real successive action or state: a negation, requirement, or property is not a step, and a mere enumeration does not prove temporal order. facts contains independent properties. Do not repeat panel content in note. No nested panels, code, or coordinates. Each panel item uses ordinary iconQueries. Composition preserves different internal relationships; it is not a way to vary appearance when two simple lists already explain the concept.

CATALOG
${catalogText(types, variants, selection)}
${variants.length ? 'For a listed variant, use its parent as type and the variant name in variant. For the base form, omit variant.' : ''}

Final check: does every sentence under a title add something? Are the entries of each group truly examples of that group? Evidence entries must be evidence, never reasons to doubt signs. If the passage provides only signs and limits, compare "Visible signs" and "Limits of signs" with versus, or list the named limits. Do not invent evidence to fill a comparison. An attribute repeated for every item moves to body or note. Can the closing text be omitted without losing necessary meaning? If yes, leave it empty. Every note must be necessary; avoid generic warnings such as "often, not always".`;
};

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
${input.requestText?.trim() ? `EXPLICIT ARTIFACT REQUEST:\n${input.requestText.trim()}\nChoose a supported catalog form that actually represents the requested structure and relationships. Preserve requested direction and visible connections; a list does not replace an explicitly requested connected diagram. Retain these constraints on revision unless explicitly changed.\n` : ''}
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
  ...(draft.conceptLayout ? { conceptLayout: draft.conceptLayout } : {}),
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

const supportMarkdownParser = unified().use(remarkParse).use(remarkMath);

interface SupportMarkdownNode {
  type: string;
  value?: string;
  children?: SupportMarkdownNode[];
}

// Diagnostic projection only; grounding continues to require an exact source quotation.
const supportRepresentation = (markdown: string): string => {
  const text = (node: SupportMarkdownNode): string => {
    const content = node.value ?? node.children?.map(text).join('') ?? '';
    return node.type === 'paragraph' || node.type === 'heading' ? `${content}\n` : content;
  };
  return supportQuotationText(text(supportMarkdownParser.parse(markdown) as SupportMarkdownNode));
};

// Absent literal support cannot establish paraphrase or fabrication.
const compareSupportQuotation = (evidence: string, lesson: string, excerpt: string) => {
  const normalizedEvidence = supportQuotationText(evidence);
  const normalizedExcerpt = supportQuotationText(excerpt);
  let outcome = 'absent';
  if (!normalizedEvidence) outcome = 'empty';
  else if (normalizedExcerpt.includes(normalizedEvidence)) outcome = 'matched';
  else if (supportQuotationText(lesson).includes(normalizedEvidence)) outcome = 'outside-excerpt';
  if (outcome === 'absent') {
    const representedEvidence = supportRepresentation(evidence);
    if (representedEvidence && supportRepresentation(excerpt).includes(representedEvidence))
      outcome = 'representation-mismatch';
  }
  return {
    outcome,
    literalOffset: evidence ? excerpt.indexOf(evidence) : -1,
    normalizedOffset: normalizedEvidence ? normalizedExcerpt.indexOf(normalizedEvidence) : -1,
    sourceChars: lesson.length,
    excerptChars: excerpt.length,
    normalizedExcerptChars: normalizedExcerpt.length,
    evidenceChars: evidence.length,
    normalizedEvidenceChars: normalizedEvidence.length,
  };
};

const findOrderedDraftProblems = (
  draft: SceneDraft,
  useOrderedSceneSelection: boolean
): string[] => {
  if (draft.type !== 'steps' && draft.type !== 'process') return [];
  if (!useOrderedSceneSelection && draft.type === 'process') {
    return draft.items.length > LESSON_SCENE_LIMITS.items
      ? [`The process card takes at most ${LESSON_SCENE_LIMITS.items} entries.`]
      : [];
  }
  return [
    ...(useOrderedSceneSelection && draft.steps
      ? [
          'Use guided-path (when available) for timed stages. For a static list, put stages in items and omit steps.',
        ]
      : []),
    ...(useOrderedSceneSelection && draft.diagram
      ? ['Use an available diagram form to preserve visible connections. Otherwise omit diagram.']
      : []),
    ...(draft.type === 'steps' && draft.items.length > LESSON_SCENE_LIMITS.items
      ? [
          `The compact steps list takes at most ${LESSON_SCENE_LIMITS.items} entries. Use the process card for a longer sequence when available.`,
        ]
      : []),
  ];
};

const findBoundaryDraftProblems = (
  draft: SceneDraft,
  source: string,
  supportsConceptLayout: boolean
): string[] => {
  if (draft.type !== 'boundary') {
    return draft.scopeEvidence !== undefined ||
      draft.groups.some(group => group.scopeSide !== undefined)
      ? ['Only boundary scenes can set scopeEvidence or scopeSide.']
      : [];
  }
  if (!supportsConceptLayout) {
    return draft.items.length ? [] : ['The boundary form requires at least two items.'];
  }
  const [inside, outside] = draft.groups;
  const hasScope = draft.title.trim() && !draft.items.length && draft.groups.length === 2;
  const hasSides = inside?.scopeSide === 'inside' && outside?.scopeSide === 'outside';
  if (!hasScope || !hasSides || !inside.label.trim() || !outside.label.trim())
    return [
      'Name the scope in the title and use named groups with scopeSide inside, then outside, with no scene items.',
    ];
  const scopeEvidence = supportQuotationText(draft.scopeEvidence ?? '');
  return scopeEvidence && supportQuotationText(source).includes(scopeEvidence)
    ? []
    : [
        'Quote the exact words that show both sides of the same scope in scopeEvidence. If the passage has no such words, use a plain concepts list when available.',
      ];
};

const findConceptFamilyDraftProblems = (
  draft: SceneDraft,
  scene: LessonScene,
  {
    narration,
    supportsConceptLayout = true,
  }: Pick<GenerateLessonSceneInput, 'narration' | 'supportsConceptLayout'>
): string[] => [
  ...(!supportsConceptLayout &&
  narration !== undefined &&
  (scene.type === 'parts' || scene.type === 'concepts') &&
  scene.items.some(item => item.detail.trim())
    ? [
        'Captioned concept lists name each part and its role in the label, with empty detail. Use grouping for shared qualifications instead of glossary descriptions.',
      ]
    : []),
  ...(supportsConceptLayout && scene.type === 'concepts' && scene.groups.length
    ? ['Concept lists use items, not groups.']
    : []),
];

const findDraftProblems = (
  draft: SceneDraft,
  scene: LessonScene,
  source: string,
  input: Pick<GenerateLessonSceneInput, 'narration' | keyof SceneSelection>
): string[] => [
  ...findOrderedDraftProblems(draft, input.useOrderedSceneSelection ?? true),
  ...(input.useClosedLoopSelection === false && scene.type === 'flywheel' && !scene.center
    ? ['Cycle requires 3–6 stations and a center.']
    : []),
  ...(scene.type === 'proportional-static' &&
  (scene.items.length ||
    scene.groups.length ||
    Object.keys(LessonSceneAnimationShape).some(
      key => key !== 'amountPerUnit' && Object.hasOwn(scene, key)
    ))
    ? ['Fixed proportional scenes use quantity, amountPerUnit and unit, with no motion or items.']
    : []),
  ...(scene.type === 'proportional' && draft.quantity !== undefined
    ? ['Use the fixed proportional variant for a single quantity, or omit quantity for motion.']
    : []),
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
  ...findBoundaryDraftProblems(draft, source, input.supportsConceptLayout ?? true),
  ...findConceptFamilyDraftProblems(draft, scene, input),
  ...findLessonSceneProblems(scene, source, input.narration),
];

const textFallbackProblems = (
  draft: Pick<SceneDraft, 'conceptLayout' | 'evidence'>,
  source: string
): string[] => {
  if (draft.conceptLayout !== undefined) return ['Text fallback must omit conceptLayout.'];
  return draft.evidence.trim() &&
    supportQuotationText(source).includes(supportQuotationText(draft.evidence))
    ? []
    : ['Text fallback needs exact source evidence.'];
};

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
  const captioned = input.narration !== undefined;
  const selection: SceneSelection = {
    supportsConceptLayout: input.supportsConceptLayout ?? true,
    useOrderedSceneSelection: input.useOrderedSceneSelection ?? true,
    useClosedLoopSelection: input.useClosedLoopSelection ?? true,
  };
  const { supportsConceptLayout } = selection;
  // A resumed workflow must generate within the catalog admitted by its saved contract.
  // Spotlight definitions need the owning playback's canonical speech, not raw Markdown anchors.
  const relationKinds = input.allowedSceneRelationKinds ?? LESSON_SCENE_RELATION_KINDS;
  const allowedTypes = selectableLessonSceneTypes({
    captioned,
    allowedTypes: input.allowedSceneTypes,
    relationKinds,
    ...selection,
  });
  const variants = sceneVariants.filter(
    variant =>
      allowedTypes.includes(variant) && allowedTypes.includes(sceneVariantFamilies[variant])
  );
  const types = allowedTypes.filter(type => !variants.some(variant => variant === type));
  const draftSchema = selectDraftSchema(types, supportsConceptLayout);
  const baseSchema = draftSchema.extend({
    type: z.enum(input.allowTextFallback ? [...types, 'text'] : types),
    relation: SceneDraftSchema.shape.relation
      .unwrap()
      .extend({ kind: z.enum(relationKinds) })
      .nullable(),
  });
  const catalogSchema = variants.length
    ? baseSchema.extend({ variant: z.enum(variants).optional() })
    : baseSchema;
  const schema = captioned
    ? catalogSchema.extend({ body: z.literal(''), note: z.literal('') })
    : catalogSchema;
  const { $schema: _dialect, ...outputSchema } = z.toJSONSchema(schema);
  const compactFormRule = supportsConceptLayout
    ? ''
    : ' In parts and concepts scenes, item detail must be empty. Name each part and its role in the label.';
  const captionRule = captioned
    ? `\nCAPTIONED PLAYBACK: body and note must be empty. The narration already supplies prose.${compactFormRule} Never turn narration into a glossary. Put every necessary condition in the visual labels, groups or data qualifiers.`
    : '';
  // Malformed output surfaces either as an error or as JSON of the wrong shape; both become
  // corrective feedback for the next attempt.
  let outputPath: 'direct' | 'json-envelope' | 'unavailable' = 'unavailable';
  const excerpt = input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS);
  const diagnostic = (
    stage: 'schema' | 'domain',
    problems: unknown,
    evidence?: string,
    source = excerpt
  ) => ({
    ...toWorkflowErrorDiagnostic(
      new Error(
        JSON.stringify({
          outputPath,
          stage,
          ...(evidence === undefined
            ? {}
            : {
                supportComparison: compareSupportQuotation(evidence, input.lessonMarkdown, source),
              }),
          problems,
        })
      )
    ),
    errorStage: stage,
  });
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
    system: `${sceneSystemPrompt(types, variants, relationKinds, selection)}${captionRule}${input.allowTextFallback ? '\nTEXT FALLBACK: When no catalog visual helps this passage, explicitly choose type text with empty items/groups and an exact supporting evidence quotation. The complete authored passage remains in captions. The visual panel shows its sourced mathematics when present and otherwise stays empty. This choice is yours; never force a formula spotlight when it does not fit.' : ''}\n\n${INTERNAL_FAST_TASK_INSTRUCTION}`,
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
  const variant = variants.find(
    variant => 'variant' in parsed.data && parsed.data.variant === variant
  );
  if (variant && sceneVariantFamilies[variant] !== parsed.data.type) {
    const problems = [`Use type ${sceneVariantFamilies[variant]} with variant ${variant}.`];
    return {
      kind: 'invalid',
      problems,
      diagnostic: diagnostic('domain', problems, parsed.data.evidence),
    };
  }
  if (parsed.data.type === 'text') {
    const problems = textFallbackProblems(parsed.data, input.lessonMarkdown);
    if (!problems.length) return { kind: 'text' };
    return {
      kind: 'invalid',
      problems,
      diagnostic: diagnostic('domain', problems, parsed.data.evidence, input.lessonMarkdown),
    };
  }
  // Resolve the draft-only choice before validation, icon selection and persistence.
  const draft = { ...parsed.data, type: variant ?? parsed.data.type };
  if (draft.type === 'proportional-static' && draft.outputUnit === draft.unit)
    delete draft.outputUnit;
  const scene = toScene(draft);
  const problems = findDraftProblems(draft, scene, excerpt, input);
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
        }),
        draft.evidence
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
