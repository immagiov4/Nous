/**
 * Lesson scene contract: a validated JSON description of one lesson visual, chosen from a fixed
 * catalog of forms. The model fills content; the reader components own geometry and style, so
 * scenes stay legible and can be restyled later without regeneration.
 *
 * Validation is deterministic and returns problems instead of throwing, so the backend can feed
 * them back to the model as corrective feedback and the persistence layer can reject bad data.
 */

export const LESSON_SCENE_TYPES = [
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
  hierarchy: 'Un concetto superiore e sottoinsiemi espliciti.',
  hypothesis: 'Una domanda verificabile e modi di controllarla.',
  interval: 'SOLO una stima numerica e limiti dichiarati nel testo.',
  journey: 'Tappe successive vissute da una persona, senza punteggi inventati.',
  layers: 'Livelli di analisi distinti e annidati.',
  limits: 'Cosa mostra un caso e cosa non permette di concludere.',
  line: 'SOLO valori numerici associati a tempi espliciti nel testo.',
  matrix: 'Due alternative, almeno due criteri esplicitamente confrontabili.',
  network: 'Più fattori che contribuiscono a uno stesso concetto.',
  number: 'SOLO una quantità esplicita nel testo con unità; mai statistiche inventate.',
  parts: 'Un concetto composto da 2–4 parti.',
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

export interface LessonScene {
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

const ICON_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number = LESSON_SCENE_LIMITS.text): value is string =>
  typeof value === 'string' && value.length <= max;
const isIconSlot = (value: unknown): boolean =>
  value === '' || (typeof value === 'string' && ICON_NAME_PATTERN.test(value));
const isSceneType = (value: unknown): value is LessonSceneType =>
  typeof value === 'string' && (LESSON_SCENE_TYPES as readonly string[]).includes(value);
const includesEvidence = (source: string | undefined, evidence: unknown): boolean =>
  source === undefined ||
  (typeof evidence === 'string' && evidence.trim() !== '' && source.includes(evidence));

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
    if (
      !isRecord(node) ||
      typeof node.id !== 'string' ||
      ids.has(node.id) ||
      !isText(node.label, LESSON_SCENE_LIMITS.diagramLabel) ||
      !node.label.trim() ||
      !(LESSON_SCENE_NODE_KINDS as readonly unknown[]).includes(node.kind)
    ) {
      problems.push('Every diagram node needs a unique id, a short label, and a valid kind.');
      return problems;
    }
    ids.add(node.id);
  }
  const connected = new Set<string>();
  for (const edge of edges) {
    if (
      !isRecord(edge) ||
      typeof edge.from !== 'string' ||
      typeof edge.to !== 'string' ||
      !ids.has(edge.from) ||
      !ids.has(edge.to) ||
      !isText(edge.label, LESSON_SCENE_LIMITS.diagramLabel) ||
      !(LESSON_SCENE_EDGE_KINDS as readonly unknown[]).includes(edge.kind)
    ) {
      problems.push('Every diagram connection must join existing nodes with a valid kind.');
      return problems;
    }
    if (!includesEvidence(source, edge.evidence)) {
      problems.push(`The connection "${edge.label}" needs an exact quotation from the lesson.`);
    }
    connected.add(edge.from);
    connected.add(edge.to);
  }
  if (connected.size !== ids.size) problems.push('Every diagram node must be connected.');
  const typedEdges = edges as LessonSceneDiagramEdge[];
  const typedNodes = nodes as LessonSceneDiagramNode[];
  for (const node of typedNodes.filter(candidate => candidate.kind === 'decision')) {
    if (typedEdges.some(edge => edge.from === node.id && !edge.label.trim())) {
      problems.push('Branches leaving a decision need condition labels.');
    }
  }
  const isOrderedPath =
    typedEdges.length === typedNodes.length - 1 &&
    typedEdges.every(
      (edge, index) => edge.from === typedNodes[index]?.id && edge.to === typedNodes[index + 1]?.id
    );
  if (type === 'journey' && !isOrderedPath) {
    problems.push('A journey must follow its nodes in order, without jumps or branches.');
  }
  return problems;
};

const findItemProblems = (items: unknown): string[] => {
  if (!Array.isArray(items) || items.length > LESSON_SCENE_LIMITS.items) {
    return [`items must be an array of at most ${LESSON_SCENE_LIMITS.items} entries.`];
  }
  const valid = items.every(
    item => isRecord(item) && isText(item.label) && isText(item.detail) && isIconSlot(item.icon)
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
      !group.items.every(item => isText(item)) ||
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

// Numbers written in the lesson: digits with optional thousands separators and a decimal part,
// in either the Italian (1.234,5) or the English (1,234.5) convention.
const SOURCE_NUMBER_PATTERN = /\d+(?:[.,\s]\d{3})*(?:[.,]\d+)?/gu;

const readSourceNumbers = (source: string): Set<number> => {
  const numbers = new Set<number>();
  for (const [token] of source.matchAll(SOURCE_NUMBER_PATTERN)) {
    const digits = token.replaceAll(/\s/gu, '');
    const lastSeparator = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
    if (lastSeparator < 0) {
      numbers.add(Number(digits));
      continue;
    }
    const decimals = digits.slice(lastSeparator + 1);
    const integerPart = digits.slice(0, lastSeparator).replaceAll(/[.,]/gu, '');
    numbers.add(Number(`${integerPart}.${decimals}`));
    // Only a final group of exactly three digits can be a thousands group (1.234 or 1,234).
    if (decimals.length === 3) numbers.add(Number(`${integerPart}${decimals}`));
  }
  return numbers;
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
  if (TWO_GROUP_TYPES.has(type) && groups.length !== 2) {
    return [`The ${type} form requires exactly two groups.`];
  }
  if (!ITEMLESS_TYPES.has(type) && items.length < 2) {
    return [`The ${type} form requires at least two items.`];
  }
  return [];
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
  if (LESSON_SCENE_DIAGRAM_TYPES.has(type)) return findDiagramProblems(value.diagram, type, source);
  return [
    ...findShapeProblems(value, type),
    ...(LESSON_SCENE_NUMERIC_TYPES.has(type) ? findNumericProblems(value, source) : []),
    ...(source !== undefined && value.quote && !source.includes(value.quote as string)
      ? ['The quote must be copied exactly from the lesson.']
      : []),
    ...findRelationProblems(value.relation, source),
  ];
};

export const isLessonScene = (value: unknown): value is LessonScene =>
  findLessonSceneProblems(value).length === 0;

/** Identifies one icon slot of a scene: an item or an entry of a group. */
export type LessonSceneIconSlot =
  | { readonly item: number; readonly kind: 'item' }
  | { readonly entry: number; readonly group: number; readonly kind: 'group' };

export const listLessonSceneIconSlots = (scene: LessonScene): LessonSceneIconSlot[] => [
  ...scene.items.map((_, item) => ({ item, kind: 'item' as const })),
  ...scene.groups.flatMap((group, groupIndex) =>
    group.items.map((_, entry) => ({ entry, group: groupIndex, kind: 'group' as const }))
  ),
];

// Only labels enter the Mermaid grammar; identifiers, shapes, and arrows are generated here.
const mermaidLabel = (text: string): string =>
  text
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[&"<>#%;`[\]{}]/gu, character => `#${character.charCodeAt(0)};`);

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
    ...diagram.nodes.map(
      node => `${id(node.id)}${shapes[node.kind](`"${mermaidLabel(node.label)}"`)}`
    ),
    ...diagram.edges.map(
      edge =>
        `${id(edge.from)} ${edge.kind === 'event' ? '-.->' : '-->'}${edge.label ? `|"${mermaidLabel(edge.label)}"|` : ''} ${id(edge.to)}`
    ),
  ].join('\n');
};
