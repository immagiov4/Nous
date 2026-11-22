import * as z from 'zod';
import { AlgorithmDataSchema } from './algorithm';
import { checkFunctionPlotSpec, FunctionPlotSpecSchema } from './functionPlotSpec';
import { checkGraphSpec, GraphSpecSchema } from './graphSpec';
import { checkPlaneSpec, PlaneSpecSchema } from './planeSpec';
import { checkSpace3dSpec, Space3dSpecSchema } from './space3dSpec';
import { validateStudioCues } from './studioCueValidation';
import { checkTrajectoriesSpec, TrajectoriesSpecSchema } from './trajectoriesSpec';

const { studio: _algorithm, ...narratedShape } = AlgorithmDataSchema.shape;
const initialGeometryStudios = [
  z.object({ id: z.literal('graph'), spec: GraphSpecSchema }),
  z.object({ id: z.literal('function-plot'), spec: FunctionPlotSpecSchema }),
  z.object({ id: z.literal('plane'), spec: PlaneSpecSchema }),
  z.object({ id: z.literal('trajectories'), spec: TrajectoriesSpecSchema }),
] as const;
export const InitialGeometryStudioSchema = z.discriminatedUnion('id', initialGeometryStudios);
export const GeometryStudioSchema = z.discriminatedUnion('id', [
  ...initialGeometryStudios,
  z.object({ id: z.literal('space-3d'), spec: Space3dSpecSchema }),
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
      if (geometryStudio.id === 'space-3d') checkSpace3dSpec(geometryStudio.spec);
      if (geometryStudio.id === 'trajectories') checkTrajectoriesSpec(geometryStudio.spec);
    },
  });
}
