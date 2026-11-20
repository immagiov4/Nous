import * as z from 'zod';
import { geometryBeatFields as beatFields, studioEntityId as entityId } from './geometryStudioSpec';
import { compile } from './planeMath';

const num = z.union([
  z.number(),
  z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/u)
    .meta({ modelId: '_' }),
]);
const position = z.tuple([num, num]);
const pointRef = z.union([position, entityId]);
const range = z.tuple([z.number(), z.number()]).refine(([a, b]) => a < b && Number.isFinite(b - a));
const named = { id: entityId, name: z.string().min(1).optional() };
const pair = z.tuple([pointRef, pointRef]);
const matrix = z.tuple([position, position]);
const layer = z.discriminatedUnion('type', [
  z.strictObject({ ...named, type: z.literal('curve'), expr: z.string().min(1) }),
  z.strictObject({
    ...named,
    type: z.literal('line'),
    form: z.union([pair, z.strictObject({ m: num, b: num })]),
  }),
  z.strictObject({ ...named, type: z.literal('point'), at: position }),
  z.strictObject({
    ...named,
    type: z.literal('circle'),
    center: position,
    radius: z.number().positive(),
  }),
  z.strictObject({
    ...named,
    type: z.literal('unit-circle-wave'),
    angle: num,
    waveStart: z.number().gt(1),
    sineName: z.string().min(1).optional(),
    cosineName: z.string().min(1).optional(),
  }),
  z.strictObject({ ...named, type: z.enum(['segment', 'vector']), through: pair }),
  z.strictObject({
    ...named,
    type: z.literal('region'),
    between: z.tuple([entityId, entityId]),
    where: z.enum(['above', 'below']),
  }),
  z.strictObject({ ...named, type: z.literal('grid-transform'), matrix }),
  z.strictObject({
    ...named,
    type: z.literal('construction'),
    through: pair,
    horizon: num.optional(),
  }),
  z.strictObject({
    ...named,
    type: z.literal('floor'),
    part: z.enum(['rays', 'tiles']).optional(),
    vanishing: pointRef,
    near: z.tuple([pointRef, pointRef]),
    tiles: z.number().int().min(1).max(20),
    rows: z.number().int().min(1).max(20),
  }),
  z.strictObject({ ...named, type: z.literal('intersection'), of: z.tuple([entityId, entityId]) }),
  z.strictObject({ ...named, type: z.literal('roots'), of: entityId }),
  z.strictObject({ ...named, type: z.literal('tangent'), of: entityId, x: num, h: num }),
  z.strictObject({
    ...named,
    type: z.literal('snell'),
    n1: num,
    n2: num,
    angle: num,
    media: z
      .array(z.strictObject({ index: z.number().positive(), name: z.string().min(1) }))
      .min(1)
      .optional(),
  }),
]);

const parameters = z.record(
  z
    .string()
    .regex(/^(?!x$)[a-z][a-z0-9_]*$/u)
    .meta({ modelId: '_' }),
  z.number()
);
export const PlaneSpecSchema = z.strictObject({
  title: z.string().min(1),
  x: range,
  y: range,
  scale: z.enum(['equal', 'independent']).optional(),
  axes: z.tuple([z.string(), z.string()]).optional(),
  grid: z.boolean().optional(),
  parameters: parameters.optional(),
  layers: z.array(layer).min(1),
  beats: z
    .array(
      z.strictObject({
        ...beatFields,
        focus: z.array(entityId).min(1),
        wave: z.boolean().optional(),
        set: parameters.optional(),
        show: z.array(entityId).optional(),
      })
    )
    .min(1),
});
export type Spec = z.infer<typeof PlaneSpecSchema>;
export type Layer = z.infer<typeof layer>;
export type Scalar = z.infer<typeof num>;
export type PointRef = z.infer<typeof pointRef>;
export type Position = z.infer<typeof position>;
export type Parameters = z.infer<typeof parameters>;

export function parameterFrames(spec: Spec) {
  let current = spec.parameters ?? {};
  return [current, ...spec.beats.map(beat => (current = { ...current, ...beat.set }))];
}

export function checkPlaneSpec(spec: Spec) {
  const layers = new Map(spec.layers.map(layer => [layer.id, layer]));
  if (layers.size !== spec.layers.length) throw new Error('Duplicate plane layer ID');
  const parameterNames = Object.keys(spec.parameters ?? {});
  const scalar = (v: Scalar) => {
    if (typeof v === 'string' && !parameterNames.includes(v))
      throw new Error('Unknown parameter: ' + v);
  };
  const ref = (v: PointRef) => {
    if (typeof v === 'string') {
      if (layers.get(v)?.type !== 'point') throw new Error('Unknown point: ' + v);
    } else v.forEach(scalar);
  };
  const graph = (id: string) => {
    const item = layers.get(id);
    if (item?.type !== 'curve' && item?.type !== 'line') throw new Error('Unknown graph: ' + id);
  };
  for (const item of spec.layers) {
    switch (item.type) {
      case 'curve':
        compile(item.expr, parameterNames);
        break;
      case 'line':
        Array.isArray(item.form)
          ? item.form.forEach(ref)
          : Object.values(item.form).forEach(scalar);
        break;
      case 'point':
        ref(item.at);
        break;
      case 'circle':
        ref(item.center);
        break;
      case 'unit-circle-wave':
        scalar(item.angle);
        break;
      case 'segment':
      case 'vector':
        item.through.forEach(ref);
        break;
      case 'construction':
        item.through.forEach(ref);
        if (item.horizon !== undefined) scalar(item.horizon);
        break;
      case 'floor':
        ref(item.vanishing);
        item.near.forEach(ref);
        break;
      case 'grid-transform':
        item.matrix.flat().forEach(scalar);
        break;
      case 'intersection':
        item.of.forEach(graph);
        break;
      case 'region':
        item.between.forEach(graph);
        break;
      case 'roots':
        graph(item.of);
        break;
      case 'tangent':
        graph(item.of);
        scalar(item.x);
        scalar(item.h);
        break;
      case 'snell':
        [item.n1, item.n2, item.angle].forEach(scalar);
        break;
    }
  }
  if (
    spec.scale === 'independent' &&
    spec.layers.some(layer =>
      ['circle', 'unit-circle-wave', 'grid-transform', 'snell'].includes(layer.type)
    )
  ) {
    throw new Error('Geometric layers require scale: equal');
  }
  for (const beat of spec.beats) {
    for (const id of [...beat.focus, ...(beat.show ?? [])])
      if (!layers.has(id)) throw new Error('Unknown layer: ' + id);
    Object.keys(beat.set ?? {}).forEach(scalar);
  }
  for (const frame of parameterFrames(spec)) {
    const value = (input: Scalar) => (typeof input === 'number' ? input : frame[input]);
    for (const item of spec.layers)
      if (item.type === 'snell') {
        if (
          value(item.n1) <= 0 ||
          value(item.n2) <= 0 ||
          value(item.angle) < 0 ||
          value(item.angle) > 90
        ) {
          throw new Error('Snell requires positive indices and an incidence angle from 0° to 90°');
        }
      }
  }
}
