import * as z from 'zod';
import { ProjectAssetRefSchema } from '../projectAssetRefSchema';
import { AlgorithmDataSchema } from './algorithm';
import { checkFunctionPlotSpec, FunctionPlotSpecSchema } from './functionPlotSpec';
import { checkGraphSpec, GraphSpecSchema } from './graphSpec';
import { ImageAnnotateStoredSpecSchema, isValidImageAnnotation } from './imageAnnotateSpec';
import { checkPlaneSpec, PlaneSpecSchema } from './planeSpec';
import { validateStudioCues } from './studioCueValidation';
import { checkTrajectoriesSpec, TrajectoriesSpecSchema } from './trajectoriesSpec';

const { studio: _algorithm, ...narratedShape } = AlgorithmDataSchema.shape;
export const GeometrySelectionSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('graph'), spec: GraphSpecSchema }),
  z.object({ id: z.literal('function-plot'), spec: FunctionPlotSpecSchema }),
  z.object({ id: z.literal('plane'), spec: PlaneSpecSchema }),
  z.object({ id: z.literal('trajectories'), spec: TrajectoriesSpecSchema }),
]);

const GeometryStudioSchema = z.discriminatedUnion('id', [
  ...GeometrySelectionSchema.options,
  z.object({
    id: z.literal('image-annotate'),
    spec: ImageAnnotateStoredSpecSchema,
    asset: ProjectAssetRefSchema.extend({
      id: z.string().regex(/^[a-f0-9]{64}$/u),
      hash: z.string().regex(/^[a-f0-9]{64}$/u),
      mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    }),
  }),
]);

export const GeometryDataSchema = z.object({
  ...narratedShape,
  geometryStudio: GeometryStudioSchema,
});

export function findGeometryProblems(scene: unknown, narration?: string): string[] {
  const data = GeometryDataSchema.parse(scene);
  const { geometryStudio } = data;
  const beats =
    geometryStudio.id === 'function-plot'
      ? geometryStudio.spec.keyframes
      : geometryStudio.spec.beats;
  return validateStudioCues(data, {
    beatCount: beats.length,
    narration,
    distinctTimes: true,
    checkSpec() {
      if (geometryStudio.id === 'graph') checkGraphSpec(geometryStudio.spec);
      if (geometryStudio.id === 'function-plot') checkFunctionPlotSpec(geometryStudio.spec);
      if (geometryStudio.id === 'plane') checkPlaneSpec(geometryStudio.spec);
      if (geometryStudio.id === 'trajectories') checkTrajectoriesSpec(geometryStudio.spec);
      if (geometryStudio.id === 'image-annotate' && !isValidImageAnnotation(geometryStudio.spec))
        throw new Error('Invalid image annotations.');
    },
  });
}
