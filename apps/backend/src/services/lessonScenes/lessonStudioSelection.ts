import {
  type AlgorithmLessonScene,
  findLessonSceneProblems,
  type GeometryLessonScene,
  type LessonSceneType,
  type StudioLessonScene,
} from '@shared/lessonScene';
import { type StudioNarrationCue, studioCueOffset } from '@shared/lessonSceneAnimation';
import { AlgorithmStudioSchema, algorithmStudioTitle } from '@shared/lessonStudios/algorithm';
import {
  checkAlgorithmGeometry,
  loadMusicStaff,
  needsMusicStaff,
} from '@shared/lessonStudios/algorithmLayout';
import { arrayCopy } from '@shared/lessonStudios/array-algorithm.copy.it';
import { ArraySpecSchema } from '@shared/lessonStudios/arrayAlgorithm';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { functionPlotModelGuide, functionPlotTitle } from '@shared/lessonStudios/functionPlot';
import { GeometrySelectionSchema } from '@shared/lessonStudios/geometry';
import { graphModelGuide } from '@shared/lessonStudios/graph';
import type { GraphSpec } from '@shared/lessonStudios/graphSpec';
import { HEAP_MAX_BEATS, HeapSpecSchema } from '@shared/lessonStudios/heap';
import type { StudioCheck } from '@shared/lessonStudios/layoutValidation';
import { musicModelGuide } from '@shared/lessonStudios/musicSpec';
import { planeModelGuide } from '@shared/lessonStudios/plane';
import { space3dModelGuide } from '@shared/lessonStudios/space3dSpec';
import { namesLabel } from '@shared/lessonStudios/studioBeatSync';
import { trajectoriesModelGuide } from '@shared/lessonStudios/trajectories';
import * as z from 'zod';
import { toWorkflowErrorDiagnostic } from '../../workflows/workflowErrorDiagnostics.js';
import {
  ALGORITHM_EXTRACTION_RULE,
  AlgorithmExtractionSchema,
  engineGeometryGuides,
  geometryExtractionSchemas,
  isEngineStudio,
  isGroundedQuadraticScale,
  StudioExampleSchema,
} from './studioBeatPlanning.js';
import {
  hasStatedArrayInput,
  hasStatedGraphOperands,
  hasStatedPerspectiveDimensions,
  hasStatedStudioNumber,
  hasStatedStudioSearchTarget,
  heapOperationFromNarration,
  isAffirmativeStudioCitation,
  isCompleteOperandSpan,
  matchesCitedStudioText,
  matchesQuadraticScaleFormula,
  matchesSectionStudioOperands,
  matchesSectionStudioSearchTarget,
  matchesStatedGraphAlgorithm,
  matchesStatedGraphEndpoint,
  matchesStatedGraphLink,
  matchesStatedScaleValue,
  matchesStatedStudioOperands,
  matchesStatedStudioSearchTarget,
  musicEvidenceConflict,
  musicOperandChecks,
  planeLayerOperands,
  sectionOperandSpan,
  statedScaleValues,
  statedStudioOperandLists,
} from './studioOperandGrounding.js';

const MIN_PHRASE_WORDS = 4;
const MAX_PHRASE_WORDS = 14;
const holdLabel = z.string().min(1).regex(/\S/u);
const beatId = z.strictObject({
  at: z.number().int().positive(),
  event: z.string(),
  hold: holdLabel.optional(),
});
const operandCitation = z.object({
  operandsAt: z.number().int().positive().optional(),
  operandSources: z
    .array(
      z.strictObject({
        field: z.string().min(1),
        quote: z.string().min(1),
      })
    )
    .optional(),
});
const draftBase = { type: z.literal('algorithm'), ...operandCitation.shape };
const arrayDraft = z.strictObject({
  ...draftBase,
  studio: z.literal('array-algorithm'),
  spec: z.strictObject({
    ...ArraySpecSchema.shape,
    callouts: z.array(beatId),
  }),
});
const heapDraft = z.strictObject({
  ...draftBase,
  studio: z.literal('heap'),
  spec: z.strictObject({
    ...HeapSpecSchema.shape,
    operation: HeapSpecSchema.shape.operation.unwrap(),
    beats: z.array(beatId).max(HEAP_MAX_BEATS),
  }),
});

const StudioSelectionDraftSchema = z.discriminatedUnion('studio', [arrayDraft, heapDraft]);
const GeometrySelectionDraftSchema = z.strictObject({
  type: z.literal('geometry'),
  ...operandCitation.shape,
  geometryStudio: GeometrySelectionSchema,
  holds: z.array(z.strictObject({ at: z.number().int().positive(), label: holdLabel })).optional(),
});

type GeometrySelectionId = z.infer<typeof GeometrySelectionSchema>['id'];

const studioFallbackKinds: Readonly<Record<string, LessonSceneType>> = {
  'array-algorithm': 'beforeafter',
  heap: 'beforeafter',
  graph: 'flowchart',
  'function-plot': 'beforeafter',
  plane: 'concepts',
  music: 'concepts',
  'space-3d': 'concepts',
  trajectories: 'timeline',
  'image-annotate': 'concepts',
};

export const studioFallback = (id: string | undefined) =>
  id && Object.hasOwn(studioFallbackKinds, id) ? studioFallbackKinds[id] : undefined;

export const STUDIO_SOURCE_RULE =
  'For evidence from LESSON TEXT, add operandSources entries {field,quote} using one unique verbatim span per field.';

export const STUDIO_OPERAND_RULE = `Require the complete operand list in spec order, in digits or exact Italian number words. Cite the initial list with operandsAt (a numbered phrase ID), or use an existing beat citation. Cite each change at its own beat. ${STUDIO_SOURCE_RULE} Use the complete field path, e.g. spec.input, geometryStudio.spec.edges.weight, geometryStudio.spec.keyframes.0.params, geometryStudio.spec.parameters, geometryStudio.spec.layers.0, or geometryStudio.spec.beats.0.set. Cite whole lists, rows or equations. Missing, inferred, or reordered values require the catalog.`;

export const TRACE_SELECTION_RULE =
  'Prefer a trace studio when the numbered passage explains a mechanism that benefits from visible changes. Definitions use the catalog. Use the whole passage only if the studio can explain it.';

export const STUDIO_BEAT_SYNC_RULE =
  'Plan each narrated step before writing its beat. At the first numbered phrase that names a drawable element or action, introduce it on stage with the engine controls. Keep later elements hidden until they are named. If the phrase explains an existing element without changing the mechanism, use a hold with the exact visible label from the current numbered phrase. A hold highlights that label for the phrase. Use the catalog if the engine cannot illustrate the narrated changes.';

const algorithmGuides = {
  'array-algorithm':
    'Use studio array-algorithm for bubble, insertion (adjacent swaps), selection, or binary-search. Supply 1–10 input numbers. Use the catalog if the cited list states a result. Binary search requires ascending input and an explicitly stated numeric target in a cited phrase. Callout events: compare#N, swap#N, pass-end#N, no-swap-pass, found, not-found, done.',
  heap: 'Use studio heap with operation build for max-heap construction or sort for heapsort. Both operations support start, sift#N and heapified. Only sort supports extract#N and done.',
};

const geometryGuides = {
  graph: `Ground graph weights in edge order. Give every Dijkstra edge an explicit weight.\n${graphModelGuide}`,
  'function-plot': `Ground function parameters in keyframe order (m,b; a,b,c; amplitude,frequency,phase; or base,scale). Axis ranges frame the drawing.\n${functionPlotModelGuide}`,
  plane: `Ground plane layer operands and parameter values. Axis ranges frame the drawing.\n${planeModelGuide}`,
  trajectories: trajectoriesModelGuide,
  'space-3d': space3dModelGuide,
  music: musicModelGuide,
} satisfies Record<GeometrySelectionId, string>;

export function algorithmSelection(allowed: (id: string) => boolean, planBeats: boolean) {
  const options = StudioSelectionDraftSchema.options.filter(option =>
    allowed(option.shape.studio.value)
  );
  if (!options.length) return undefined;
  const ids = options.map(option => option.shape.studio.value);
  const authored = ids.filter(id => !planBeats || !isEngineStudio(id));
  const engine = authored.length < ids.length;
  return {
    ids,
    schema: z.union(
      options.map(option =>
        engine && option.shape.studio.value === 'array-algorithm'
          ? AlgorithmExtractionSchema
          : option
      )
    ),
    hasAuthored: authored.length > 0,
    hasEngine: engine,
    guide: [
      ...(authored.length
        ? [
            'Use type algorithm. N is 1-based. Each beat has a strictly increasing integer at identifying a phrase ID. Name only events the trace computes. Omit narration and visible labels.',
            'For algorithm use hold on the beat.',
            ...authored.map(id => algorithmGuides[id]),
          ]
        : []),
      ...(engine ? [ALGORITHM_EXTRACTION_RULE] : []),
    ].join('\n'),
  };
}

export function geometrySelection(
  allowed: (id: GeometrySelectionId) => boolean,
  planBeats: boolean
) {
  const options = GeometrySelectionSchema.options.filter(option => allowed(option.shape.id.value));
  if (!options.length) return undefined;
  const ids = options.map(option => option.shape.id.value);
  const authored = options.filter(option => {
    const id = option.shape.id.value;
    return !planBeats || !isEngineStudio(id) || id === 'plane';
  });
  const engineIds = new Set<string>(ids.filter(id => planBeats && isEngineStudio(id)));
  const schemas = geometryExtractionSchemas(id => engineIds.has(id));
  if (authored.length)
    schemas.push(GeometrySelectionDraftSchema.extend({ geometryStudio: z.union(authored) }));
  return {
    ids,
    schema: schemas.length === 1 ? schemas[0] : z.union(schemas),
    hasAuthored: authored.length > 0,
    hasEngine: engineIds.size > 0,
    guide: [
      ...(authored.length
        ? [
            'Use type geometry with geometryStudio {id,spec}. Use b1, b2 and so on for numbered phrases in strictly increasing order. Omit anchor. Labels must come from the explanation.',
            'For geometry use the top-level holds array [{at: number, label: string}] referencing only geometry beat phrase IDs.',
            ...authored.map(option => geometryGuides[option.shape.id.value]),
          ]
        : []),
      ...Object.entries(engineGeometryGuides).flatMap(([id, guide]) =>
        engineIds.has(id) ? [guide] : []
      ),
    ].join('\n'),
  };
}

function breakPriority(word: string, gap: string) {
  if (gap.includes('\n') || /[.!?][”"»')\]]*$/u.test(word)) return 2;
  if (/[,;:–—][”"»')\]]*$/u.test(word)) return 1;
  return 0;
}

function preferredPhraseCut(
  narration: string,
  words: readonly RegExpExecArray[],
  start: number,
  maxCut: number,
  canCutAt: (cut: number) => boolean
): number {
  let cut = maxCut;
  let best = 0;
  const latestBreak = Math.min(maxCut, words.length - MIN_PHRASE_WORDS);
  for (let end = start + MIN_PHRASE_WORDS; end <= latestBreak; end++) {
    if (!canCutAt(end)) continue;
    const last = words[end - 1];
    const score = breakPriority(
      last[0],
      narration.slice(last.index + last[0].length, words[end].index)
    );
    if (score > best) {
      cut = end;
      best = score;
    }
  }
  return cut;
}

/** Segment the authored narration for phrase IDs without cutting through operand lists. */
export function segmentStudioPhrases(narration: string): string[] {
  const words = [...narration.matchAll(/\S+/gu)];
  if (words.length < MIN_PHRASE_WORDS) return [];
  const lists = statedStudioOperandLists(narration);
  const canCutAt = (cut: number) => {
    const word = words[cut - 1];
    const offset = word.index + word[0].length;
    return !lists.some(list => list.index < offset && offset < list.end);
  };
  const phrases: string[] = [];
  for (let start = 0; start < words.length; ) {
    let cut = Math.min(start + MAX_PHRASE_WORDS, words.length);
    if (words.length - cut < MIN_PHRASE_WORDS && cut < words.length)
      cut = words.length - MIN_PHRASE_WORDS;
    cut = preferredPhraseCut(narration, words, start, cut, canCutAt);
    while (cut < words.length && !canCutAt(cut)) cut++;
    if (words.length - cut < MIN_PHRASE_WORDS) cut = words.length;
    const last = words[cut - 1];
    phrases.push(narration.slice(words[start].index, last.index + last[0].length));
    start = cut;
  }
  return phrases;
}

function addressPhrases(narration: string, phrases: readonly string[]) {
  let end = 0;
  return phrases.map((anchor): StudioNarrationCue | undefined => {
    const start = narration.indexOf(anchor, end);
    if (start < 0) return undefined;
    end = start + anchor.length;
    let first = narration.indexOf(anchor);
    if (first === start && !narration.includes(anchor, start + 1)) return { anchor };
    let occurrence = 0;
    while (first < start) {
      first = narration.indexOf(anchor, first + 1);
      occurrence++;
    }
    return { anchor, occurrence };
  });
}

export function resolveStudioAnchors(
  ids: number[],
  narration: string,
  phrases: readonly string[],
  holds?: ReadonlyMap<number, string>
) {
  const addresses = addressPhrases(narration, phrases);
  let previous = 0;
  const cues: StudioNarrationCue[] = [];
  for (const id of ids) {
    const cue = addresses[id - 1];
    if (id <= previous || cue === undefined) return undefined;
    const hold = holds?.get(id);
    cues.push(hold === undefined ? cue : { ...cue, hold });
    previous = id;
  }
  return cues;
}

export function decodeStudioDraft(
  value: unknown,
  narration: string,
  phrases: readonly string[]
): AlgorithmLessonScene | undefined {
  const draft = StudioSelectionDraftSchema.safeParse(value);
  if (!draft.success) return undefined;
  const { data } = draft;
  const beats = data.studio === 'heap' ? data.spec.beats : data.spec.callouts;
  const studioCues = resolveStudioAnchors(
    beats.map(({ at }) => at),
    narration,
    phrases,
    new Map(beats.flatMap(({ at, hold }) => (hold === undefined ? [] : [[at, hold]])))
  );
  if (!studioCues) return undefined;
  const events = beats.map(({ event }) => ({ event }));
  const studio = AlgorithmStudioSchema.safeParse({
    id: data.studio,
    spec:
      data.studio === 'heap' ? { ...data.spec, beats: events } : { ...data.spec, callouts: events },
  });
  if (!studio.success) return undefined;
  const scene = {
    type: 'algorithm' as const,
    title: algorithmStudioTitle(studio.data),
    body: '',
    groups: [],
    items: [],
    note: '',
    quote: '',
    autoplay: true,
    narration,
    studio: studio.data,
    studioCues,
  };
  return findLessonSceneProblems(scene, undefined, narration).length ? undefined : scene;
}

export function decodeGeometryStudioDraft(
  value: unknown,
  narration: string,
  phrases: readonly string[]
): GeometryLessonScene | undefined {
  const parsed = GeometrySelectionDraftSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { geometryStudio, holds = [] } = parsed.data;
  const beats =
    geometryStudio.id === 'function-plot'
      ? geometryStudio.spec.keyframes
      : geometryStudio.spec.beats;
  const holdsByPhrase = new Map(holds.map(({ at, label }) => [at, label]));
  const beatIds = beats.map(({ at }) => Number(at?.slice(1)));
  if (holdsByPhrase.size !== holds.length || holds.some(({ at }) => !beatIds.includes(at)))
    return undefined;
  const studioCues = resolveStudioAnchors(beatIds, narration, phrases, holdsByPhrase);
  if (!studioCues) return undefined;
  const scene = {
    type: 'geometry' as const,
    title:
      geometryStudio.id === 'function-plot'
        ? functionPlotTitle(geometryStudio.spec)
        : geometryStudio.spec.title,
    body: '',
    groups: [],
    items: [],
    note: '',
    quote: '',
    autoplay: true,
    narration,
    geometryStudio,
    studioCues,
  };
  return findLessonSceneProblems(scene, undefined, narration).length ? undefined : scene;
}

type OperandEvidence = {
  field: string;
  source: 'section' | 'narration';
  start: number;
  end: number;
};

type OperandCheck = {
  readonly field: string;
  readonly cues: readonly StudioNarrationCue[];
} & (
  | {
      readonly values: readonly number[];
      readonly initial?: boolean;
      readonly target?: boolean;
      readonly formula?: 'coefficients' | 'literals';
      readonly labels?: readonly string[];
      readonly conflictingLabels?: readonly string[];
      readonly link?: { from: string; to: string; directed: boolean; weight?: number };
      readonly endpoint?: { role: 'node' | 'start' | 'target'; label: string };
      readonly scale?: 'formula' | 'assignment';
    }
  | { readonly matchesText: (text: string) => boolean }
);
type CheckOperands = (check: OperandCheck) => boolean;

function matchesNarrationOperand(
  check: OperandCheck,
  narration: string,
  cue: StudioNarrationCue,
  start: number
) {
  if ('matchesText' in check)
    return matchesCitedStudioText(check.matchesText, narration, {
      start,
      end: start + cue.anchor.length,
    });
  return check.target
    ? matchesStatedStudioSearchTarget(check.values[0], cue.anchor)
    : matchesStatedStudioOperands(check.values, cue.anchor, check.initial, {
        text: narration,
        start,
      });
}

function narrationOperandEvidence(
  check: OperandCheck,
  narration: string
): OperandEvidence | undefined {
  const { field, cues } = check;
  if (
    'values' in check &&
    check.target &&
    !matchesStatedStudioSearchTarget(check.values[0], narration)
  )
    return undefined;
  for (const cue of cues) {
    const start = studioCueOffset(narration, cue);
    if (start < 0) continue;
    if (!matchesNarrationOperand(check, narration, cue, start)) continue;
    const end = start + cue.anchor.length;
    if (isCompleteOperandSpan(narration, start, end))
      return { field, source: 'narration', start, end };
  }
  return undefined;
}

function findOperandEvidence(
  check: OperandCheck,
  source: {
    narration: string;
    section: string;
    quotes: readonly { field: string; quote: string }[];
    requireCitations: boolean;
  }
): OperandEvidence | undefined {
  const { field } = check;
  const quotes = source.quotes.filter(citation => citation.field === field);
  if (!quotes.length)
    return source.requireCitations ? undefined : narrationOperandEvidence(check, source.narration);
  if (quotes.length !== 1) return undefined;
  const { quote } = quotes[0];
  if ('matchesText' in check) {
    const lessonSpan = sectionOperandSpan(source.section, quote);
    const provenance = lessonSpan ? 'section' : 'narration';
    const text = source[provenance];
    const span = lessonSpan ?? sectionOperandSpan(text, quote);
    return span && matchesCitedStudioText(check.matchesText, text, span)
      ? { field, source: provenance, ...span }
      : undefined;
  }
  const span = sectionOperandSpan(source.section, quote);
  if (!span) return undefined;
  const grounded = matchesCitedOperand(check, source.section, quote, span);
  return grounded ? { field, source: 'section', ...span } : undefined;
}

function matchesCitedOperand(
  check: Extract<OperandCheck, { readonly values: readonly number[] }>,
  source: string,
  quote: string,
  span: { start: number; end: number }
) {
  const { labels, conflictingLabels, link, endpoint, scale, values, target } = check;
  if ((labels || link || endpoint || scale) && !isAffirmativeStudioCitation(source, span))
    return false;
  if (scale === 'formula') return matchesQuadraticScaleFormula(quote);
  if (scale === 'assignment') return matchesStatedScaleValue(quote, values[0]);
  if (labels)
    return conflictingLabels
      ? matchesStatedGraphAlgorithm(source, span, labels, conflictingLabels)
      : labels.some(label => namesLabel(quote, label));
  if (link) return matchesStatedGraphLink(quote, link);
  if (endpoint) return matchesStatedGraphEndpoint(source, span, endpoint.role, endpoint.label);
  return target
    ? matchesSectionStudioSearchTarget(values[0], source, span)
    : matchesSectionStudioOperands(values, source, quote, span, check);
}

const arrayAlgorithmAliases = {
  bubble: ['bubble sort'],
  insertion: ['insertion sort'],
  selection: ['selection sort'],
  'binary-search': ['binary search'],
};

function arrayAlgorithmLabels(algorithm: keyof typeof arrayAlgorithmAliases) {
  return [arrayCopy.titles[algorithm], ...arrayAlgorithmAliases[algorithm]];
}

function rejectedAlgorithmOperandField(
  scene: AlgorithmLessonScene,
  cues: readonly StudioNarrationCue[],
  matches: CheckOperands,
  requireCitations: boolean
): string | undefined {
  const { studio } = scene;
  if (!matches({ field: 'spec.input', values: studio.spec.input, cues, initial: true }))
    return 'spec.input';
  if (studio.id === 'array-algorithm' && requireCitations) {
    const { algorithm } = studio.spec;
    const labels = arrayAlgorithmLabels(algorithm);
    if (!matches({ field: 'spec.algorithm', values: [], cues, labels })) return 'spec.algorithm';
  }
  if (studio.id === 'array-algorithm' && studio.spec.algorithm === 'binary-search') {
    const { target } = studio.spec;
    if (
      target === undefined ||
      !matches({
        field: 'spec.target',
        values: [target],
        cues: [...cues, ...scene.studioCues],
        target: true,
      })
    )
      return 'spec.target';
  }
  return undefined;
}

function rejectedGeometryOperandField(
  scene: GeometryLessonScene,
  cues: readonly StudioNarrationCue[],
  matches: CheckOperands,
  requireCitations: boolean
): string | undefined {
  const { geometryStudio, studioCues } = scene;
  if (geometryStudio.id === 'graph')
    return rejectedGraphOperandField(geometryStudio.spec, cues, matches, requireCitations);
  if (geometryStudio.id === 'function-plot') {
    for (const [index, frame] of geometryStudio.spec.keyframes.entries()) {
      const field = `geometryStudio.spec.keyframes.${index}.params`;
      if (
        !matches({
          field,
          values: Object.values(frame.params),
          cues: [studioCues[index]],
          formula: 'coefficients',
        })
      )
        return field;
    }
  }
  if (geometryStudio.id === 'plane') {
    return rejectedPlaneOperandField(geometryStudio.spec, cues, studioCues, matches);
  }
  if (geometryStudio.id === 'music') {
    return musicOperandChecks(geometryStudio.spec).find(check => !matches({ ...check, cues }))
      ?.field;
  }
  return undefined;
}

function rejectedGraphOperandField(
  { edges, algorithm, nodes }: GraphSpec,
  cues: readonly StudioNarrationCue[],
  matches: CheckOperands,
  requireCitations: boolean
) {
  const weights = edges.flatMap(edge => (edge.weight === undefined ? [] : [edge.weight]));
  const weightField = 'geometryStudio.spec.edges.weight';
  if (algorithm?.kind === 'dijkstra' && weights.length !== edges.length) return weightField;
  if (!requireCitations)
    return weights.length && !matches({ field: weightField, values: weights, cues })
      ? weightField
      : undefined;
  const labels = new Map(nodes.map(({ id, label }) => [id, label]));
  if (algorithm) {
    const field = rejectedGraphAlgorithmField(algorithm, labels, matches);
    if (field) return field;
  }
  for (const [index, { from, to, directed = false, weight }] of edges.entries()) {
    const field = `geometryStudio.spec.edges.${index}`;
    const fromLabel = labels.get(from);
    const toLabel = labels.get(to);
    if (!fromLabel || !toLabel) return field;
    const link = { from: fromLabel, to: toLabel, directed, weight };
    if (!matches({ field, values: [], cues, link })) return field;
  }
  return rejectedGraphNodeField({ nodes, edges, algorithm }, matches);
}

function rejectedGraphNodeField(
  { nodes, edges, algorithm }: Pick<GraphSpec, 'nodes' | 'edges' | 'algorithm'>,
  matches: CheckOperands
) {
  const linked = new Set([
    ...edges.flatMap(({ from, to }) => [from, to]),
    algorithm?.start,
    algorithm?.target,
  ]);
  for (const [index, { id, label }] of nodes.entries()) {
    if (linked.has(id)) continue;
    const field = `geometryStudio.spec.nodes.${index}`;
    if (!matches({ field, values: [], cues: [], endpoint: { role: 'node', label } })) return field;
  }
  return undefined;
}

const graphAlgorithmLabels = {
  dijkstra: ['Dijkstra'],
  bfs: ['BFS', 'visita in ampiezza', 'ricerca in ampiezza', 'breadth-first search'],
  dfs: ['DFS', 'visita in profondità', 'ricerca in profondità', 'depth-first search'],
  'topo-sort': ['ordinamento topologico', 'topological sort'],
};

function rejectedGraphAlgorithmField(
  algorithm: NonNullable<GraphSpec['algorithm']>,
  labels: ReadonlyMap<string, string>,
  matches: CheckOperands
) {
  const prefix = 'geometryStudio.spec.algorithm';
  const kind = `${prefix}.kind`;
  const conflictingLabels = Object.entries(graphAlgorithmLabels).flatMap(([name, aliases]) =>
    name === algorithm.kind ? [] : aliases
  );
  if (
    !matches({
      field: kind,
      values: [],
      cues: [],
      labels: graphAlgorithmLabels[algorithm.kind],
      conflictingLabels,
    })
  )
    return kind;
  for (const role of ['start', 'target'] as const) {
    const id = algorithm[role];
    if (id === undefined) continue;
    const field = `${prefix}.${role}`;
    const label = labels.get(id);
    if (!label || !matches({ field, values: [], cues: [], endpoint: { role, label } }))
      return field;
  }
  return undefined;
}

function rejectedPlaneOperandField(
  spec: Extract<GeometryLessonScene['geometryStudio'], { id: 'plane' }>['spec'],
  cues: readonly StudioNarrationCue[],
  beatCues: readonly StudioNarrationCue[],
  matches: CheckOperands
): string | undefined {
  const parameters = Object.values(spec.parameters ?? {});
  const initialField = 'geometryStudio.spec.parameters';
  if (parameters.length && !matches({ field: initialField, values: parameters, cues }))
    return initialField;
  for (const [index, layer] of spec.layers.entries()) {
    const field = `geometryStudio.spec.layers.${index}`;
    const values = planeLayerOperands(layer);
    const usesLineCoefficients = layer.type === 'line' && !Array.isArray(layer.form);
    let formula: 'coefficients' | 'literals' | undefined;
    if (usesLineCoefficients) formula = 'coefficients';
    if (layer.type === 'curve') formula = 'literals';
    if (values.length && !matches({ field, values, cues, formula })) return field;
  }
  for (const [index, beat] of spec.beats.entries()) {
    const field = `geometryStudio.spec.beats.${index}.set`;
    const values = Object.values(beat.set ?? {});
    if (values.length && !matches({ field, values, cues: [beatCues[index]] })) return field;
  }
  return undefined;
}

export function checkStudioOperands(
  scene: StudioLessonScene,
  draft: unknown,
  phrases: readonly string[],
  section: string,
  requireCitations = false
): { rejectedField?: string; operandEvidence: OperandEvidence[] } {
  const citation = operandCitation.safeParse(draft).data;
  const firstPhrase = citation?.operandsAt;
  const cues =
    firstPhrase === undefined
      ? scene.studioCues
      : (resolveStudioAnchors([firstPhrase], scene.narration, phrases) ?? []);
  const operandEvidence: OperandEvidence[] = [];
  const matches: CheckOperands = check => {
    const evidence = findOperandEvidence(check, {
      narration: scene.narration,
      section,
      quotes: citation?.operandSources ?? [],
      requireCitations,
    });
    if (!evidence) return false;
    operandEvidence.push(evidence);
    return true;
  };
  const example = requireCitations ? StudioExampleSchema.safeParse(draft).data : undefined;
  if (example) {
    const rejectedField = rejectedExampleField(example, section, matches);
    if (!rejectedField)
      operandEvidence.push({
        field: 'example.input',
        source: 'narration',
        start: 0,
        end: scene.studioCues[0].anchor.length,
      });
    return { rejectedField, operandEvidence };
  }
  if (requireCitations && isGroundedQuadraticScale(draft))
    return { rejectedField: rejectedScaleField(scene, section, matches), operandEvidence };
  const rejectedField =
    scene.type === 'algorithm'
      ? rejectedAlgorithmOperandField(scene, cues, matches, requireCitations)
      : rejectedGeometryOperandField(scene, cues, matches, requireCitations);
  return {
    rejectedField: rejectedField ?? rejectedMusicEvidence(scene, section, operandEvidence),
    operandEvidence,
  };
}

function rejectedMusicEvidence(
  scene: StudioLessonScene,
  section: string,
  evidence: OperandEvidence[]
) {
  if (scene.type !== 'geometry' || scene.geometryStudio.id !== 'music') return undefined;
  const { spec } = scene.geometryStudio;
  return (
    musicEvidenceConflict(
      spec,
      section,
      evidence.filter(entry => entry.source === 'section')
    ) ??
    musicEvidenceConflict(
      spec,
      scene.narration,
      evidence.filter(entry => entry.source === 'narration')
    )
  );
}

function rejectedScaleField(
  scene: StudioLessonScene,
  passage: string,
  matches: CheckOperands
): string | undefined {
  const field = 'geometryStudio.spec.formula';
  if (!matches({ field, cues: [], values: [], scale: 'formula' })) return field;
  if (scene.type !== 'geometry' || scene.geometryStudio.id !== 'function-plot') return field;
  const { spec } = scene.geometryStudio;
  if (spec.family !== 'quadratic') return field;
  const stated = statedScaleValues(passage);
  if (stated.length !== spec.keyframes.length) return 'geometryStudio.spec.values';
  for (const [index, { params }] of spec.keyframes.entries()) {
    const field = `geometryStudio.spec.values.${index}`;
    if (
      params.a !== stated[index] ||
      !matches({ field, cues: [], values: [params.a], scale: 'assignment' })
    )
      return field;
  }
  return undefined;
}

function rejectedExampleFormula(
  sources: readonly { field: string; quote: string }[],
  passage: string,
  matches: CheckOperands
) {
  const field = 'geometryStudio.spec.formula';
  if (!matches({ field, cues: [], values: [], scale: 'formula' })) return field;
  const formula = sources.find(source => source.field === field);
  return formula && hasStatedStudioNumber(passage.replaceAll(formula.quote, ''))
    ? 'geometryStudio.spec.values'
    : undefined;
}

function rejectedExampleField(
  example: z.infer<typeof StudioExampleSchema>,
  passage: string,
  matches: CheckOperands
) {
  if (example.type === 'algorithm') {
    if (
      hasStatedArrayInput(passage) ||
      (example.spec.algorithm === 'binary-search' && hasStatedStudioSearchTarget(passage))
    )
      return 'spec.input';
    const field = 'spec.algorithm';
    return matches({
      field,
      values: [],
      cues: [],
      labels: arrayAlgorithmLabels(example.spec.algorithm),
    })
      ? undefined
      : field;
  }
  switch (example.geometryStudio.id) {
    case 'graph': {
      if (hasStatedGraphOperands(passage)) return 'geometryStudio.spec.edges';
      const field = 'geometryStudio.spec.algorithm';
      return matches({ field, values: [], cues: [], labels: ['Dijkstra'] }) ? undefined : field;
    }
    case 'plane': {
      const field = 'geometryStudio.spec.construction';
      return !hasStatedPerspectiveDimensions(passage) &&
        matches({ field, values: [], cues: [], labels: ['punto di fuga'] })
        ? undefined
        : field;
    }
    case 'function-plot':
      return rejectedExampleFormula(example.operandSources, passage, matches);
  }
}

export async function checkStudioCandidate(
  scene: StudioLessonScene,
  draft: unknown,
  phrases: readonly string[],
  {
    section,
    decisionId,
    requireCitations = false,
  }: { section: string; decisionId: string; requireCitations?: boolean }
): Promise<{
  failedChecks: StudioCheck[];
  rejectedField?: string;
  operandEvidence: OperandEvidence[];
}> {
  const grounding = checkStudioOperands(scene, draft, phrases, section, requireCitations);
  const failedChecks: StudioCheck[] = grounding.rejectedField
    ? ['operand-grounding']
    : await checkStudioLayout(scene, decisionId);
  return { ...grounding, failedChecks };
}
async function checkStudioLayout(
  scene: StudioLessonScene,
  decisionId: string
): Promise<StudioCheck[]> {
  if (
    scene.type === 'algorithm' &&
    scene.studio.id === 'heap' &&
    scene.studio.spec.operation !== heapOperationFromNarration(scene.narration)
  ) {
    return ['operation-grounding'];
  }
  const studio = scene.type === 'algorithm' ? scene.studio.id : scene.geometryStudio.id;
  let reader: string | undefined;
  try {
    const staff = needsMusicStaff(scene) ? await loadMusicStaff() : undefined;
    const space3d =
      studio === 'space-3d'
        ? (await import('@shared/lessonStudios/space3d')).buildSpace3d
        : undefined;
    for (const [name, viewport] of Object.entries(readerStudioViewports)) {
      reader = name;
      const checks = checkAlgorithmGeometry(scene, viewport, {
        requireBeatSync: !space3d,
        staff,
        space3d,
      });
      if (checks.length === 0) continue;
      console.info('[lesson-studio] reader layout rejected', {
        decisionId,
        studio,
        reader,
        ...viewport,
        checks,
      });
      return checks;
    }
    return [];
  } catch (error) {
    console.warn('[lesson-studio] layout unavailable', {
      decisionId,
      studio,
      reader,
      cause: toWorkflowErrorDiagnostic(error, { includeContent: false }),
    });
    return ['layout-unavailable'];
  }
}
