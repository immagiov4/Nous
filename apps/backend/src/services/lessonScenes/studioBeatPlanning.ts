import { findLessonSceneProblems, type StudioLessonScene } from '@shared/lessonScene';
import { algorithmStudioTitle } from '@shared/lessonStudios/algorithm';
import { ArraySpecSchema } from '@shared/lessonStudios/arrayAlgorithm';
import { planArrayBeats } from '@shared/lessonStudios/arrayBeatPlan';
import { formatOperand } from '@shared/lessonStudios/chart';
import { plotBeatCopy } from '@shared/lessonStudios/function-plot.copy.it';
import { functionPlotTitle } from '@shared/lessonStudios/functionPlot';
import {
  type FunctionPlotSpec,
  FunctionPlotSpecSchema,
} from '@shared/lessonStudios/functionPlotSpec';
import { graphBeatCopy } from '@shared/lessonStudios/graph.copy.it';
import {
  checkGraphSpec,
  computeGraphTrace,
  type GraphSpec,
  GraphSpecSchema,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  PreBankGraphSpecSchema,
  PrePrimGraphSpecSchema,
} from '@shared/lessonStudios/graphSpec';
import { planeMechanismCopy } from '@shared/lessonStudios/planeMechanism.copy.it';
import * as z from 'zod';
import { arrayExample, graphExample, perspectiveExample } from './studioExampleInputs.js';
import {
  PlaneMechanismExampleSchema,
  PlaneMechanismSchema,
  planeExamples,
  planeMechanismRule,
  planPlaneMechanism,
} from './studioPlaneBeatPlan.js';

const operandSources = z.array(z.strictObject({ field: z.string(), quote: z.string().min(1) }));
const source = { operandSources };

const groundedArray = z.strictObject({
  type: z.literal('algorithm'),
  studio: z.literal('array-algorithm'),
  spec: z.strictObject(ArraySpecSchema.omit({ callouts: true }).shape),
  ...source,
});

const exampleMode = { inputMode: z.literal('example'), ...source };
const exampleArray = z.strictObject({
  type: z.literal('algorithm'),
  studio: z.literal('array-algorithm'),
  spec: z.strictObject({ algorithm: ArraySpecSchema.shape.algorithm }),
  ...exampleMode,
});
export const AlgorithmExtractionSchema = z.union([groundedArray, exampleArray]);

const graph = GraphSpecSchema.shape;
const graphInput = z.strictObject({
  nodes: z
    .array(graph.nodes.element.pick({ id: true, label: true }).strict())
    .min(1)
    .max(MAX_GRAPH_NODES),
  edges: z
    .array(
      graph.edges.element.pick({ from: true, to: true, directed: true, weight: true }).strict()
    )
    .max(MAX_GRAPH_EDGES),
  algorithm: graph.algorithm.unwrap().omit({ stopAtTarget: true }).strict().optional(),
});
const [linear, quadratic, sine, exponential] = FunctionPlotSpecSchema.options;
const extractPlot = <F extends z.ZodType, P extends z.ZodType>(family: F, params: P) =>
  z.strictObject({
    ...linear.pick({ xRange: true, yRange: true }).shape,
    family,
    keyframes: z.array(z.strictObject({ params })).min(1),
  });

const plot = z.discriminatedUnion('family', [
  extractPlot(linear.shape.family, linear.shape.keyframes.element.shape.params),
  extractPlot(quadratic.shape.family, quadratic.shape.keyframes.element.shape.params),
  extractPlot(sine.shape.family, sine.shape.keyframes.element.shape.params),
  extractPlot(exponential.shape.family, exponential.shape.keyframes.element.shape.params),
]);

const quadraticScale = z.strictObject({ form: z.literal('quadratic-scale') });
const groundedScale = quadraticScale.extend({ values: z.array(z.number()).min(2) });
const groundedGeometry = z.strictObject({
  type: z.literal('geometry'),
  geometryStudio: z.discriminatedUnion('id', [
    z.strictObject({ id: z.literal('graph'), spec: graphInput }),
    z.strictObject({ id: z.literal('function-plot'), spec: z.union([plot, groundedScale]) }),
    z.strictObject({ id: z.literal('plane'), spec: PlaneMechanismSchema }),
  ]),
  ...source,
});

const exampleGeometry = z.strictObject({
  type: z.literal('geometry'),
  geometryStudio: z.discriminatedUnion('id', [
    z.strictObject({
      id: z.literal('graph'),
      spec: z.strictObject({ algorithm: z.enum(['dijkstra', 'prim', 'kruskal', 'topo-sort']) }),
    }),
    z.strictObject({
      id: z.literal('plane'),
      spec: z.union([
        z.strictObject({ construction: z.literal('perspective') }),
        PlaneMechanismExampleSchema,
      ]),
    }),
    z.strictObject({ id: z.literal('function-plot'), spec: quadraticScale }),
  ]),
  ...exampleMode,
});
export function geometryExtractionSchemas(
  allowed: (id: string) => boolean,
  expanded = true,
  bankGraphForms = false
): z.ZodType[] {
  const schemas: z.ZodType[] = [];
  const [graph, plot] = groundedGeometry.shape.geometryStudio.options;
  const [graphExample, planeExample, plotExample] = exampleGeometry.shape.geometryStudio.options;
  const historicalGraph = graph.extend({
    spec: graphInput.extend({
      algorithm: PreBankGraphSpecSchema.shape.algorithm
        .unwrap()
        .omit({ stopAtTarget: true })
        .strict()
        .optional(),
    }),
  });
  const groundedOptions = expanded
    ? [
        bankGraphForms ? graph : historicalGraph,
        ...groundedGeometry.shape.geometryStudio.options.slice(1),
      ]
    : [
        graph.extend({
          spec: graphInput.extend({ algorithm: PrePrimGraphSpecSchema.shape.algorithm }),
        }),
        plot,
      ];
  const exampleOptions = expanded
    ? [
        bankGraphForms
          ? graphExample
          : graphExample.extend({
              spec: z.strictObject({ algorithm: z.enum(['dijkstra', 'prim']) }),
            }),
        planeExample,
        plotExample,
      ]
    : [
        graphExample.extend({ spec: z.strictObject({ algorithm: z.literal('dijkstra') }) }),
        planeExample.extend({ spec: z.strictObject({ construction: z.literal('perspective') }) }),
        plotExample,
      ];
  const grounded = groundedOptions.filter(option => allowed(option.shape.id.value));
  const illustrative = exampleOptions.filter(option => allowed(option.shape.id.value));
  if (grounded.length) schemas.push(groundedGeometry.extend({ geometryStudio: z.union(grounded) }));
  if (illustrative.length)
    schemas.push(exampleGeometry.extend({ geometryStudio: z.union(illustrative) }));
  return schemas;
}
export const StudioExampleSchema = z.discriminatedUnion('type', [exampleArray, exampleGeometry]);

export function isBankGraphDraft(value: unknown) {
  const example = exampleGeometry.safeParse(value).data?.geometryStudio;
  if (example?.id === 'graph')
    return example.spec.algorithm === 'kruskal' || example.spec.algorithm === 'topo-sort';
  const draft = groundedGeometry.safeParse(value).data?.geometryStudio;
  return draft?.id === 'graph' && draft.spec.algorithm?.kind === 'kruskal';
}

export function isGroundedQuadraticScale(value: unknown) {
  const draft = groundedGeometry.safeParse(value).data?.geometryStudio;
  return draft?.id === 'function-plot' && 'form' in draft.spec;
}

export function extractedPlaneMechanism(value: unknown) {
  const draft = groundedGeometry.safeParse(value).data?.geometryStudio;
  return draft?.id === 'plane' ? draft.spec : undefined;
}

export const STUDIO_EXTRACTION_RULE =
  'For engine-planned studio forms, select and extract the mechanism. No concrete starting data is required for a supported example form: choose inputMode "example" and name the mechanism; the engine supplies and explicitly introduces a curated example. When the lesson gives the inputs, use those inputs and omit inputMode. Cite exact spans in operandSources, an array of objects with field and quote keys: [{"field":"spec.input","quote":"[4, 3]"}]. For engine-planned forms, omit example data, beats, callouts, narration, anchors and timings. Authored studio forms follow their own numbered narration format. Choose the catalog only if no offered studio fits.';
export const ALGORITHM_EXTRACTION_RULE =
  'For sorting or binary search, use type "algorithm", studio "array-algorithm", and spec.algorithm equal to "bubble", "insertion", "selection", or "binary-search". Cite the procedure name in spec.algorithm. If the passage gives neither a starting array nor a search target, use inputMode "example" and only {algorithm} in spec. Otherwise extract spec.input in its stated order (1–10 numbers) and, for binary search, the stated spec.target. Cite each field.';
const legacyGraphExtractionGuide =
  'For type "geometry" return geometryStudio {id,spec}. When Dijkstra is explained without a concrete graph, use inputMode "example", id "graph", spec {"algorithm":"dijkstra"} and cite "Dijkstra" as geometryStudio.spec.algorithm. With stated graph data, extract nodes [{id,label}], edges [{from,to,directed?,weight?}] and algorithm {kind,start?,target?} only when explicitly named. Kinds: dijkstra, bfs, dfs, topo-sort. Copy each label. For any node outside the cited edges and algorithm endpoints, cite its node designation as geometryStudio.spec.nodes.N (zero-based), for example "nodo isolato A". Cite each edge as geometryStudio.spec.edges.N (zero-based) with its explicit connector (A → B, A -> B, or A ↔ B) and weight if present. For a concrete algorithm, cite its name as geometryStudio.spec.algorithm.kind. Cite each populated start or target separately as geometryStudio.spec.algorithm.start or geometryStudio.spec.algorithm.target; the quote must establish the node’s role, such as "partiamo dal nodo A" or "la destinazione è B".';
const perspectiveExtractionGuide =
  'When the lesson explains construction of a perspective floor through a vanishing point without concrete dimensions, use inputMode "example", id "plane", spec {"construction":"perspective"}. Cite a unique span containing "punto di fuga" in geometryStudio.spec.construction.';

export const engineGeometryGuides = {
  graph: [
    legacyGraphExtractionGuide,
    'The graph studio also supports Prim. For a lesson explaining the cut rule or growth of a minimum spanning tree, select Prim even if Kruskal is mentioned in the same passage. In example mode use spec.algorithm "prim"; cite "Prim" as geometryStudio.spec.algorithm. With full data set algorithm.kind to "prim" and use a connected weighted undirected graph. Prim has a starting node and accepts no target.',
  ].join('\n'),
  plane: [perspectiveExtractionGuide, planeMechanismRule].join('\n'),
  'function-plot': [
    'For y = a·x² with stated values of a, use id "function-plot" and spec {"form":"quadratic-scale","values":[...]} without axis ranges or b and c. Cite the base formula as geometryStudio.spec.formula. Cite each exact assignment (e.g. "a = 0,3") in geometryStudio.spec.values.N. If the formula is stated and gives no values for a, use inputMode "example" with only {"form":"quadratic-scale"} and still cite the formula.',
    'For a function-plot, extract the specified function family (linear, quadratic, sine, exponential) and the successive stated parameters in keyframes [{params}]. Use the canonical parameter names m,b; a,b,c; amplitude,frequency,phase; or base,scale. Cite each complete source equation or ordered parameter list as geometryStudio.spec.keyframes.N.params (zero-based). xRange and yRange are finite ascending axis bounds for framing only.',
  ].join('\n'),
};

const bankGraphGuide = [
  'Use Kruskal when the passage explains trying edges in cost order and skipping cycles. Use algorithm.kind "kruskal" on an undirected connected graph, with no start or target. If every cost is given, cite each edge and its cost as usual. List equal-cost edges in the stated tie-break order, even when that differs from their order of mention. If only the complete cost order is explicitly listed, omit all weights, preserve the full edge order and cite the full ordered list together with its cost-order cue as geometryStudio.spec.edges.',
  'Use a topological trace when the passage explains giving tasks an order that satisfies precedences. Extract a stated DAG as usual. A cycle used as a counterexample is not the DAG for the trace.',
  'When the passage explains either mechanism without a stated input, use inputMode "example", graph spec {"algorithm":"kruskal"} or {"algorithm":"topo-sort"}, and cite the explained algorithm as geometryStudio.spec.algorithm.',
].join('\n');

export function engineGeometryGuide(
  id: keyof typeof engineGeometryGuides,
  expanded: boolean,
  bankGraphForms = false
) {
  if (id === 'graph' && bankGraphForms) return `${engineGeometryGuides.graph}\n${bankGraphGuide}`;
  if (expanded) return engineGeometryGuides[id];
  if (id === 'graph') return legacyGraphExtractionGuide;
  return id === 'plane' ? perspectiveExtractionGuide : engineGeometryGuides[id];
}

export function isEngineStudio(id: string | undefined) {
  return id !== undefined && (id === 'array-algorithm' || Object.hasOwn(engineGeometryGuides, id));
}

export function isEngineStudioDraft(id: string | undefined, draft: unknown) {
  if (id === 'plane')
    return !!extractedPlaneMechanism(draft) || StudioExampleSchema.safeParse(draft).success;
  return isEngineStudio(id);
}

type NamedBeat = { sentence: string; targets: string[] };

function graphName(spec: GraphSpec, id: string) {
  const node = spec.nodes.find(node => node.id === id);
  if (!node) throw new Error('Graph beat names an unknown node');
  return node.label;
}

function graphTreeBeat(event: string, edge: GraphSpec['edges'][number], names: [string, string]) {
  if (event.startsWith('skip:')) return graphBeatCopy.kruskalSkip(...names);
  if (edge.weight === undefined) return graphBeatCopy.kruskalAdd(...names);
  return graphBeatCopy.add(...names, formatOperand(edge.weight));
}

function planGraphBeats(spec: GraphSpec) {
  checkGraphSpec(spec);
  const label = (id: string) => graphName(spec, id);
  const { algorithm } = spec;
  if (!algorithm) {
    return spec.edges.map(({ from, to, directed }, index) => ({
      beat: { event: 'highlight-path', nodes: [from, to] },
      targets: [`edge:${index}`],
      sentence: directed
        ? graphBeatCopy.next(label(from), label(to))
        : graphBeatCopy.link(label(from), label(to)),
    }));
  }
  const defaultStart = spec.topologicalReadout ? graphBeatCopy.topologyStart : graphBeatCopy.start;
  const startCopy =
    algorithm.kind === 'prim' && !algorithm.start ? graphBeatCopy.chooseStart : defaultStart;
  const opening = algorithm.kind === 'kruskal' ? () => graphBeatCopy.kruskalStart : startCopy;
  const visit = spec.topologicalReadout
    ? (node: string, ready: string[]) =>
        graphBeatCopy.topologyVisit(node, ready.map(label).join(', '))
    : graphBeatCopy.visit;
  const trace = computeGraphTrace(spec);
  const initialVisit = algorithm.stopAtTarget ? `visit:${trace[0].focus[0]}` : undefined;
  return trace.flatMap(({ event, focus, frontier, distances, path, edge, unreachable }) => {
    // The opening cue already focuses the starting node; only the trace needs its first visit.
    if (event === initialVisit) return [];
    const [origin, destination] = focus;
    const labels = focus.map(label).join(', ');
    const beat = { event };
    if (event === 'start') return [{ beat, targets: focus, sentence: opening(labels) }];
    if (edge && /^(?:add|skip):/u.test(event)) {
      return [
        {
          beat,
          targets: [`edge:${edge.index}`],
          sentence: graphTreeBeat(event, spec.edges[edge.index], [
            label(origin),
            label(destination),
          ]),
        },
      ];
    }
    if (event.startsWith('visit:'))
      return [
        {
          beat,
          targets: focus,
          sentence: distances
            ? graphBeatCopy.fixed(label(origin), formatOperand(distances[origin]))
            : visit(label(origin), frontier),
        },
      ];
    if (event.startsWith('relax:') && distances)
      return [
        {
          beat,
          targets: edge ? [destination, `edge:${edge.index}`] : [destination],
          sentence: graphBeatCopy.relax(
            label(origin),
            label(destination),
            formatOperand(distances[destination])
          ),
        },
      ];
    if (event === 'done' && (unreachable || (distances && !Number.isFinite(distances[origin]))))
      return [{ beat, targets: focus, sentence: graphBeatCopy.unreachable(label(origin)) }];
    return path?.length
      ? [
          {
            beat,
            targets: path.map(index => `edge:${index}`),
            sentence: graphBeatCopy.path(labels),
          },
        ]
      : [];
  });
}

function planPlotBeats(spec: FunctionPlotSpec) {
  return spec.keyframes.flatMap(({ params }, index) => {
    const previous = spec.keyframes[index - 1]?.params;
    const changed = Object.entries(params).filter(
      ([key, value]) =>
        !previous ||
        Object.entries(previous).some(([priorKey, prior]) => priorKey === key && prior !== value)
    );
    if (!changed.length) return [];
    const values = changed
      .map(([key, value]) => plotBeatCopy.parameter(key, formatOperand(value)))
      .join(', ');
    return [
      {
        sentence: index
          ? plotBeatCopy.change(values)
          : plotBeatCopy.initial(functionPlotTitle(spec), values),
        targets: ['curve'],
      },
    ];
  });
}

function sceneCopy(beats: NamedBeat[], introduction?: string) {
  const counts = new Map<string, number>();
  const studioCues = beats.map(({ sentence, targets }, index) => {
    const anchor = index === 0 && introduction ? `${introduction} ${sentence}` : sentence;
    const occurrence = counts.get(anchor) ?? 0;
    counts.set(anchor, occurrence + 1);
    return { anchor, occurrence, targets };
  });
  return {
    body: '',
    groups: [],
    items: [],
    note: '',
    quote: '',
    autoplay: true as const,
    narration: studioCues.map(cue => cue.anchor).join(' '),
    studioCues,
  };
}

function geometryScene(
  { geometryStudio }: z.infer<typeof groundedGeometry>,
  introduction?: string,
  expanded = true
): StudioLessonScene | undefined {
  if (geometryStudio.id === 'graph') {
    const { algorithm } = geometryStudio.spec;
    const title = graphBeatCopy.titles[algorithm?.kind ?? 'graph'];
    const bounded =
      expanded && (algorithm?.kind === 'bfs' || algorithm?.kind === 'dfs') && algorithm.target;
    const spec: GraphSpec = {
      ...geometryStudio.spec,
      algorithm: bounded ? { ...algorithm, stopAtTarget: true } : algorithm,
      title,
      beats: [],
    };
    const beats = planGraphBeats(spec);
    const graph = GraphSpecSchema.safeParse({
      ...spec,
      beats: beats.map(({ beat }) => beat),
    });
    if (!graph.success) return undefined;
    return {
      ...sceneCopy(beats, introduction),
      type: 'geometry',
      title: graph.data.title,
      geometryStudio: { id: geometryStudio.id, spec: graph.data },
    };
  }
  if (geometryStudio.id === 'plane') {
    const { spec, beats } = planPlaneMechanism(geometryStudio.spec);
    return {
      ...sceneCopy(beats, introduction),
      type: 'geometry',
      title: spec.title,
      geometryStudio: { id: 'plane', spec },
    };
  }
  const spec =
    'form' in geometryStudio.spec ? scalePlot(geometryStudio.spec.values) : geometryStudio.spec;
  const beats = planPlotBeats(spec);
  if (beats.length !== spec.keyframes.length || beats.length < 2) return undefined;
  return {
    ...sceneCopy(beats, introduction),
    type: 'geometry',
    title: functionPlotTitle(spec),
    geometryStudio: { id: 'function-plot', spec },
  };
}

function scalePlot(values: number[]): FunctionPlotSpec {
  const xRange: [number, number] = [-2, 2];
  const ordinates = values.map(a => a * xRange[1] ** 2);
  return {
    family: 'quadratic',
    xRange,
    yRange: [Math.min(0, ...ordinates), Math.max(0, ...ordinates)],
    keyframes: values.map(a => ({ params: { a, b: 0, c: 0 } })),
  };
}

function arrayScene(
  spec: Parameters<typeof planArrayBeats>[0],
  introduction?: string
): StudioLessonScene {
  const beats = planArrayBeats(spec);
  const studio = {
    id: 'array-algorithm' as const,
    spec: { ...spec, callouts: beats.map(({ event }) => ({ event })) },
  };
  return {
    ...sceneCopy(beats, introduction),
    type: 'algorithm',
    title: algorithmStudioTitle(studio),
    studio,
  };
}

function exampleScene(example: z.infer<typeof StudioExampleSchema>) {
  if (example.type === 'algorithm') {
    const { spec, introduction } = arrayExample(example.spec.algorithm);
    return arrayScene(spec, introduction);
  }
  switch (example.geometryStudio.id) {
    case 'graph': {
      const { spec, introduction } = graphExample(example.geometryStudio.spec.algorithm);
      return geometryScene(
        { type: 'geometry', geometryStudio: { id: 'graph', spec }, operandSources: [] },
        introduction
      );
    }
    case 'plane': {
      if ('form' in example.geometryStudio.spec) {
        return geometryScene(
          {
            type: 'geometry',
            geometryStudio: { id: 'plane', spec: planeExamples[example.geometryStudio.spec.form] },
            operandSources: [],
          },
          planeMechanismCopy.example
        );
      }
      const { spec, beats } = perspectiveExample();
      return {
        ...sceneCopy(beats),
        type: 'geometry' as const,
        title: spec.title,
        geometryStudio: { id: 'plane' as const, spec },
      };
    }
    case 'function-plot':
      return geometryScene(
        {
          type: 'geometry',
          geometryStudio: {
            id: 'function-plot',
            spec: { form: 'quadratic-scale', values: [1, 3] },
          },
          operandSources: [],
        },
        plotBeatCopy.example
      );
  }
}

function unvalidatedStudioScene(value: unknown, expanded: boolean): StudioLessonScene | undefined {
  const example = StudioExampleSchema.safeParse(value);
  if (example.success) return exampleScene(example.data);
  const algorithm = groundedArray.safeParse(value);
  if (algorithm.success) return arrayScene({ ...algorithm.data.spec, callouts: [] });
  const geometry = groundedGeometry.safeParse(value);
  return geometry.success ? geometryScene(geometry.data, undefined, expanded) : undefined;
}

export function planStudioScene(value: unknown, expanded = true): StudioLessonScene | undefined {
  try {
    const scene = unvalidatedStudioScene(value, expanded);
    return scene?.narration && !findLessonSceneProblems(scene).length ? scene : undefined;
  } catch {
    // Invalid extracted operands or an unrenderable trace leave selection to the catalog.
    return undefined;
  }
}
