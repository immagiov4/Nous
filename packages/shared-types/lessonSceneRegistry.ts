import * as z from 'zod';

import { FormulaSpotlightDataSchema, findFormulaSpotlightProblems } from './formulaSpotlight';

import { cueTimes, playbackMode } from './lessonSceneAnimation';
import {
  LESSON_SCENE_CATALOG_SNAPSHOTS,
  UNLINKED_FORMULA_SCENE_CATALOG_SNAPSHOT,
} from './lessonSceneCatalogSnapshots';

/** Lesson scene contract: a validated JSON description of one lesson visual, chosen from a fixed catalog of forms. The model fills content; the reader components own geometry and style, so scenes stay legible and can be restyled later without regeneration.
 *
 * Validation is deterministic and returns problems instead of throwing, so the backend can feed them back to the model as corrective feedback and the persistence layer can reject bad data. */
export const GUIDED_PATH_MIN_STEPS = 2;

export const GUIDED_PATH_MAX_STEPS = 8;

export const GUIDED_PATH_STEPS_PER_ROW = 4;

export const LESSON_SCENE_RELATION_KINDS = [
  'greater',
  'less',
  'different',
  'equal',
  'versus',
  'leads',
] as const;

export type LessonSceneRelationKind = (typeof LESSON_SCENE_RELATION_KINDS)[number];

export const LESSON_SCENE_RELATION_SYMBOLS: Readonly<Record<LessonSceneRelationKind, string>> = {
  different: '≠',
  equal: '=',
  greater: '>',
  leads: '→',
  less: '<',
  versus: 'vs',
};

export const LESSON_SCENE_VERDICTS = ['prefer', 'avoid'] as const;

type LessonSceneVerdict = (typeof LESSON_SCENE_VERDICTS)[number];

const LESSON_SCENE_NODE_KINDS = ['step', 'decision', 'start', 'end'] as const;

const LESSON_SCENE_EDGE_KINDS = ['call', 'return', 'event'] as const;

/** Content limits inherited from the validated prototype catalog. */
export const LESSON_SCENE_LIMITS = {
  diagramEdges: 12,
  diagramLabel: 100,
  diagramNodes: 8,
  groups: 3,
  items: 6,
  minItems: 2,
  relationLabel: 160,
  text: 600,
} as const;

const SceneDataSchema = z.object({
  body: z.string(),
  criteria: z.array(z.string()).optional(),
  diagram: z
    .object({
      edges: z.array(
        z.object({
          evidence: z.string(),
          from: z.string(),
          kind: z.enum(LESSON_SCENE_EDGE_KINDS),
          label: z.string(),
          to: z.string(),
        })
      ),
      nodes: z.array(
        z.object({ id: z.string(), kind: z.enum(LESSON_SCENE_NODE_KINDS), label: z.string() })
      ),
    })
    .optional(),
  groups: z.array(
    z.object({
      icons: z.array(z.string()),
      items: z.array(z.string()),
      label: z.string(),
      verdict: z.enum(LESSON_SCENE_VERDICTS).optional(),
    })
  ),
  items: z.array(
    z.object({
      detail: z.string(),
      icon: z.string(),
      label: z.string(),
      time: z.number().optional(),
      value: z.number().optional(),
    })
  ),
  note: z.string(),
  quote: z.string(),
  relation: z
    .object({
      evidence: z.string(),
      kind: z.enum(LESSON_SCENE_RELATION_KINDS),
      label: z.string(),
    })
    .optional(),
  title: z.string(),
});

const animatedShape = {
  autoplay: z.boolean().optional(),
  durationMs: z.number().positive().optional(),
  narration: z.string().optional(),
};

const ProportionalDataSchema = z.object({
  ...animatedShape,
  inputLabel: z.string().optional(),
  unitLabel: z.string().optional(),
  min: z.number().int().positive().optional(),
  max: z.number().int().positive().optional(),
  initial: z.number().int().positive().optional(),
  amountPerUnit: z.number().positive().optional(),
  outputUnit: z.string().optional(),
  outputLabel: z.string().optional(),
  assumption: z.string().optional(),
  cues: z.array(z.object({ anchor: z.string().optional(), value: z.number() })).optional(),
});

const GuidedPathDataSchema = z.object({
  ...animatedShape,
  steps: z
    .array(
      z.object({
        anchor: z.string().optional(),
        label: z.string(),
        detail: z.string(),
      })
    )
    .optional(),
});

/** Static prototype fields extend only new catalog entries, preserving deployed schemas. */
const QuickItemDataSchema = SceneDataSchema.shape.items.element.extend({
  id: z.string().optional(),
  parent: z.string().optional(),
  start: z.number().optional(),
  end: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

const QuickGroupDataSchema = SceneDataSchema.shape.groups.element.extend({
  icon: z.string().optional(),
  details: z.array(z.string()).optional(),
});

const QuickDataSchema = SceneDataSchema.extend({
  items: z.array(QuickItemDataSchema),
  groups: z.array(QuickGroupDataSchema),
});

const CompositionDataSchema = QuickDataSchema.extend({
  panels: z.array(
    z.object({
      title: z.string(),
      kind: z.enum(['facts', 'steps']),
      items: z.array(SceneDataSchema.shape.items.element),
      evidence: z.string().optional(),
    })
  ),
});

export type LessonSceneType = keyof typeof LESSON_SCENE_REGISTRY;

export type LessonSceneItem = Readonly<z.infer<typeof QuickItemDataSchema>>;

export type LessonSceneGroup = Readonly<z.infer<typeof QuickGroupDataSchema>>;

export type LessonScenePanel = Readonly<z.infer<typeof CompositionDataSchema.shape.panels.element>>;

type LessonSceneRelation = Readonly<
  z.infer<ReturnType<typeof SceneDataSchema.shape.relation.unwrap>>
>;

type LessonSceneDiagram = Readonly<NonNullable<z.infer<typeof SceneDataSchema.shape.diagram>>>;

type LessonSceneDiagramNode = LessonSceneDiagram['nodes'][number];

type LessonSceneDiagramEdge = LessonSceneDiagram['edges'][number];

type LessonSceneCue = Readonly<
  NonNullable<z.infer<typeof ProportionalDataSchema.shape.cues>>[number]
>;

type LessonScenePathStep = Readonly<
  NonNullable<z.infer<typeof GuidedPathDataSchema.shape.steps>>[number]
>;

export type LessonScene = Readonly<
  Omit<z.infer<typeof LessonSceneSchema>, 'items' | 'groups'> & z.infer<typeof QuickDataSchema>
>;

/** Shared content used by fixed renderers, independent of each form's extra fields. */
export type SceneContentData = Readonly<z.infer<typeof QuickDataSchema> & { type: string }>;

type AnimatedSceneData<Schema extends z.ZodObject, Type extends string> = Readonly<
  SceneContentData &
    z.infer<Schema> &
    Required<Omit<z.infer<Schema>, 'durationMs' | 'narration' | 'cues'>> & { type: Type }
>;

export type ProportionalLessonScene = AnimatedSceneData<
  typeof ProportionalDataSchema,
  'proportional'
>;

export type GuidedPathLessonScene = AnimatedSceneData<typeof GuidedPathDataSchema, 'guided-path'>;

export type AnimatedLessonScene = ProportionalLessonScene | GuidedPathLessonScene;

/** Callers supply validated scenes; the form identifies its animation contract. */
export const isAnimatedLessonScene = (scene: LessonScene): scene is AnimatedLessonScene =>
  sceneForms[scene.type].animated === true;

export const isQuickLessonScene = (scene: LessonScene): boolean =>
  sceneForms[scene.type].content === 'quick';

/** Quote and decision forms use quote as their main content, rather than a closing question. */
export const hasConflictingLessonSceneClosingText = (scene: LessonScene): boolean =>
  scene.type !== 'quote' &&
  scene.type !== 'decision' &&
  Boolean(scene.quote.trim() && scene.note.trim());

const ICON_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown, max: number = LESSON_SCENE_LIMITS.text): value is string =>
  typeof value === 'string' && value.length <= max;

const isSceneType = (value: unknown): value is LessonSceneType =>
  typeof value === 'string' && (LESSON_SCENE_TYPES as readonly string[]).includes(value);

// Evidence is required even without the lesson text, so stored scenes keep their quotations.
const includesEvidence = (source: string | undefined, evidence: unknown): boolean =>
  typeof evidence === 'string' &&
  evidence.trim() !== '' &&
  (source === undefined || source.includes(evidence));

/** Whether every node is reachable from the first one, ignoring connection direction. */
const isConnectedGraph = (
  nodes: readonly LessonSceneDiagramNode[],
  edges: readonly LessonSceneDiagramEdge[]
): boolean => {
  const reached = new Set(nodes.slice(0, 1).map(node => node.id));
  const pending = [...reached];
  const neighborOf = (edge: LessonSceneDiagramEdge, id: string): string | undefined => {
    if (edge.from === id) return edge.to;
    return edge.to === id ? edge.from : undefined;
  };
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const edge of edges) {
      const neighbor = neighborOf(edge, id);
      if (neighbor !== undefined && !reached.has(neighbor)) {
        reached.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return reached.size === nodes.length;
};

const shortText = z.string().max(LESSON_SCENE_LIMITS.text);

const itemLabel = shortText.refine(text => text.trim() !== '');

const iconSlot = z.string().refine(text => text === '' || ICON_NAME_PATTERN.test(text));

const diagramShape = SceneDataSchema.shape.diagram.unwrap().shape;

const diagramLabel = z.string().max(LESSON_SCENE_LIMITS.diagramLabel);

const DiagramNodeValidationSchema = diagramShape.nodes.element.extend({
  label: diagramLabel.refine(text => text.trim() !== ''),
});

const DiagramEdgeValidationSchema = diagramShape.edges.element
  .omit({ evidence: true })
  .extend({ label: diagramLabel });

const ItemValidationSchema = SceneDataSchema.shape.items.element
  .omit({ value: true })
  .extend({ label: itemLabel, detail: shortText, icon: iconSlot });

const GroupValidationSchema = SceneDataSchema.shape.groups.element
  .omit({ verdict: true })
  .extend({ label: shortText, items: z.array(itemLabel), icons: z.array(iconSlot) })
  .refine(group => group.icons.length === group.items.length);

const CriteriaValidationSchema = z.array(shortText);

const PathValidationSchema = GuidedPathDataSchema.shape.steps
  .unwrap()
  .element.extend({
    label: z.string().refine(text => text.trim() !== ''),
    detail: z.string().refine(text => text.trim() !== ''),
  })
  .array()
  .min(GUIDED_PATH_MIN_STEPS)
  .max(GUIDED_PATH_MAX_STEPS);

const isDiagramNode = (node: unknown): node is LessonSceneDiagramNode =>
  DiagramNodeValidationSchema.safeParse(node).success;

const isDiagramEdge = (
  edge: unknown,
  nodeIds: ReadonlySet<string>
): edge is LessonSceneDiagramEdge =>
  DiagramEdgeValidationSchema.safeParse(edge).success &&
  nodeIds.has((edge as LessonSceneDiagramEdge).from) &&
  nodeIds.has((edge as LessonSceneDiagramEdge).to);

/** Topology constraints apply after nodes and connections have passed structural validation. */
const findDiagramTopologyProblems = (
  nodes: readonly LessonSceneDiagramNode[],
  edges: readonly LessonSceneDiagramEdge[],
  orderedPath = false
): string[] => {
  const isOrderedPath =
    edges.length === nodes.length - 1 &&
    edges.every((edge, index) => edge.from === nodes[index].id && edge.to === nodes[index + 1].id);
  return [
    ...(isConnectedGraph(nodes, edges) ? [] : ['Every diagram node must be connected.']),
    ...nodes
      .filter(
        node =>
          node.kind === 'decision' &&
          edges.some(edge => edge.from === node.id && !edge.label.trim())
      )
      .map(() => 'Branches leaving a decision need condition labels.'),
    ...(orderedPath && !isOrderedPath
      ? ['A journey must follow its nodes in order, without jumps or branches.']
      : []),
  ];
};

const findDiagramProblems = (
  diagram: unknown,
  source: string | undefined,
  orderedPath = false
): string[] => {
  if (!isRecord(diagram) || !Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges)) {
    return ['A diagram form requires diagram.nodes and diagram.edges.'];
  }
  const { edges, nodes } = diagram;
  const problems: string[] = [];
  if (nodes.length < 2 || nodes.length > LESSON_SCENE_LIMITS.diagramNodes) {
    problems.push(`A diagram needs 2 to ${LESSON_SCENE_LIMITS.diagramNodes} nodes.`);
  }
  if (edges.length < 1 || edges.length > LESSON_SCENE_LIMITS.diagramEdges) {
    problems.push(`A diagram needs 1 to ${LESSON_SCENE_LIMITS.diagramEdges} connections.`);
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!isDiagramNode(node) || ids.has(node.id)) {
      problems.push('Every diagram node needs a unique id, a short label, and a valid kind.');
      return problems;
    }
    ids.add(node.id);
  }
  for (const edge of edges) {
    if (!isDiagramEdge(edge, ids)) {
      problems.push('Every diagram connection must join existing nodes with a valid kind.');
      return problems;
    }
    if (!includesEvidence(source, edge.evidence)) {
      problems.push(`The connection "${edge.label}" needs an exact quotation from the lesson.`);
    }
  }
  const typedEdges = edges as LessonSceneDiagramEdge[];
  const typedNodes = nodes as LessonSceneDiagramNode[];
  return [...problems, ...findDiagramTopologyProblems(typedNodes, typedEdges, orderedPath)];
};

const findItemProblems = (items: unknown): string[] => {
  if (!Array.isArray(items) || items.length > LESSON_SCENE_LIMITS.items) {
    return [`items must be an array of at most ${LESSON_SCENE_LIMITS.items} entries.`];
  }
  const valid = items.every(item => ItemValidationSchema.safeParse(item).success);
  return valid ? [] : ['Every item needs a label, a detail, and an icon identifier.'];
};

const findGroupProblems = (groups: unknown, criteria: unknown): string[] => {
  if (!Array.isArray(groups) || groups.length > LESSON_SCENE_LIMITS.groups) {
    return [`groups must be an array of at most ${LESSON_SCENE_LIMITS.groups} entries.`];
  }
  for (const group of groups) {
    if (!GroupValidationSchema.safeParse(group).success) {
      return ['Every group needs a label, its entries, and exactly one icon slot per entry.'];
    }
    if (
      group.verdict !== undefined &&
      !(LESSON_SCENE_VERDICTS as readonly unknown[]).includes(group.verdict)
    ) {
      return ['A group verdict must be prefer or avoid.'];
    }
  }
  if (criteria === undefined) return [];
  const rowsMatch =
    CriteriaValidationSchema.safeParse(criteria).success &&
    groups.every(group => group.items.length === (criteria as string[]).length);
  return rowsMatch ? [] : ['Matrix criteria must label every row of both groups.'];
};

const findRelationProblems = (relation: unknown, source: string | undefined): string[] => {
  if (relation === undefined) return [];
  if (
    !isRecord(relation) ||
    !(LESSON_SCENE_RELATION_KINDS as readonly unknown[]).includes(relation.kind) ||
    !isText(relation.label, LESSON_SCENE_LIMITS.relationLabel) ||
    !relation.label.trim()
  ) {
    return ['A relation needs a valid kind and a short accessible label.'];
  }
  return relation.kind === 'versus' || includesEvidence(source, relation.evidence)
    ? []
    : ['A relation other than versus needs an exact quotation from the lesson.'];
};

// Numbers written in the lesson: digit runs joined by dots, commas, or an inline space before a
// three-digit group, in either the Italian (1.234,5) or the English (1,234.5) convention, with an
// optional exponent (1.5e6). A minus sign counts only when it does not follow a word or a number,
// so ranges such as 10-12 stay positive.
const SOURCE_NUMBER_PATTERN =
  /(?:(?<![\p{L}\p{N}])[-−])?\d+(?:[.,]\d+|[ \u00A0\u202F]\d{3}(?!\d))*(?:[eE][-+]?\d+)?/gu;

const MINUS_SIGN_PATTERN = /^[-−]/u;

const INLINE_SPACE_PATTERN = /[ \u00A0\u202F]/u;

const EXPONENT_PATTERN = /[eE]([-+]?\d+)$/u;

const THOUSANDS_GROUP_LENGTH = 3;

/** Readings of one written number. Mixed separators (1.234,5) and a repeated separator (1.234.567) are unambiguous; only a single separator before exactly three digits (1.234) can be either a thousands group or a decimal point, so both readings are kept. A repeated separator whose groups are not thousands groups (1.2.3) is a version or identifier, not a quantity, so it gives no reading. */
const readNumberToken = (digits: string): number[] => {
  const separators = [...digits].filter(character => character === '.' || character === ',');
  if (separators.length === 0) return [Number(digits)];
  const groups = digits.split(/[.,]/u);
  if (
    new Set(separators).size === 1 &&
    separators.length > 1 &&
    groups.slice(1).some(group => group.length !== THOUSANDS_GROUP_LENGTH)
  ) {
    return [];
  }
  const lastSeparator = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
  const integerPart = digits.slice(0, lastSeparator).replaceAll(/[.,]/gu, '');
  const lastGroup = digits.slice(lastSeparator + 1);
  const asInteger = Number(`${integerPart}${lastGroup}`);
  const asDecimal = Number(`${integerPart}.${lastGroup}`);
  if (new Set(separators).size > 1) return [asDecimal];
  if (separators.length > 1) return [asInteger];
  return lastGroup.length === THOUSANDS_GROUP_LENGTH ? [asInteger, asDecimal] : [asDecimal];
};

/** Readings of one matched token. A space before three digits either groups thousands (1 234) or separates two numbers (2024 120), so both the joined and the separate readings are kept. */
const readSourceToken = (token: string): number[] => {
  const sign = MINUS_SIGN_PATTERN.test(token) ? -1 : 1;
  const unsigned = token.replace(MINUS_SIGN_PATTERN, '');
  const exponent = EXPONENT_PATTERN.exec(unsigned)?.[1];
  const parts = unsigned.replace(EXPONENT_PATTERN, '').split(INLINE_SPACE_PATTERN);
  const readings = [
    ...readNumberToken(parts.join('')),
    ...(parts.length > 1 ? parts.flatMap(readNumberToken) : []),
  ];
  return readings.map(value => sign * (exponent ? Number(`${value}e${exponent}`) : value));
};

const readSourceNumbers = (source: string): Set<number> =>
  new Set([...source.matchAll(SOURCE_NUMBER_PATTERN)].flatMap(([token]) => readSourceToken(token)));

/** A line places its points at their real distance in time, so every point needs a time stated in the lesson, in increasing order. */
const findLineTimeProblems = (
  items: readonly LessonSceneItem[],
  source: string | undefined
): string[] => {
  const times = items.map(item => item.time);
  const increasing = times.every(
    (time, index) => time !== undefined && (index === 0 || time > (times[index - 1] as number))
  );
  if (!increasing) return ['A line needs a time for every point, in increasing order.'];
  if (source === undefined) return [];
  const sourceNumbers = readSourceNumbers(source);
  const ungrounded = items.filter(item => !sourceNumbers.has(item.time as number));
  return ungrounded.length
    ? [`Times must appear in the lesson: ${ungrounded.map(item => item.label).join(', ')}.`]
    : [];
};

const findNumericProblems = (
  scene: Record<string, unknown>,
  source: string | undefined
): string[] => {
  const items = scene.items as LessonSceneItem[];
  if (source !== undefined) {
    const sourceNumbers = readSourceNumbers(source);
    const ungrounded = items.filter(
      item => typeof item.value === 'number' && !sourceNumbers.has(item.value)
    );
    if (ungrounded.length) {
      return [
        `Quantitative values must appear in the lesson: ${ungrounded.map(item => item.label).join(', ')}.`,
      ];
    }
  }
  if (
    !items.every(
      item => typeof item.value === 'number' && Number.isFinite(item.value) && item.value >= 0
    )
  ) {
    return ['Every quantitative item needs a finite, non-negative value.'];
  }
  return [];
};

const findItemShapeProblems = (scene: Record<string, unknown>): string[] =>
  (scene.items as unknown[]).length < LESSON_SCENE_LIMITS.minItems
    ? [`The ${scene.type as string} form requires at least two items.`]
    : [];

const findTwoGroupProblems = (scene: Record<string, unknown>): string[] => {
  const groups = scene.groups as LessonSceneGroup[];
  return groups.length !== 2 || groups.some(group => !group.items.length)
    ? [`The ${scene.type as string} form requires exactly two non-empty groups.`]
    : [];
};

const findProportionalSceneProblems = (
  scene: Record<string, unknown>,
  source: string | undefined
): string[] => {
  const problems: string[] = [];
  const { min, max, initial, amountPerUnit } = scene;
  if (source !== undefined) {
    const sourceNumbers = readSourceNumbers(source);
    if (
      [min, max, initial, amountPerUnit].some(
        value => typeof value === 'number' && !sourceNumbers.has(value)
      )
    ) {
      problems.push('Quantity values must appear in the lesson.');
    }
  }
  if (
    ![min, max, initial].every(Number.isInteger) ||
    (min as number) < 1 ||
    (max as number) < (min as number) ||
    (initial as number) < (min as number) ||
    (initial as number) > (max as number)
  )
    problems.push('Invalid quantity bounds.');
  if (!ProportionalDataSchema.shape.amountPerUnit.unwrap().safeParse(amountPerUnit).success) {
    problems.push('Invalid unit amount.');
  }
  if (
    ['inputLabel', 'unitLabel', 'outputUnit', 'outputLabel', 'assumption'].some(
      key => typeof scene[key] !== 'string' || !(scene[key] as string).trim()
    )
  )
    problems.push('Missing quantity label.');
  const cues = ProportionalDataSchema.shape.cues
    .unwrap()
    .element.refine(
      cue =>
        Number.isInteger(cue.value) &&
        cue.value >= (initial as number) &&
        cue.value <= (max as number)
    )
    .array()
    .optional();
  if (!cues.safeParse(scene.cues).success) problems.push('Invalid quantity cues.');
  return problems;
};

const findGuidedPathProblems = (scene: Record<string, unknown>): string[] =>
  PathValidationSchema.safeParse(scene.steps).success ? [] : ['Invalid path.'];

const findAnimationNarrationProblems = (
  animated: AnimatedLessonScene,
  source: string | undefined
): string[] => {
  if (
    source !== undefined &&
    animated.narration !== undefined &&
    !includesEvidence(source, animated.narration)
  ) {
    return ['Narration must be an exact quotation from the lesson.'];
  }
  if (playbackMode(animated) !== 'text') return [];
  // Generation and source-less persistence must agree on every stored anchor.
  const narrations = new Set([source, animated.narration]);
  for (const narration of narrations) {
    if (narration === undefined) continue;
    try {
      cueTimes(
        narration,
        animated.type === 'guided-path' ? animated.steps : (animated.cues as LessonSceneCue[])
      );
    } catch (error) {
      return [(error as Error).message];
    }
  }
  return [];
};

const findAnimatedSceneProblems = (
  scene: Record<string, unknown>,
  source: string | undefined,
  validate: SceneValidator,
  narration = source
): string[] => {
  const problems: string[] = [];
  if (typeof scene.autoplay !== 'boolean') problems.push('Autoplay must be explicit.');
  if (!animatedShape.durationMs.safeParse(scene.durationMs).success) {
    problems.push('Invalid duration.');
  }
  problems.push(...validate(scene, source));
  if (scene.narration !== undefined && typeof scene.narration !== 'string') {
    problems.push('Narration must be text.');
  }
  if (problems.length) return problems;
  return findAnimationNarrationProblems(scene as unknown as AnimatedLessonScene, narration);
};

/** Limits and invariants of the settled static prototype, independent of legacy forms. */
const QUICK_SCENE_LIMITS = {
  title: 160,
  label: 160,
  detail: 240,
  groupItems: 6,
  groups: 6,
  items: 12,
  entityDetail: 120,
  unit: 80,
  radialMin: 3,
  radialMax: 6,
  sequenceMin: 2,
  sequenceMax: 6,
  treeId: 40,
  treeLevels: 3,
  vennLabel: 24,
  vennDetail: 48,
  matrixColumns: 5,
  matrixRows: 8,
  permission: 60,
  integrationEntities: 2,
  deploymentGroups: 4,
  panels: 2,
  panelItems: 4,
} as const;

const quickText = (max: number) =>
  z
    .string()
    .max(max)
    .refine(text => text.trim() !== '');

const quickFieldText = (max: number) => z.string().min(1).max(max);

const QuickContentValidationSchema = QuickDataSchema.extend({
  title: quickText(QUICK_SCENE_LIMITS.title),
  body: shortText,
  note: shortText,
  icon: iconSlot.optional(),
  items: z
    .array(
      QuickItemDataSchema.extend({
        label: quickText(QUICK_SCENE_LIMITS.label),
        detail: z.string().max(QUICK_SCENE_LIMITS.detail),
        icon: iconSlot,
      })
    )
    .max(QUICK_SCENE_LIMITS.items),
  groups: z
    .array(
      QuickGroupDataSchema.extend({
        label: quickText(QUICK_SCENE_LIMITS.label),
        items: z.array(quickText(QUICK_SCENE_LIMITS.detail)).max(QUICK_SCENE_LIMITS.groupItems),
        icon: iconSlot.optional(),
        icons: z.array(iconSlot),
        details: z.array(z.string().max(QUICK_SCENE_LIMITS.entityDetail)).optional(),
      }).refine(
        group =>
          group.icons.length === group.items.length &&
          (group.details === undefined || group.details.length === group.items.length)
      )
    )
    .max(QUICK_SCENE_LIMITS.groups),
});

const PanelValidationSchema = CompositionDataSchema.shape.panels.element.extend({
  title: quickText(QUICK_SCENE_LIMITS.title),
  items: z
    .array(
      SceneDataSchema.shape.items.element.extend({
        label: quickText(QUICK_SCENE_LIMITS.label),
        detail: shortText,
        icon: iconSlot,
      })
    )
    .min(1)
    .max(QUICK_SCENE_LIMITS.panelItems),
});

const CompositionValidationSchema = CompositionDataSchema.extend({
  items: z.array(SceneDataSchema.shape.items.element).length(0),
  groups: z.array(SceneDataSchema.shape.groups.element).length(0),
  title: quickText(QUICK_SCENE_LIMITS.title),
  note: shortText,
  panels: z.array(PanelValidationSchema).length(QUICK_SCENE_LIMITS.panels),
});

const findCompositionProblems = (scene: Record<string, unknown>, source?: string): string[] => {
  if (!CompositionValidationSchema.safeParse(scene).success)
    return ['Invalid composition content.'];
  const panels = scene.panels as LessonScenePanel[];
  if (new Set(panels.map(panel => panel.kind)).size !== QUICK_SCENE_LIMITS.panels) {
    return [
      'Composition requires different inner forms: facts and steps; use comparison for two lists.',
    ];
  }
  if ((scene.panels as Record<string, unknown>[]).some(panel => panel.panels)) {
    return ['Composition panels cannot be nested.'];
  }
  return panels.some(
    panel =>
      panel.kind === 'steps' &&
      (panel.items.length < QUICK_SCENE_LIMITS.sequenceMin ||
        !includesEvidence(source, panel.evidence))
  )
    ? ['Composition steps require at least two steps and exact ordered source evidence.']
    : [];
};

const findTreeProblems = (scene: Record<string, unknown>): string[] => {
  const items = scene.items as LessonSceneItem[];
  if (
    !items.length ||
    items.some(item => !quickText(QUICK_SCENE_LIMITS.treeId).safeParse(item.id).success) ||
    new Set(items.map(item => item.id)).size !== items.length
  )
    return ['Tree requires unique node IDs.'];
  if (items.filter(item => !item.parent).length !== 1) return ['Tree requires one root.'];
  for (const item of items) {
    let node = item;
    const seen = new Set<string>();
    while (node.parent) {
      if (seen.has(node.id as string) || seen.size >= QUICK_SCENE_LIMITS.treeLevels - 1) {
        return ['Tree must be acyclic with at most three levels.'];
      }
      seen.add(node.id as string);
      const parent = items.find(candidate => candidate.id === node.parent);
      if (!parent) return ['Missing tree parent.'];
      node = parent;
    }
  }
  return [];
};

const findPositiveSeriesProblems = (scene: Record<string, unknown>): string[] => {
  const items = scene.items as LessonSceneItem[];
  return !items.length ||
    items.some(item => typeof item.value !== 'number' || item.value < 0) ||
    !items.some(item => (item.value as number) > 0)
    ? ['Positive quantitative series required.']
    : [];
};

const findRadialProblems = (scene: Record<string, unknown>): string[] => {
  const problems = findPositiveSeriesProblems(scene);
  if (problems.length) return problems;
  const items = scene.items as LessonSceneItem[];
  return items.length < QUICK_SCENE_LIMITS.radialMin ||
    items.length > QUICK_SCENE_LIMITS.radialMax ||
    items.some(item => (item.value as number) > (scene.max as number))
    ? ['Radial charts require 3–6 values and a common maximum.']
    : [];
};

const findSequenceProblems = (scene: Record<string, unknown>): string[] => {
  const items = scene.items as LessonSceneItem[];
  return items.length < QUICK_SCENE_LIMITS.sequenceMin ||
    items.length > QUICK_SCENE_LIMITS.sequenceMax
    ? ['Sequence requires 2–6 items.']
    : [];
};

const matrixFields = {
  columns: z
    .array(quickFieldText(QUICK_SCENE_LIMITS.label))
    .min(1)
    .max(QUICK_SCENE_LIMITS.matrixColumns),
  rows: z
    .array(
      z.object({
        label: quickFieldText(QUICK_SCENE_LIMITS.label),
        values: z.array(z.union([z.number(), z.string()])),
      })
    )
    .min(1)
    .max(QUICK_SCENE_LIMITS.matrixRows),
};

const findMatrixProblems = (scene: Record<string, unknown>): string[] => {
  const rows = scene.rows as z.infer<typeof matrixFields.rows>;
  const columns = scene.columns as string[];
  if (columns.some(column => !column.trim()) || rows.some(row => !row.label.trim()))
    return ['Invalid matrix labels.'];
  if (rows.some(row => row.values.length !== columns.length)) return ['Invalid matrix dimensions.'];
  if (scene.type === 'security') {
    return rows.some(row =>
      row.values.some(value => !quickText(QUICK_SCENE_LIMITS.permission).safeParse(value).success)
    )
      ? ['Every permission must be explicit, including unknown permissions.']
      : [];
  }
  return rows.some(row =>
    row.values.some(
      value => typeof value !== 'number' || value < 0 || value > (scene.max as number)
    )
  )
    ? ['Heatmap requires values between zero and max.']
    : [];
};

type SceneValidator = (
  scene: Record<string, unknown>,
  source?: string,
  narration?: string
) => string[];

const findQuickNumberProblems: SceneValidator = (scene, source) => {
  if (source === undefined) return [];
  const items = scene.items as LessonSceneItem[];
  let numbers: number[];
  switch (scene.type) {
    case 'radar':
    case 'polar':
      numbers = [...items.map(item => item.value as number), scene.max as number];
      break;
    case 'funnel':
    case 'treemap':
      numbers = items.map(item => item.value as number);
      break;
    case 'gantt':
      numbers = items.flatMap(item => [item.start as number, item.end as number]);
      break;
    case 'scatter':
      numbers = items.flatMap(item => [item.x as number, item.y as number]);
      break;
    case 'heatmap':
      numbers = [
        ...(scene.rows as { values: number[] }[]).flatMap(row => row.values),
        scene.max as number,
      ];
      break;
    case 'proportional-static':
      numbers = [scene.quantity as number, scene.amountPerUnit as number];
      break;
    default:
      return [];
  }
  const sourceNumbers = readSourceNumbers(source);
  return numbers.every(number => sourceNumbers.has(number))
    ? []
    : ['Quantitative values must appear in the lesson.'];
};

interface SceneForm {
  description: string;
  schema: z.ZodObject;
  validate: SceneValidator;
  animated?: boolean;
  numeric?: boolean;
  needsItems?: boolean;
  diagram?: boolean;
  content?: 'quick' | 'composition';
}

const quickForm = <Fields extends z.ZodRawShape>(
  description: string,
  fields: Fields,
  validate: SceneValidator = () => []
) => ({
  description,
  schema: QuickDataSchema.extend(fields),
  validate: (scene: Record<string, unknown>, source?: string) => {
    const blankField = ['unit', 'center', 'xLabel', 'yLabel'].some(
      field => Object.hasOwn(fields, field) && !(scene[field] as string).trim()
    );
    if (blankField) return ['Static scene labels and units must be non-empty.'];
    const problems = validate(scene, source);
    return problems.length ? problems : findQuickNumberProblems(scene, source);
  },
  content: 'quick' as const,
});

const quantitativeFields = { unit: quickFieldText(QUICK_SCENE_LIMITS.unit) };
const radialFields = { ...quantitativeFields, max: z.number().positive() };

const itemRules = { schema: SceneDataSchema, validate: findItemShapeProblems };

const itemForm = (description: string) => ({ ...itemRules, description });

const groupRules = { schema: SceneDataSchema, validate: findTwoGroupProblems };

const groupForm = (description: string) => ({ ...groupRules, description });

const numericForm = (
  description: string,
  overrides: Partial<Pick<SceneForm, 'validate' | 'needsItems'>> = {}
) => ({
  ...itemRules,
  description,
  numeric: true,
  needsItems: true,
  validate: () => [],
  ...overrides,
});

const diagramForm = (description: string, orderedPath = false) =>
  ({
    schema: SceneDataSchema,
    description,
    diagram: true,
    validate: (scene, source) => findDiagramProblems(scene.diagram, source, orderedPath),
  }) satisfies SceneForm;

/** One entry owns a form's selection rule, data contract, and validation. */
export const LESSON_SCENE_REGISTRY = {
  'formula-spotlight': {
    schema: SceneDataSchema.extend(FormulaSpotlightDataSchema.shape),
    description:
      'Una formula grande con simboli nominati e spiegati, sincronizzati alla narrazione.',
    validate: (scene, source, narration) => [
      ...findFormulaSpotlightProblems(scene, narration ?? source),
      ...((scene.items as unknown[]).length || (scene.groups as unknown[]).length
        ? ['Formula spotlight uses symbols, not items or groups.']
        : []),
    ],
  },
  definition: itemForm('Un concetto e una spiegazione breve.'),
  parts: itemForm('Parti di un concetto o calcoli indipendenti affiancati, senza connessioni.'),
  signals: groupForm(
    'Distinzione esplicita fra indizi esteriori e ragioni verificabili; due gruppi.'
  ),
  comparison: groupForm('Due alternative descritte con criteri comparabili; due gruppi.'),
  matrix: {
    ...groupRules,
    description: 'Due alternative, almeno due criteri esplicitamente confrontabili.',
    validate: scene => {
      const problems = findTwoGroupProblems(scene);
      if (problems.length) return problems;
      return ((scene.criteria as string[] | undefined)?.length ?? 0) >= 2
        ? []
        : ['The matrix form requires at least two criteria.'];
    },
  },
  checklist: itemForm('2–4 domande o controlli pratici.'),
  causal: itemForm('Relazione causale esplicita: non inferire causalità da una lista.'),
  steps: itemForm('Azioni da eseguire in ordine.'),
  timeline: itemForm('Fasi o eventi ordinati nel tempo, esplicitamente forniti.'),
  hierarchy: itemForm('Un concetto superiore e sottoinsiemi espliciti.'),
  network: itemForm('Più fattori che contribuiscono a uno stesso concetto.'),
  cycle: itemForm('Un processo ripetuto esplicitamente. Non inventare un ciclo.'),
  decision: {
    ...groupRules,
    description: 'Una domanda e due esiti condizionali espliciti.',
    validate: scene => {
      const problems = findTwoGroupProblems(scene);
      if (problems.length) return problems;
      return !(scene.quote as string).trim() && !(scene.body as string).trim()
        ? ['The decision form requires its question in quote or body.']
        : [];
    },
  },
  continuum: itemForm('Due estremi qualitativi, senza attribuire punteggi.'),
  balance: groupForm('Due esigenze in tensione da considerare insieme.'),
  concepts: itemForm('Termini diversi e relazioni spiegate.'),
  claim: itemForm('Una tesi e i riscontri che la sostengono.'),
  hypothesis: itemForm('Una domanda verificabile e modi di controllarla.'),
  source: itemForm('Una fonte, il suo ambito e la pertinenza alla richiesta.'),
  counterexample: itemForm('Un esempio che limita una generalizzazione.'),
  limits: itemForm('Cosa mostra un caso e cosa non permette di concludere.'),
  quote: {
    schema: SceneDataSchema,
    description: 'Una citazione o domanda esatta, utile per soffermarsi.',
    validate: scene =>
      (scene.quote as string).trim()
        ? []
        : ['The quote form requires a quotation from the lesson.'],
  },
  roles: itemForm('2–3 persone con ruoli distinti.'),
  beforeafter: groupForm('Un cambiamento esplicito di stato o approccio.'),
  layers: itemForm('Livelli di analisi distinti e annidati.'),
  boundary: itemForm('Un ambito entro cui vale una competenza o affermazione.'),
  number: numericForm(
    'SOLO una quantità esplicita nel testo con unità; mai statistiche inventate.',
    {
      needsItems: false,
      validate: scene =>
        (scene.items as unknown[]).length === 1 ? [] : ['A number shows exactly one quantity.'],
    }
  ),
  bars: numericForm('SOLO quantità confrontabili esplicitamente fornite nel testo.'),
  line: numericForm(
    'SOLO valori numerici associati a tempi espliciti nel testo, alla loro distanza reale.',
    {
      validate: (scene, source) => findLineTimeProblems(scene.items as LessonSceneItem[], source),
    }
  ),
  donut: numericForm('SOLO quantità esplicite che compongono un totale noto.', {
    validate: scene =>
      (scene.items as LessonSceneItem[]).reduce((sum, item) => sum + (item.value as number), 0) > 0
        ? []
        : ['Parts of a whole need a positive total.'],
  }),
  distribution: numericForm('SOLO osservazioni quantitative o frequenze esplicite nel testo.'),
  interval: numericForm('SOLO una stima numerica e limiti dichiarati nel testo.', {
    validate: scene => {
      const items = scene.items as LessonSceneItem[];
      const [low, estimate, high] = items.map(item => item.value as number);
      return items.length !== 3 || low > estimate || estimate > high
        ? ['An interval needs exactly a minimum, an estimate, and a maximum, in order.']
        : [];
    },
  }),
  flowchart: diagramForm('Azioni, decisioni e diramazioni connesse con condizioni esplicite.'),
  sequence: diagramForm(
    'Messaggi connessi e ordinati tra partecipanti: chiamate, risposte ed eventi distinti.'
  ),
  journey: diagramForm('Tappe successive vissute da una persona, senza punteggi inventati.', true),
  proportional: {
    animated: true,
    description: 'Una quantità cresce per unità uguali, con dati e limiti dichiarati nel testo.',
    schema: SceneDataSchema.extend(ProportionalDataSchema.shape),
    validate: (scene, source, narration) =>
      findAnimatedSceneProblems(scene, source, findProportionalSceneProblems, narration),
  },
  'guided-path': {
    animated: true,
    description: `Un percorso esplicito di ${GUIDED_PATH_MIN_STEPS}–${GUIDED_PATH_MAX_STEPS} tappe da seguire gradualmente.`,
    schema: SceneDataSchema.extend(GuidedPathDataSchema.shape),
    validate: (scene, source, narration) =>
      findAnimatedSceneProblems(scene, source, findGuidedPathProblems, narration),
  },
  composition: {
    description: 'Due alternative con proprietà o passaggi interni diversi; massimo due livelli.',
    schema: CompositionDataSchema,
    content: 'composition',
    validate: findCompositionProblems,
  },
  quadrant: quickForm(
    'Quattro categorie definite da due assi qualitativi.',
    {
      xLabel: quickFieldText(QUICK_SCENE_LIMITS.label),
      yLabel: quickFieldText(QUICK_SCENE_LIMITS.label),
    },
    scene =>
      (scene.groups as LessonSceneGroup[]).length === 4
        ? []
        : ['Quadrant requires four groups and both axes.']
  ),
  radar: quickForm(
    'Da tre a sei misure sulla stessa scala dichiarata.',
    radialFields,
    findRadialProblems
  ),
  polar: quickForm(
    'Valori di categorie cicliche sulla stessa scala.',
    radialFields,
    findRadialProblems
  ),
  flywheel: quickForm(
    'Un ciclo esplicito che aggiorna un elemento comune.',
    {
      center: quickFieldText(QUICK_SCENE_LIMITS.unit),
      icon: z.string().optional(),
    },
    scene => {
      const items = scene.items as LessonSceneItem[];
      return items.length < QUICK_SCENE_LIMITS.radialMin ||
        items.length > QUICK_SCENE_LIMITS.radialMax
        ? ['Cycle requires 3–6 stations and a center.']
        : [];
    }
  ),
  tree: quickForm('Gerarchia esplicita, fino a tre livelli.', {}, findTreeProblems),
  stack: quickForm(
    'Livelli separati e ordinati, senza implicare contenimento.',
    {},
    findSequenceProblems
  ),
  venn: quickForm('Due insiemi e la loro intersezione esplicita; aree qualitative.', {}, scene => {
    const groups = scene.groups as LessonSceneGroup[];
    return groups.length !== 3 ||
      groups.some(
        group =>
          group.items.length > 1 ||
          group.label.length > QUICK_SCENE_LIMITS.vennLabel ||
          group.items.some(item => item.length > QUICK_SCENE_LIMITS.vennDetail)
      )
      ? [
          'Venn requires three regions, labels up to 24 characters and one description up to 48 characters per region.',
        ]
      : [];
  }),
  funnel: quickForm(
    'Quantità decrescenti attraverso fasi successive.',
    quantitativeFields,
    scene => {
      const problems = findPositiveSeriesProblems(scene);
      if (problems.length) return problems;
      const items = scene.items as LessonSceneItem[];
      return items.some(
        (item, index) => index > 0 && (item.value as number) > (items[index - 1].value as number)
      )
        ? ['Funnel values must not increase.']
        : [];
    }
  ),
  treemap: quickForm(
    'Quantità positive: area proporzionale al valore.',
    quantitativeFields,
    scene => {
      const problems = findPositiveSeriesProblems(scene);
      if (problems.length) return problems;
      return (scene.items as LessonSceneItem[]).some(item => (item.value as number) <= 0)
        ? ['Treemap values must be positive.']
        : [];
    }
  ),
  heatmap: quickForm(
    'Matrice numerica con scala comune esplicita.',
    {
      ...matrixFields,
      ...radialFields,
    },
    findMatrixProblems
  ),
  gantt: quickForm(
    'Intervalli di tempo espliciti, con unità comune.',
    quantitativeFields,
    scene => {
      const items = scene.items as LessonSceneItem[];
      return !items.length ||
        items.some(
          item =>
            typeof item.start !== 'number' || typeof item.end !== 'number' || item.end <= item.start
        )
        ? ['Gantt requires increasing numeric intervals.']
        : [];
    }
  ),
  scatter: quickForm(
    'Coppie numeriche misurate su due assi.',
    {
      ...quantitativeFields,
      xLabel: quickFieldText(QUICK_SCENE_LIMITS.label),
      yLabel: quickFieldText(QUICK_SCENE_LIMITS.label),
    },
    scene => {
      const items = scene.items as LessonSceneItem[];
      return !items.length ||
        items.some(item => typeof item.x !== 'number' || typeof item.y !== 'number')
        ? ['Scatter requires finite coordinate pairs and axis labels.']
        : [];
    }
  ),
  process: quickForm(
    'Fasi successive, ciascuna con un responsabile o risultato.',
    {},
    findSequenceProblems
  ),
  integration: quickForm(
    'Sorgenti, piattaforma centrale e destinatari.',
    {
      center: quickFieldText(QUICK_SCENE_LIMITS.label),
      icon: z.string().optional(),
    },
    scene => {
      const groups = scene.groups as LessonSceneGroup[];
      return groups.length !== 2 ||
        groups.some(
          group =>
            !group.items.length || group.items.length > QUICK_SCENE_LIMITS.integrationEntities
        )
        ? [
            'Integration requires sources, destinations, and 1–2 named and illustrated entities on each side.',
          ]
        : [];
    }
  ),
  security: quickForm(
    'Permessi espliciti per ogni ruolo e risorsa.',
    matrixFields,
    findMatrixProblems
  ),
  deployment: quickForm('Contenitori di esecuzione con componenti e repliche.', {}, scene => {
    const groups = scene.groups as LessonSceneGroup[];
    return groups.length < QUICK_SCENE_LIMITS.sequenceMin ||
      groups.length > QUICK_SCENE_LIMITS.deploymentGroups
      ? ['Grouped template requires 2–4 groups.']
      : [];
  }),
  'proportional-static': quickForm(
    'Calcolo proporzionale con quantità e costo unitario espliciti.',
    {
      ...quantitativeFields,
      quantity: z.number().int().min(1).max(QUICK_SCENE_LIMITS.items),
      amountPerUnit: z.number().positive(),
    }
  ),
} satisfies Record<string, SceneForm>;

export const LESSON_SCENE_TYPES = Object.keys(LESSON_SCENE_REGISTRY) as readonly LessonSceneType[];

export const STATIC_LESSON_SCENE_TYPES = LESSON_SCENE_CATALOG_SNAPSHOTS[0];

export const LESSON_SCENE_CATALOG = Object.fromEntries(
  LESSON_SCENE_TYPES.map(type => [type, LESSON_SCENE_REGISTRY[type].description])
) as Readonly<Record<LessonSceneType, string>>;

const sceneForms: Readonly<Record<LessonSceneType, SceneForm>> = LESSON_SCENE_REGISTRY;

export const LESSON_SCENE_DIAGRAM_TYPES: ReadonlySet<LessonSceneType> = new Set(
  LESSON_SCENE_TYPES.filter(type => sceneForms[type].diagram)
);

type SceneSchemas = Readonly<Record<string, Pick<SceneForm, 'schema'>>>;

type ShapeKeys<Shape> = Shape extends unknown ? keyof Shape : never;

type ShapeField<Shape, Field> = Shape extends unknown
  ? Field extends keyof Shape
    ? Shape[Field]
    : never
  : never;

type RegisteredShape<Forms extends SceneSchemas> = {
  [Field in ShapeKeys<Forms[keyof Forms]['schema']['shape']> & string]: Extract<
    ShapeField<Forms[keyof Forms]['schema']['shape'], Field>,
    z.ZodType
  >;
};

type DurableShape<Forms extends SceneSchemas> = {
  [Field in keyof RegisteredShape<Forms>]: RegisteredShape<Forms>[Field] extends z.ZodOptional
    ? RegisteredShape<Forms>[Field]
    : z.ZodOptional<RegisteredShape<Forms>[Field]>;
};

/** Merge the entries' data fields into the existing flat durable contract. */
export const createLessonSceneSchema = <Forms extends SceneSchemas>(forms: Forms) => {
  const shape = Object.assign(
    {},
    ...Object.values(forms).map(form => form.schema.shape)
  ) as RegisteredShape<Forms>;
  // Form-specific fields stay optional in the flat envelope so existing stored forms still parse.
  return z
    .object(
      Object.fromEntries(
        Object.entries(shape as z.ZodRawShape).map(([field, rule]) => [
          field,
          rule instanceof z.ZodOptional ? rule : z.optional(rule),
        ])
      ) as DurableShape<Forms>
    )
    .extend({
      ...SceneDataSchema.shape,
      items: (shape as z.ZodRawShape).items as typeof QuickDataSchema.shape.items,
      groups: (shape as z.ZodRawShape).groups as typeof QuickDataSchema.shape.groups,
      type: z.enum(Object.keys(forms) as (keyof Forms & string)[]),
    });
};

export const LessonSceneSchema = createLessonSceneSchema(LESSON_SCENE_REGISTRY);

const animatedSceneSchema = createLessonSceneSchema({
  proportional: LESSON_SCENE_REGISTRY.proportional,
  'guided-path': LESSON_SCENE_REGISTRY['guided-path'],
});

export const LessonSceneAnimationShape = Object.fromEntries(
  Object.entries(animatedSceneSchema.shape).filter(
    ([field]) => field !== 'type' && !Object.hasOwn(SceneDataSchema.shape, field)
  )
) as Omit<typeof animatedSceneSchema.shape, keyof typeof SceneDataSchema.shape | 'type'>;

/** Frozen catalogs retain their form fields and formula-anchor constraints. */
const createFrozenLessonSceneSchema = (
  types: readonly (keyof typeof LESSON_SCENE_REGISTRY)[],
  anchorSchema: z.ZodString
) =>
  createLessonSceneSchema(
    Object.fromEntries(
      types.map(type => [
        type,
        type === 'formula-spotlight'
          ? {
              schema: LESSON_SCENE_REGISTRY[type].schema.extend({
                symbols: FormulaSpotlightDataSchema.shape.symbols.element
                  .extend({ anchor: anchorSchema })
                  .array()
                  .min(1),
              }),
            }
          : LESSON_SCENE_REGISTRY[type],
      ])
    )
  ) as typeof LessonSceneSchema;

export const HistoricalLessonSceneSchemas = [
  ...LESSON_SCENE_CATALOG_SNAPSHOTS.map(types =>
    createFrozenLessonSceneSchema(types, z.string().min(1).regex(/\S/u))
  ),
  createFrozenLessonSceneSchema(UNLINKED_FORMULA_SCENE_CATALOG_SNAPSHOT, z.string()),
];

const findFormContentProblems = (
  form: SceneForm,
  value: Record<string, unknown>,
  {
    source,
    narration,
    quoteProblems,
  }: { source?: string; narration?: string; quoteProblems: string[] }
): string[] => {
  if (form.content) {
    const contentProblems =
      form.content === 'quick' && !QuickContentValidationSchema.safeParse(value).success
        ? ['Invalid static scene content.']
        : [];
    return [
      ...contentProblems,
      ...(contentProblems.length ? [] : form.validate(value, source, narration)),
      ...quoteProblems,
      ...findRelationProblems(value.relation, source),
    ];
  }
  if (form.animated || form.diagram) {
    const content = form.animated
      ? 'Animated forms keep their content in quantity parameters or steps'
      : 'A diagram form keeps its content in diagram';
    return [
      ...form.validate(value, source, narration),
      ...((value.items as unknown[]).length || (value.groups as unknown[]).length
        ? [`${content}: items and groups must be empty.`]
        : []),
      ...quoteProblems,
    ];
  }
  const numericProblems = form.numeric ? findNumericProblems(value, source) : [];
  return [
    ...(form.needsItems ? findItemShapeProblems(value) : []),
    ...(numericProblems.length ? numericProblems : form.validate(value, source, narration)),
    ...quoteProblems,
    ...findRelationProblems(value.relation, source),
  ];
};

/** Ground content in source text; an optional canonical narration owns synchronized cue quotations. */
export const findLessonSceneProblems = (
  value: unknown,
  source?: string,
  narration?: string
): string[] => {
  if (!isRecord(value)) return ['A scene must be an object.'];
  if (!isSceneType(value.type)) return ['The scene type is not in the catalog.'];
  const textProblems = ['title', 'body', 'quote', 'note'].some(key => !isText(value[key]))
    ? ['title, body, quote, and note must be short strings.']
    : [];
  const structural = [
    ...textProblems,
    ...(sceneForms[value.type].content
      ? []
      : [...findItemProblems(value.items), ...findGroupProblems(value.groups, value.criteria)]),
  ];
  if (structural.length) return structural;
  const type = value.type;
  const quoteProblems =
    source !== undefined && value.quote && !source.includes(value.quote as string)
      ? ['The quote must be copied exactly from the lesson.']
      : [];
  const form = sceneForms[type];
  // The flat stored envelope keeps form fields optional; the selected form still owns its contract.
  const formFields = form.schema.safeParse(value);
  if (!formFields.success) {
    return formFields.error.issues.map(
      issue => `${issue.path.join('.') || type}: ${issue.message}`
    );
  }
  return findFormContentProblems(form, value, { source, narration, quoteProblems });
};

export const isLessonScene = (value: unknown): value is LessonScene =>
  findLessonSceneProblems(value).length === 0;

/** Identifies an item, group entity, heading, center, or panel icon slot. */
export type LessonSceneIconSlot =
  | {
      readonly item: number;
      readonly kind: 'item';
    }
  | {
      readonly entry: number;
      readonly group: number;
      readonly kind: 'group';
    }
  | {
      readonly item: number;
      readonly panel: number;
      readonly kind: 'panel';
    }
  | {
      readonly group: number;
      readonly kind: 'group-icon';
    }
  | {
      readonly kind: 'center';
    };

// Only labels enter the Mermaid grammar; identifiers, shapes, and arrows are generated here.
const mermaidLabel = (text: string): string =>
  text
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[&"<>#%;`[\]{}]/gu, character => `#${character.codePointAt(0)};`);

const quotedEdgeLabel = (text: string): string => `|"${mermaidLabel(text)}"|`;

/** Builds Mermaid source for a validated diagram scene. */
export const buildLessonSceneDiagramSource = (
  scene: SceneContentData,
  direction: 'LR' | 'TD' = 'LR'
): string => {
  const diagram = scene.diagram as LessonSceneDiagram;
  const ids = new Map(diagram.nodes.map((node, index) => [node.id, `n${index}`]));
  const id = (nodeId: string): string => ids.get(nodeId) as string;
  if (scene.type === 'sequence') {
    const arrows = { call: '->>', event: '--)', return: '-->>' } as const;
    return [
      'sequenceDiagram',
      'autonumber',
      ...diagram.nodes.map(node => `participant ${id(node.id)} as ${mermaidLabel(node.label)}`),
      ...diagram.edges.map(
        edge => `${id(edge.from)}${arrows[edge.kind]}${id(edge.to)}: ${mermaidLabel(edge.label)}`
      ),
    ].join('\n');
  }
  const shapes = {
    decision: (text: string) => `{${text}}`,
    end: (text: string) => `([${text}])`,
    start: (text: string) => `([${text}])`,
    step: (text: string) => `(${text})`,
  } as const;
  return [
    `flowchart ${direction}`,
    ...diagram.nodes.map(node => {
      const shape = shapes[node.kind](`"${mermaidLabel(node.label)}"`);
      return `${id(node.id)}${shape}`;
    }),
    ...diagram.edges.map(edge => {
      const arrow = edge.kind === 'event' ? '-.->' : '-->';
      const label = edge.label ? quotedEdgeLabel(edge.label) : '';
      return `${id(edge.from)} ${arrow}${label} ${id(edge.to)}`;
    }),
  ].join('\n');
};
