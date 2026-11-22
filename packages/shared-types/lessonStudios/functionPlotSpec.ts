import * as z from 'zod';
import { checkAxisRange, geometryBeatFields } from './geometryStudioSpec';

export const functionPlotModelGuide = `function-plot spec {family,xRange:[min,max],yRange:[min,max],features?:[],keyframes:[{at,params}]}. Opposing axis endpoints in ascending order. Each keyframe params by family: linear {m,b}, quadratic {a,b,c} with a≠0, sine {amplitude,frequency,phase} with frequency>0 (radians), exponential {base,scale} with base>0. features: vertex (quadratic), roots (linear/quadratic), intercepts (y at x=0). Include only relevant features; optional Italian labels, e.g. {at:"b1",params:{a:-1,b:0,c:0}}. At least 1 keyframe and 2 endpoints per axis.`;

const range = z.tuple([z.number(), z.number()]);
const feature = z.enum(['vertex', 'roots', 'intercepts']);
// Round 1 records may contain note. Only the current label is rendered.
const keyframe = <T extends z.ZodType>(params: T) =>
  z
    .array(
      z.object({
        ...geometryBeatFields,
        params,
        note: z.string().min(1).regex(/\S/u).optional(),
      })
    )
    .min(1);
const axes = { xRange: range, yRange: range, features: z.array(feature).optional() };
export const FunctionPlotSpecSchema = z.discriminatedUnion('family', [
  z.object({
    ...axes,
    family: z.literal('linear'),
    keyframes: keyframe(z.object({ m: z.number(), b: z.number() })),
  }),
  z.object({
    ...axes,
    family: z.literal('quadratic'),
    keyframes: keyframe(
      z.object({
        a: z.number(),
        b: z.number(),
        c: z.number(),
      })
    ),
  }),
  z.object({
    ...axes,
    family: z.literal('sine'),
    keyframes: keyframe(
      z.object({
        amplitude: z.number(),
        frequency: z.number().positive(),
        phase: z.number(),
      })
    ),
  }),
  z.object({
    ...axes,
    family: z.literal('exponential'),
    keyframes: keyframe(z.object({ base: z.number().positive(), scale: z.number() })),
  }),
]);
export type FunctionPlotSpec = z.infer<typeof FunctionPlotSpecSchema>;

export function checkFunctionPlotSpec(spec: FunctionPlotSpec) {
  checkAxisRange(spec.xRange);
  checkAxisRange(spec.yRange);
  if (spec.family === 'quadratic' && spec.keyframes.some(frame => frame.params.a === 0)) {
    throw new Error('Quadratic coefficients require nonzero a');
  }
  for (const feature of spec.features ?? []) {
    if (feature === 'vertex' && spec.family !== 'quadratic')
      throw new Error('Vertex requires a quadratic function');
    if (feature === 'roots' && spec.family !== 'quadratic' && spec.family !== 'linear')
      throw new Error('Roots require a linear or quadratic function');
  }
}
