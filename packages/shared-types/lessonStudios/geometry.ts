import * as z from 'zod';
import { AlgorithmDataSchema } from './algorithm';
import { checkFunctionPlotSpec, FunctionPlotSpecSchema } from './functionPlotSpec';
import { checkGraphSpec, GraphSpecSchema } from './graphSpec';
import { checkMusicSpec, MusicSpecSchema } from './musicSpec';
import { checkPlaneSpec, PlaneSpecSchema } from './planeSpec';
import { validateStudioCues } from './studioCueValidation';
import { checkTrajectoriesSpec, TrajectoriesSpecSchema } from './trajectoriesSpec';

const { studio: _algorithm, ...narratedShape } = AlgorithmDataSchema.shape;
const preMusicStudios = [
  z.object({ id: z.literal('graph'), spec: GraphSpecSchema }),
  z.object({ id: z.literal('function-plot'), spec: FunctionPlotSpecSchema }),
  z.object({ id: z.literal('plane'), spec: PlaneSpecSchema }),
  z.object({ id: z.literal('trajectories'), spec: TrajectoriesSpecSchema }),
] as const;

export const PreMusicGeometryStudioSchema = z.discriminatedUnion('id', preMusicStudios);
export const GeometryStudioSchema = z.discriminatedUnion('id', [
  ...preMusicStudios,
  z.object({ id: z.literal('music'), spec: MusicSpecSchema }),
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
      if (geometryStudio.id === 'music') checkMusicSpec(geometryStudio.spec);
    },
  });
}
