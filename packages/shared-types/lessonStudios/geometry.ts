import * as z from 'zod';
import { cueTimes } from '../lessonSceneAnimation';
import { AlgorithmDataSchema } from './algorithm';
import { checkFunctionPlotSpec, FunctionPlotSpecSchema } from './functionPlot';
import { checkGraphSpec, GraphSpecSchema } from './graph';
import { checkPlaneSpec, PlaneSpecSchema } from './planeSpec';
import { checkTrajectoriesSpec, TrajectoriesSpecSchema } from './trajectories';

const { studio: _algorithm, ...narratedShape } = AlgorithmDataSchema.shape;
export const GeometryStudioSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('graph'), spec: GraphSpecSchema }),
  z.object({ id: z.literal('function-plot'), spec: FunctionPlotSpecSchema }),
  z.object({ id: z.literal('plane'), spec: PlaneSpecSchema }),
  z.object({ id: z.literal('trajectories'), spec: TrajectoriesSpecSchema }),
]);

export const GeometryDataSchema = z.object({
  ...narratedShape,
  geometryStudio: GeometryStudioSchema,
});

export function findGeometryProblems(scene: unknown, narration?: string): string[] {
  const {
    geometryStudio,
    studioCues,
    narration: storedNarration,
  } = GeometryDataSchema.parse(scene);
  const beats =
    geometryStudio.id === 'function-plot'
      ? geometryStudio.spec.keyframes
      : geometryStudio.spec.beats;
  if (beats.length !== studioCues.length) return ['Each studio beat needs one narration cue.'];
  if (new Set(studioCues.map(cue => cue.anchor)).size !== studioCues.length)
    return ['Studio narration anchors must be unique and ordered.'];
  try {
    if (geometryStudio.id === 'graph') checkGraphSpec(geometryStudio.spec);
    if (geometryStudio.id === 'function-plot') checkFunctionPlotSpec(geometryStudio.spec);
    if (geometryStudio.id === 'plane') checkPlaneSpec(geometryStudio.spec);
    if (geometryStudio.id === 'trajectories') checkTrajectoriesSpec(geometryStudio.spec);
    if (studioCues.length) {
      cueTimes(storedNarration, studioCues);
      if (narration !== undefined && narration !== storedNarration) cueTimes(narration, studioCues);
    }
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
