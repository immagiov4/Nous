import { cueTimes, playbackMode } from './lessonSceneAnimation';

/**
 * Lesson scene contract: a validated JSON description of one lesson visual, chosen from a fixed
 * catalog of forms. The model fills content; the reader components own geometry and style, so
 * scenes stay legible and can be restyled later without regeneration.
 *
 * Validation is deterministic and returns problems instead of throwing, so the backend can feed
 * them back to the model as corrective feedback and the persistence layer can reject bad data.
 */

/** The original catalog also identifies the durable contract deployed before animated scenes. */
export const STATIC_LESSON_SCENE_TYPES = [
  'definition',
  'parts',
  'signals',
  'comparison',
  'matrix',
  'checklist',
  'causal',
  'steps',
  'timeline',
  'hierarchy',
  'network',
  'cycle',
  'decision',
  'continuum',
  'balance',
  'concepts',
  'claim',
  'hypothesis',
  'source',
  'counterexample',
  'limits',
  'quote',
  'roles',
  'beforeafter',
  'layers',
  'boundary',
  'number',
  'bars',
  'line',
  'donut',
  'distribution',
  'interval',
  'flowchart',
  'sequence',
  'journey',
] as const;

export const LESSON_SCENE_TYPES = [
  ...STATIC_LESSON_SCENE_TYPES,
  'proportional',
  'guided-path',
] as const;

export type LessonSceneType = (typeof LESSON_SCENE_TYPES)[number];

/** Selection rule for each form; the model reads it before choosing. */
export const LESSON_SCENE_CATALOG: Readonly<Record<LessonSceneType, string>> = {
  balance: 'Due esigenze in tensione da considerare insieme.',
  bars: 'SOLO quantità confrontabili esplicitamente fornite nel testo.',
  beforeafter: 'Un cambiamento esplicito di stato o approccio.',
  boundary: 'Un ambito entro cui vale una competenza o affermazione.',
  causal: 'Relazione causale esplicita: non inferire causalità da una lista.',
  checklist: '2–4 domande o controlli pratici.',
  claim: 'Una tesi e i riscontri che la sostengono.',
  comparison: 'Due alternative descritte con criteri comparabili; due gruppi.',
  concepts: 'Termini diversi e relazioni spiegate.',
  continuum: 'Due estremi qualitativi, senza attribuire punteggi.',
  counterexample: 'Un esempio che limita una generalizzazione.',
  cycle: 'Un processo ripetuto esplicitamente. Non inventare un ciclo.',
  decision: 'Una domanda e due esiti condizionali espliciti.',
  definition: 'Un concetto e una spiegazione breve.',
  distribution: 'SOLO osservazioni quantitative o frequenze esplicite nel testo.',
  donut: 'SOLO quantità esplicite che compongono un totale noto.',
  flowchart: 'Azioni, decisioni e diramazioni con condizioni esplicite.',
  'guided-path': 'Un percorso esplicito da seguire gradualmente, una tappa alla volta.',
  hierarchy: 'Un concetto superiore e sottoinsiemi espliciti.',
  hypothesis: 'Una domanda verificabile e modi di controllarla.',
  interval: 'SOLO una stima numerica e limiti dichiarati nel testo.',
  journey: 'Tappe successive vissute da una persona, senza punteggi inventati.',
  layers: 'Livelli di analisi distinti e annidati.',
  limits: 'Cosa mostra un caso e cosa non permette di concludere.',
  line: 'SOLO valori numerici associati a tempi espliciti nel testo, alla loro distanza reale.',
  matrix: 'Due alternative, almeno due criteri esplicitamente confrontabili.',
  network: 'Più fattori che contribuiscono a uno stesso concetto.',
  number: 'SOLO una quantità esplicita nel testo con unità; mai statistiche inventate.',
  parts: 'Un concetto composto da 2–4 parti.',
  proportional: 'Una quantità cresce per unità uguali, con dati e limiti dichiarati nel testo.',
  quote: 'Una citazione o domanda esatta, utile per soffermarsi.',
  roles: '2–3 persone con ruoli distinti.',
  sequence: 'Messaggi ordinati tra partecipanti: chiamate, risposte ed eventi distinti.',
  signals: 'Distinzione esplicita fra indizi esteriori e ragioni verificabili; due gruppi.',
  source: 'Una fonte, il suo ambito e la pertinenza alla richiesta.',
  steps: 'Azioni da eseguire in ordine.',
  timeline: 'Fasi o eventi ordinati nel tempo, esplicitamente forniti.',
};

export const LESSON_SCENE_NUMERIC_TYPES: ReadonlySet<LessonSceneType> = new Set([
  'number',
  'bars',
  'line',
  'donut',
  'distribution',
  'interval',
]);

export const LESSON_SCENE_DIAGRAM_TYPES: ReadonlySet<LessonSceneType> = new Set([
  'flowchart',
  'sequence',
  'journey',
]);

const TWO_GROUP_TYPES: ReadonlySet<LessonSceneType> = new Set([
  'signals',
  'comparison',
  'matrix',
  'decision',
  'balance',
  'beforeafter',
]);

const ITEMLESS_TYPES: ReadonlySet<LessonSceneType> = new Set([
  ...TWO_GROUP_TYPES,
  'quote',
  'number',
  ...LESSON_SCENE_DIAGRAM_TYPES,
]);

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
export type LessonSceneVerdict = (typeof LESSON_SCENE_VERDICTS)[number];

export const LESSON_SCENE_NODE_KINDS = ['step', 'decision', 'start', 'end'] as const;
export const LESSON_SCENE_EDGE_KINDS = ['call', 'return', 'event'] as const;

/** Content limits inherited from the validated prototype catalog. */
export const LESSON_SCENE_LIMITS = {
  diagramEdges: 12,
  diagramLabel: 100,
  diagramNodes: 8,
  groups: 3,
  items: 6,
  relationLabel: 160,
  text: 600,
} as const;

export interface LessonSceneItem {
  readonly detail: string;
  readonly icon: string;
  readonly label: string;
  /** A line point's position on the time axis as written in the lesson, such as a year. */
  readonly time?: number;
  readonly value?: number;
}

export interface LessonSceneGroup {
  readonly icons: string[];
  readonly items: string[];
  readonly label: string;
  readonly verdict?: LessonSceneVerdict;
}

export interface LessonSceneRelation {
  readonly evidence: string;
  readonly kind: LessonSceneRelationKind;
  readonly label: string;
}

export interface LessonSceneDiagramNode {
  readonly id: string;
  readonly kind: (typeof LESSON_SCENE_NODE_KINDS)[number];
  readonly label: string;
}

export interface LessonSceneDiagramEdge {
  readonly evidence: string;
  readonly from: string;
  readonly kind: (typeof LESSON_SCENE_EDGE_KINDS)[number];
  readonly label: string;
  readonly to: string;
}

export interface LessonSceneDiagram {
  readonly edges: LessonSceneDiagramEdge[];
  readonly nodes: LessonSceneDiagramNode[];
}

export interface LessonSceneCue {
  readonly anchor?: string;
  readonly value: number;
}

export interface LessonScenePathStep {
  readonly anchor?: string;
  readonly label: string;
  readonly detail: string;
}

export interface LessonScene {
  readonly autoplay?: boolean;
  readonly durationMs?: number;
  readonly narration?: string;
  readonly inputLabel?: string;
  readonly unitLabel?: string;
  readonly min?: number;
  readonly max?: number;
  readonly initial?: number;
  readonly amountPerUnit?: number;
  readonly outputUnit?: string;
  readonly outputLabel?: string;
  readonly assumption?: string;
  readonly cues?: LessonSceneCue[];
  readonly steps?: LessonScenePathStep[];
  readonly body: string;
  readonly criteria?: string[];
  readonly diagram?: LessonSceneDiagram;
  readonly groups: LessonSceneGroup[];
  readonly items: LessonSceneItem[];
  readonly note: string;
  readonly quote: string;
  readonly relation?: LessonSceneRelation;
  readonly title: string;
  readonly type: LessonSceneType;
}

export interface ProportionalLessonScene extends LessonScene {
  readonly type: 'proportional';
  readonly autoplay: boolean;
  readonly inputLabel: string;
  readonly unitLabel: string;
  readonly min: number;
  readonly max: number;
  readonly initial: number;
  readonly amountPerUnit: number;
  readonly outputUnit: string;
  readonly outputLabel: string;
  readonly assumption: string;
}

export interface GuidedPathLessonScene extends LessonScene {
  readonly type: 'guided-path';
  readonly autoplay: boolean;
  readonly steps: LessonScenePathStep[];
}

export type AnimatedLessonScene = ProportionalLessonScene | GuidedPathLessonScene;

/** Callers supply validated scenes; the form identifies its animation contract. */
export const isAnimatedLessonScene = (scene: LessonScene): scene is AnimatedLessonScene =>
  scene.type === 'proportional' || scene.type === 'guided-path';

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
const isIconSlot = (value: unknown): boolean =>
  value === '' || (typeof value === 'string' && ICON_NAME_PATTERN.test(value));
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

const isDiagramNode = (node: unknown): node is LessonSceneDiagramNode =>
  isRecord(node) &&
  typeof node.id === 'string' &&
  isText(node.label, LESSON_SCENE_LIMITS.diagramLabel) &&
  node.label.trim() !== '' &&
  (LESSON_SCENE_NODE_KINDS as readonly unknown[]).includes(node.kind);

const isDiagramEdge = (
  edge: unknown,
  nodeIds: ReadonlySet<string>
): edge is LessonSceneDiagramEdge =>
  isRecord(edge) &&
  typeof edge.from === 'string' &&
  typeof edge.to === 'string' &&
  nodeIds.has(edge.from) &&
  nodeIds.has(edge.to) &&
  isText(edge.label, LESSON_SCENE_LIMITS.diagramLabel) &&
  (LESSON_SCENE_EDGE_KINDS as readonly unknown[]).includes(edge.kind);

/** Topology constraints apply after nodes and connections have passed structural validation. */
const findDiagramTopologyProblems = (
  nodes: readonly LessonSceneDiagramNode[],
  edges: readonly LessonSceneDiagramEdge[],
  type: LessonSceneType
): string[] => {
  const problems: string[] = [];
  if (!isConnectedGraph(nodes, edges)) {
    problems.push('Every diagram node must be connected.');
  }
  for (const node of nodes.filter(candidate => candidate.kind === 'decision')) {
    if (edges.some(edge => edge.from === node.id && !edge.label.trim())) {
      problems.push('Branches leaving a decision need condition labels.');
    }
  }
  const isOrderedPath =
    edges.length === nodes.length - 1 &&
    edges.every(
      (edge, index) => edge.from === nodes[index]?.id && edge.to === nodes[index + 1]?.id
    );
  if (type === 'journey' && !isOrderedPath) {
    problems.push('A journey must follow its nodes in order, without jumps or branches.');
  }
  return problems;
};

const findDiagramProblems = (
  diagram: unknown,
  type: LessonSceneType,
  source: string | undefined
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
  return [...problems, ...findDiagramTopologyProblems(typedNodes, typedEdges, type)];
};

const findItemProblems = (items: unknown): string[] => {
  if (!Array.isArray(items) || items.length > LESSON_SCENE_LIMITS.items) {
    return [`items must be an array of at most ${LESSON_SCENE_LIMITS.items} entries.`];
  }
  const valid = items.every(
    item =>
      isRecord(item) &&
      isText(item.label) &&
      item.label.trim() !== '' &&
      isText(item.detail) &&
      isIconSlot(item.icon) &&
      (item.time === undefined || (typeof item.time === 'number' && Number.isFinite(item.time)))
  );
  return valid ? [] : ['Every item needs a label, a detail, and an icon identifier.'];
};

const findGroupProblems = (groups: unknown, criteria: unknown): string[] => {
  if (!Array.isArray(groups) || groups.length > LESSON_SCENE_LIMITS.groups) {
    return [`groups must be an array of at most ${LESSON_SCENE_LIMITS.groups} entries.`];
  }
  for (const group of groups) {
    if (
      !isRecord(group) ||
      !isText(group.label) ||
      !Array.isArray(group.items) ||
      !group.items.every(item => isText(item) && item.trim() !== '') ||
      !Array.isArray(group.icons) ||
      group.icons.length !== group.items.length ||
      !group.icons.every(isIconSlot)
    ) {
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
    Array.isArray(criteria) &&
    criteria.every(criterion => isText(criterion)) &&
    groups.every(group => (group as { items: unknown[] }).items.length === criteria.length);
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

/**
 * Readings of one written number. Mixed separators (1.234,5) and a repeated separator (1.234.567)
 * are unambiguous; only a single separator before exactly three digits (1.234) can be either a
 * thousands group or a decimal point, so both readings are kept. A repeated separator whose
 * groups are not thousands groups (1.2.3) is a version or identifier, not a quantity, so it gives
 * no reading.
 */
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

/**
 * Readings of one matched token. A space before three digits either groups thousands (1 234) or
 * separates two numbers (2024 120), so both the joined and the separate readings are kept.
 */
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

/**
 * A line places its points at their real distance in time, so every point needs a time stated in
 * the lesson, in increasing order.
 */
const findLineTimeProblems = (
  items: readonly LessonSceneItem[],
  source: string | undefined
): string[] => {
  const times = items.map(item => item.time);
  const increasing = times.every(
    (time, index) =>
      time !== undefined && (index === 0 || time > (times[index - 1] ?? Number.POSITIVE_INFINITY))
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
  if (scene.type === 'line') {
    const lineProblems = findLineTimeProblems(items, source);
    if (lineProblems.length) return lineProblems;
  }
  if (scene.type === 'number' && items.length !== 1)
    return ['A number shows exactly one quantity.'];
  if (scene.type === 'donut' && items.reduce((sum, item) => sum + (item.value ?? 0), 0) <= 0) {
    return ['Parts of a whole need a positive total.'];
  }
  const [low, estimate, high] = items.map(item => item.value ?? 0);
  if (
    scene.type === 'interval' &&
    (items.length !== 3 || (low ?? 0) > (estimate ?? 0) || (estimate ?? 0) > (high ?? 0))
  ) {
    return ['An interval needs exactly a minimum, an estimate, and a maximum, in order.'];
  }
  return [];
};

const findShapeProblems = (scene: Record<string, unknown>, type: LessonSceneType): string[] => {
  const groups = scene.groups as LessonSceneGroup[];
  const items = scene.items as LessonSceneItem[];
  if (
    TWO_GROUP_TYPES.has(type) &&
    (groups.length !== 2 || groups.some(group => !group.items.length))
  ) {
    return [`The ${type} form requires exactly two non-empty groups.`];
  }
  if (!ITEMLESS_TYPES.has(type) && items.length < 2) {
    return [`The ${type} form requires at least two items.`];
  }
  if (type === 'decision' && !(scene.quote as string).trim() && !(scene.body as string).trim()) {
    return ['The decision form requires its question in quote or body.'];
  }
  if (type === 'quote' && !(scene.quote as string).trim()) {
    return ['The quote form requires a quotation from the lesson.'];
  }
  const criteria = scene.criteria as string[] | undefined;
  if (type === 'matrix' && (criteria?.length ?? 0) < 2) {
    return ['The matrix form requires at least two criteria.'];
  }
  return [];
};

const findAnimatedSceneProblems = (
  scene: Record<string, unknown>,
  source: string | undefined
): string[] => {
  const problems: string[] = [];
  if (typeof scene.autoplay !== 'boolean') problems.push('Autoplay must be explicit.');
  if (
    scene.durationMs !== undefined &&
    (typeof scene.durationMs !== 'number' ||
      !Number.isFinite(scene.durationMs) ||
      scene.durationMs <= 0)
  ) {
    problems.push('Invalid duration.');
  }
  if (scene.type === 'proportional') {
    const { min, max, initial, amountPerUnit } = scene;
    if (
      ![min, max, initial].every(Number.isInteger) ||
      (min as number) < 1 ||
      (max as number) < (min as number) ||
      (initial as number) < (min as number) ||
      (initial as number) > (max as number)
    )
      problems.push('Invalid quantity bounds.');
    if (
      typeof amountPerUnit !== 'number' ||
      !Number.isFinite(amountPerUnit) ||
      amountPerUnit <= 0
    ) {
      problems.push('Invalid unit amount.');
    }
    if (
      ['inputLabel', 'unitLabel', 'outputUnit', 'outputLabel', 'assumption'].some(
        key => typeof scene[key] !== 'string' || !(scene[key] as string).trim()
      )
    )
      problems.push('Missing quantity label.');
    if (
      scene.cues !== undefined &&
      (!Array.isArray(scene.cues) ||
        scene.cues.some(
          cue =>
            !isRecord(cue) ||
            typeof cue.value !== 'number' ||
            (cue.anchor !== undefined && typeof cue.anchor !== 'string')
        ))
    )
      problems.push('Invalid quantity cues.');
  } else if (
    !Array.isArray(scene.steps) ||
    scene.steps.length < 2 ||
    scene.steps.some(
      step =>
        !isRecord(step) ||
        typeof step.label !== 'string' ||
        !step.label.trim() ||
        typeof step.detail !== 'string' ||
        !step.detail.trim() ||
        (step.anchor !== undefined && typeof step.anchor !== 'string')
    )
  )
    problems.push('Invalid path.');
  if (scene.narration !== undefined && typeof scene.narration !== 'string') {
    problems.push('Narration must be text.');
  }
  if (problems.length) return problems;
  const animated = scene as unknown as AnimatedLessonScene;
  const narration = source ?? animated.narration;
  // Stored scenes may carry only anchors; exactness can be checked when lesson text is available.
  if (narration !== undefined && playbackMode(animated) === 'text') {
    try {
      cueTimes(narration, animated.type === 'guided-path' ? animated.steps : (animated.cues ?? []));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      problems.push(error.message);
    }
  }
  return problems;
};

/**
 * Returns every contract violation of a scene. With `source`, quotations, quantities, relations,
 * and diagram connections must also be grounded in that lesson text.
 */
export const findLessonSceneProblems = (value: unknown, source?: string): string[] => {
  if (!isRecord(value)) return ['A scene must be an object.'];
  if (!isSceneType(value.type)) return ['The scene type is not in the catalog.'];
  const textProblems = ['title', 'body', 'quote', 'note'].some(key => !isText(value[key]))
    ? ['title, body, quote, and note must be short strings.']
    : [];
  const structural = [
    ...textProblems,
    ...findItemProblems(value.items),
    ...findGroupProblems(value.groups, value.criteria),
  ];
  if (structural.length) return structural;
  const type = value.type;
  const quoteProblems =
    source !== undefined && value.quote && !source.includes(value.quote as string)
      ? ['The quote must be copied exactly from the lesson.']
      : [];
  if (type === 'proportional' || type === 'guided-path') {
    return [
      ...findAnimatedSceneProblems(value, source),
      ...((value.items as unknown[]).length || (value.groups as unknown[]).length
        ? [
            'Animated forms keep their content in quantity parameters or steps: items and groups must be empty.',
          ]
        : []),
      ...quoteProblems,
    ];
  }
  if (LESSON_SCENE_DIAGRAM_TYPES.has(type)) {
    // The renderer draws only the diagram, so items or groups would be silently dropped.
    const unusedContent =
      (value.items as unknown[]).length || (value.groups as unknown[]).length
        ? ['A diagram form keeps its content in diagram: items and groups must be empty.']
        : [];
    return [
      ...findDiagramProblems(value.diagram, type, source),
      ...unusedContent,
      ...quoteProblems,
    ];
  }
  return [
    ...findShapeProblems(value, type),
    ...(LESSON_SCENE_NUMERIC_TYPES.has(type) ? findNumericProblems(value, source) : []),
    ...quoteProblems,
    ...findRelationProblems(value.relation, source),
  ];
};

export const isLessonScene = (value: unknown): value is LessonScene =>
  findLessonSceneProblems(value).length === 0;

/** Identifies one icon slot of a scene: an item or an entry of a group. */
export type LessonSceneIconSlot =
  | { readonly item: number; readonly kind: 'item' }
  | { readonly entry: number; readonly group: number; readonly kind: 'group' };

// Only labels enter the Mermaid grammar; identifiers, shapes, and arrows are generated here.
const mermaidLabel = (text: string): string =>
  text
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[&"<>#%;`[\]{}]/gu, character => `#${character.codePointAt(0)};`);

const quotedEdgeLabel = (text: string): string => `|"${mermaidLabel(text)}"|`;

/** Builds Mermaid source for a validated diagram scene. */
export const buildLessonSceneDiagramSource = (
  scene: LessonScene,
  direction: 'LR' | 'TD' = 'LR'
): string => {
  const diagram = scene.diagram;
  if (!diagram) throw new Error('The scene has no diagram.');
  const ids = new Map(diagram.nodes.map((node, index) => [node.id, `n${index}`]));
  const id = (nodeId: string): string => ids.get(nodeId) ?? nodeId;
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
