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
} from '@shared/lessonStudios/graphSpec';
import * as z from 'zod';

const operandSources = z.array(z.strictObject({ field: z.string(), quote: z.string().min(1) }));
const source = { operandSources };

export const AlgorithmExtractionSchema = z.strictObject({
  type: z.literal('algorithm'),
  studio: z.literal('array-algorithm'),
  spec: z.strictObject(ArraySpecSchema.omit({ callouts: true }).shape),
  ...source,
});

const graphInput = z.strictObject(GraphSpecSchema.omit({ beats: true }).shape);
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

export const GeometryExtractionSchema = z.strictObject({
  type: z.literal('geometry'),
  geometryStudio: z.discriminatedUnion('id', [
    z.strictObject({ id: z.literal('graph'), spec: graphInput }),
    z.strictObject({ id: z.literal('function-plot'), spec: plot }),
  ]),
  ...source,
});

export const STUDIO_EXTRACTION_RULE =
  'For the target passage, choose an animated studio if its stated data can illustrate a changing mechanism. A concrete worked example, causal chain, or ordered process qualifies. Copy all starting data from the passage and cite exact spans in operandSources, an array of objects with field and quote keys: [{"field":"spec.input","quote":"[4, 3]"}]. Never propose beats, callouts, narration, anchors or timings. Use the catalog for a static definition or if the data needed by the studio is absent.';
export const ALGORITHM_EXTRACTION_RULE =
  'Use type algorithm and studio array-algorithm for bubble, insertion, selection and binary-search. Extract spec {algorithm,input,target?}. Cite its exact name in spec.algorithm and copy the initial array in order (1–10 numbers) in spec.input. Binary search needs an ascending array and an explicitly stated target cited as spec.target.';
export const GEOMETRY_EXTRACTION_RULE = [
  'For type geometry return geometryStudio {id,spec}. Graph spec has title, nodes [{id,label}], edges [{from,to,directed?,weight?}] and algorithm {kind,start?,target?} only when explicitly named. Kinds: dijkstra, bfs, dfs, topo-sort. Copy each label. Cite each edge as geometryStudio.spec.edges.N (zero-based). The quote must contain both labels and their explicit connector: A → B or A -> B for directed links, A ↔ B for undirected links. Include any edge weight in its quote.',
  'For a function-plot, extract the specified function family (linear, quadratic, sine, exponential) and the successive stated parameters in keyframes [{params}]. Use the canonical parameter names m,b; a,b,c; amplitude,frequency,phase; or base,scale. Cite each complete source equation or ordered parameter list as geometryStudio.spec.keyframes.N.params (zero-based). xRange and yRange are finite ascending axis bounds for framing only.',
].join('\n');

type NamedBeat = { sentence: string; targets: string[] };

function graphName(spec: GraphSpec, id: string) {
  const node = spec.nodes.find(node => node.id === id);
  if (!node) throw new Error('Graph beat names an unknown node');
  return node.label;
}

function planGraphBeats(spec: GraphSpec) {
  checkGraphSpec(spec);
  const label = (id: string) => graphName(spec, id);
  if (!spec.algorithm) {
    return spec.edges.map(({ from, to, directed }, index) => ({
      beat: { event: 'highlight-path', nodes: [from, to] },
      targets: [`edge:${index}`],
      sentence: directed
        ? graphBeatCopy.next(label(from), label(to))
        : graphBeatCopy.link(label(from), label(to)),
    }));
  }
  return computeGraphTrace(spec).flatMap(({ event, focus, distances, path, edge }) => {
    const [origin, destination] = focus;
    const labels = focus.map(label).join(', ');
    const beat = { event };
    if (event === 'start') return [{ beat, targets: focus, sentence: graphBeatCopy.start(labels) }];
    if (event.startsWith('visit:'))
      return [
        {
          beat,
          targets: focus,
          sentence: distances
            ? graphBeatCopy.fixed(label(origin), formatOperand(distances[origin]))
            : graphBeatCopy.visit(label(origin)),
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

function sceneCopy(beats: NamedBeat[]) {
  const counts = new Map<string, number>();
  const studioCues = beats.map(({ sentence, targets }) => {
    const occurrence = counts.get(sentence) ?? 0;
    counts.set(sentence, occurrence + 1);
    return { anchor: sentence, occurrence, targets };
  });
  return {
    body: '',
    groups: [],
    items: [],
    note: '',
    quote: '',
    autoplay: true as const,
    narration: beats.map(beat => beat.sentence).join(' '),
    studioCues,
  };
}

function geometryScene(
  draft: z.infer<typeof GeometryExtractionSchema>
): StudioLessonScene | undefined {
  const { geometryStudio } = draft;
  if (geometryStudio.id === 'graph') {
    const beats = planGraphBeats({ ...geometryStudio.spec, beats: [] });
    const graph = GraphSpecSchema.safeParse({
      ...geometryStudio.spec,
      beats: beats.map(({ beat }) => beat),
    });
    if (!graph.success) return undefined;
    return {
      ...sceneCopy(beats),
      type: 'geometry',
      title: graph.data.title,
      geometryStudio: { id: geometryStudio.id, spec: graph.data },
    };
  }
  const beats = planPlotBeats(geometryStudio.spec);
  if (beats.length !== geometryStudio.spec.keyframes.length || beats.length < 2) return undefined;
  return {
    ...sceneCopy(beats),
    type: 'geometry',
    title: functionPlotTitle(geometryStudio.spec),
    geometryStudio,
  };
}

export function planStudioScene(value: unknown): StudioLessonScene | undefined {
  try {
    const algorithm = AlgorithmExtractionSchema.safeParse(value);
    if (algorithm.success) {
      const spec = { ...algorithm.data.spec, callouts: [] };
      const beats = planArrayBeats(spec);
      const studio = {
        id: 'array-algorithm' as const,
        spec: { ...spec, callouts: beats.map(({ event }) => ({ event })) },
      };
      const scene = {
        ...sceneCopy(beats),
        type: 'algorithm' as const,
        title: algorithmStudioTitle(studio),
        studio,
      };
      return !findLessonSceneProblems(scene).length ? scene : undefined;
    }
    const geometry = GeometryExtractionSchema.safeParse(value);
    const scene = geometry.success ? geometryScene(geometry.data) : undefined;
    return scene?.narration && !findLessonSceneProblems(scene).length ? scene : undefined;
  } catch {
    // Invalid extracted operands or an unrenderable trace leave selection to the catalog.
    return undefined;
  }
}
