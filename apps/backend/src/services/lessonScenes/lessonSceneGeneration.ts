import { INTERNAL_FAST_TASK_INSTRUCTION } from '@shared/aiPromptInstructions';
import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import {
  findLessonSceneProblems,
  LESSON_SCENE_CATALOG,
  LESSON_SCENE_DIAGRAM_TYPES,
  LESSON_SCENE_EDGE_KINDS,
  LESSON_SCENE_NODE_KINDS,
  LESSON_SCENE_RELATION_KINDS,
  LESSON_SCENE_TYPES,
  LESSON_SCENE_VERDICTS,
  type LessonScene,
} from '@shared/lessonScene';
import * as z from 'zod';

import { getResolvedModelConfigForProvider } from '../../config/modelConfig.js';
import {
  isInvalidLessonVisualStructuredOutput,
  type RenderResolvedLessonVisualInput,
} from '../lessonGenerationVisuals.js';
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
  | { readonly kind: 'invalid'; readonly problems: readonly string[] };

const SceneIconQueriesSchema = z.strictObject({
  object: z.string(),
  action: z.string(),
  concept: z.string(),
});

const SceneDiagramSchema = z.strictObject({
  nodes: z.array(
    z.strictObject({ id: z.string(), label: z.string(), kind: z.enum(LESSON_SCENE_NODE_KINDS) })
  ),
  edges: z.array(
    z.strictObject({
      from: z.string(),
      to: z.string(),
      label: z.string(),
      kind: z.enum(LESSON_SCENE_EDGE_KINDS),
      evidence: z.string(),
    })
  ),
});

// Key order is the generation order: the model states its intent and evidence before the form.
const SceneDraftSchema = z.strictObject({
  intent: z.string(),
  evidence: z.string(),
  type: z.enum(LESSON_SCENE_TYPES),
  title: z.string(),
  body: z.string(),
  items: z.array(
    z.strictObject({
      label: z.string(),
      detail: z.string(),
      value: z.number().nullable(),
      time: z.number().nullable(),
      iconQueries: SceneIconQueriesSchema,
    })
  ),
  groups: z.array(
    z.strictObject({
      label: z.string(),
      items: z.array(z.string()),
      iconQueries: z.array(SceneIconQueriesSchema),
      verdict: z.enum([...LESSON_SCENE_VERDICTS, 'none']),
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
});

type SceneDraft = z.infer<typeof SceneDraftSchema>;

const { $schema: _dialect, ...SCENE_OUTPUT_SCHEMA } = z.toJSONSchema(SceneDraftSchema) as Record<
  string,
  unknown
>;

const catalogText = (): string =>
  LESSON_SCENE_TYPES.map(type => `- ${type}: ${LESSON_SCENE_CATALOG[type]}`).join('\n');

const SCENE_SYSTEM_PROMPT = `Design the visual scene that accompanies one concept of a lesson for adults. First state the reader's task: what must the reader understand? Then choose the semantic relation (definition, distinction, comparison by a criterion, check, sequence, limit, question) and only then choose the form from the catalog. Use only the lesson text. Preserve negations, scope, conditions, and uncertainty. All visible text uses the lesson language.

FIELDS
- intent: one concrete sentence about the reader's task; never shown.
- evidence: an EXACT quotation from the lesson that supports the scene's message.
- title: at most 7 words; it states the topic or the criterion.
- body: one short sentence only when it adds necessary information, otherwise "".
- items: {label (at most 6 words), detail (at most 15 words, or ""), value (a number only for quantitative forms, else null), time (line only: the point's position in time as a number written in the lesson, such as a year; else null), iconQueries}.
- groups: {label, items (each a self-contained phrase), iconQueries (one per item, same order), verdict ("prefer", "avoid", or "none")}.
- quote: an EXACT quotation from the lesson, or "".
- note: one substantial limit in at most 18 words, or "".
- criteria: row labels for matrix, otherwise [].
- relation: for comparison and signals with two genuinely related terms, {kind, label, evidence}; otherwise null. kind is greater, less, different, equal, versus, or leads. label is only read by screen readers. evidence is an exact quotation (may be "" for versus). Use different only for an explicit distinction and leads only for an explicit process or consequence. Do not impose a winner when the lesson asks the reader to choose.
- diagram: for flowchart, sequence, and journey only, {nodes: [{id, label, kind}], edges: [{from, to, label, kind, evidence}]}; otherwise null. 2 to 8 nodes, 1 to 12 connections. Node kind is step, decision, start, or end; edge kind is call, return, or event. Every connection carries an EXACT lesson quotation in evidence. Decision branches carry their condition in the label. A sequence keeps message order and distinguishes returns and asynchronous events; a journey follows its nodes in order without branches. Never write SVG, coordinates, CSS, or Mermaid code.

ICON SEARCH PHRASES
For every item and every group entry write iconQueries with three short English phrases (2 to 5 words) for a generic icon library: object names a common everyday object that symbolises the entry (prefer widely used symbols such as graduation cap, building, star, magnifying glass over specific professions or scenes); action names the action involved; concept names the abstract idea in plain words. When the entry negates or excludes something, describe the negation or absence. Diagram forms have no items and no groups.

WRITING
Use 2 to 4 elements when needed; never fill space. A label identifies a concept; a detail explains it with ONE idea in a natural sentence. Brevity comes from choosing the message, never from piling up terms. Do not compress different dimensions with slashes, semicolons, parentheses, or noun strings. Keep one criterion, consistent with the title, for all entries. Do not repeat the title in details. Do not add usefulness, causes, or facts absent from the lesson. Avoid meta-textual labels and editorial instructions. Before answering, reread every subtext: is it understandable without reconstructing a relation between scattered words?

FORMS
- Make the layout mirror the logical relations the lesson states: parallel criteria, factors, or options sit side by side in one form (checklist, parts, grid); only steps the lesson explicitly orders become steps or a sequence. Never chain parallel items as consecutive steps.
- definition: the defining sentence in body and attributes in items; a condition common to all attributes goes in body once. checklist: concrete questions in labels. limits: two items meaning "Shows" and "Does not prove", in the lesson language. roles: people as items with a neutral profile. quote: only the exact quotation or question, in quote, with body "". steps: strictly ordered actions, not alternatives.
- comparison, signals, matrix, decision, balance, and beforeafter need exactly two non-empty groups. matrix also needs criteria, with as many rows in both groups. The other forms need at least two items, except quote, number, flowchart, sequence, and journey; those three diagram forms keep all content in diagram, with items and groups [].
- For hierarchies and networks the title names the common node. Do not use maps, cycles, or timelines for plain lists. beforeafter needs an actual transformation; a mere preference between two behaviours is a comparison with verdicts.
- Quantitative forms only with REAL numbers present in the lesson, never invented scores. Each numeric item has a finite value >= 0 and a label with unit or period. interval has exactly three items: minimum, estimate, maximum. line points carry increasing times, which set their real spacing; the label shows how the lesson names each time. number has one item. HTTP codes, versions, and identifiers are not quantities.
- A message exchange with replies and branches is a sequence, not an invented causal chain.

CATALOG
${catalogText()}

Final check: does every sentence under a title add something? Are the entries of each group truly examples of that group? Is every note necessary?`;

const MALFORMED_ANSWER_PROBLEM = 'The answer must follow the requested JSON structure.';

const buildScenePrompt = (input: RenderResolvedLessonVisualInput): string => {
  const correction = input.retryFeedback?.trim()
    ? `\nRequired correction from the previous attempt:\n${input.retryFeedback.trim()}\n`
    : '';
  return `Lesson: ${input.sectionTitle}
Description: ${input.sectionDescription}
Planned visual: ${JSON.stringify({
    anchorHeading: input.plan.anchorHeading,
    concept: input.plan.concept,
    factualRequirements: input.plan.factualRequirements,
    pedagogicalGoal: input.plan.pedagogicalGoal,
    title: input.plan.title,
    visualDirection: input.plan.visualDirection,
  })}
${correction}
LESSON TEXT:
${input.lessonMarkdown.slice(0, MAX_VISUAL_LESSON_CHARS)}`;
};

const toScene = (draft: SceneDraft): LessonScene => ({
  body: draft.body,
  ...(draft.criteria.length ? { criteria: draft.criteria } : {}),
  ...(draft.diagram && LESSON_SCENE_DIAGRAM_TYPES.has(draft.type)
    ? { diagram: draft.diagram }
    : {}),
  groups: draft.groups.map(group => ({
    icons: group.items.map(() => ''),
    items: group.items,
    label: group.label,
    ...(group.verdict === 'none' ? {} : { verdict: group.verdict }),
  })),
  items: draft.items.map(item => ({
    detail: item.detail,
    icon: '',
    label: item.label,
    ...(item.time === null ? {} : { time: item.time }),
    ...(item.value === null ? {} : { value: item.value }),
  })),
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
];

const findDraftProblems = (draft: SceneDraft, scene: LessonScene, source: string): string[] => [
  ...(draft.evidence.trim() && source.includes(draft.evidence)
    ? []
    : ['evidence must be an exact quotation from the lesson.']),
  ...(draft.groups.every(group => group.iconQueries.length === group.items.length)
    ? []
    : ['Every group needs one iconQueries entry per item.']),
  ...findLessonSceneProblems(scene, source),
];

/** Generates and validates one lesson scene, then chooses its icons. */
export const generateLessonScene = async (
  input: RenderResolvedLessonVisualInput
): Promise<LessonSceneOutcome> => {
  // Scenes replace the artifact pipeline, so they run on the provider resolved for this run's
  // visuals (the learner's provider), while scene models come from the live configuration.
  const config = await getResolvedModelConfigForProvider(input.config.artifact.provider);
  // Malformed output surfaces either as an error or as JSON of the wrong shape; both become
  // corrective feedback for the next attempt.
  const response = await generateStructuredOutput<unknown>({
    config,
    output: { name: 'lesson_scene', schema: SCENE_OUTPUT_SCHEMA },
    prompt: buildScenePrompt(input),
    signal: input.signal,
    slot: 'scene',
    system: `${SCENE_SYSTEM_PROMPT}\n\n${INTERNAL_FAST_TASK_INSTRUCTION}`,
  }).catch(error => {
    input.signal.throwIfAborted();
    if (!isInvalidLessonVisualStructuredOutput(error)) throw error;
    return null;
  });
  const parsed = SceneDraftSchema.safeParse(response);
  if (!parsed.success) {
    return { kind: 'invalid', problems: [MALFORMED_ANSWER_PROBLEM] };
  }
  const draft = parsed.data;
  const scene = toScene(draft);
  const problems = findDraftProblems(draft, scene, input.lessonMarkdown);
  if (problems.length) return { kind: 'invalid', problems };
  return {
    kind: 'scene',
    scene: await chooseLessonSceneIcons({
      config,
      entries: iconEntries(draft),
      scene,
      signal: input.signal,
    }),
  };
};
