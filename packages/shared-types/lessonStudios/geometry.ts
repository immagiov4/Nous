import * as z from 'zod';
import { ProjectAssetRefSchema } from '../projectAssetRefSchema';
import { AlgorithmDataSchema } from './algorithm';
import { checkFunctionPlotSpec, FunctionPlotSpecSchema } from './functionPlotSpec';
import {
  checkGraphSpec,
  GraphSpecSchema,
  PreBankGraphSpecSchema,
  PrePrimGraphSpecSchema,
} from './graphSpec';
import { ImageAnnotateStoredSpecSchema, isValidImageAnnotation } from './imageAnnotateSpec';
import { checkMusicSpec, MusicSpecSchema } from './musicSpec';
import { checkPlaneSpec, PlaneSpecSchema } from './planeSpec';
import { checkSpace3dSpec, Space3dSpecSchema } from './space3dSpec';
import { validateStudioCues } from './studioCueValidation';
import { checkTrajectoriesSpec, TrajectoriesSpecSchema } from './trajectoriesSpec';

const { studio: _algorithm, ...narratedShape } = AlgorithmDataSchema.shape;
const initialGeometryStudios = [
  z.object({ id: z.literal('graph'), spec: PrePrimGraphSpecSchema }),
  z.object({ id: z.literal('function-plot'), spec: FunctionPlotSpecSchema }),
  z.object({ id: z.literal('plane'), spec: PlaneSpecSchema }),
  z.object({ id: z.literal('trajectories'), spec: TrajectoriesSpecSchema }),
] as const;
export const InitialGeometryStudioSchema = z.discriminatedUnion('id', initialGeometryStudios);
export const Space3dGeometryStudioSchema = z.discriminatedUnion('id', [
  ...initialGeometryStudios,
  z.object({ id: z.literal('space-3d'), spec: Space3dSpecSchema }),
]);

export const ImageAnnotationGeometryStudioSchema = z.discriminatedUnion('id', [
  ...Space3dGeometryStudioSchema.options,
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

const musicStudio = z.object({ id: z.literal('music'), spec: MusicSpecSchema });
const graphStudio = initialGeometryStudios[0].extend({ spec: GraphSpecSchema });
const preBankGraphStudio = initialGeometryStudios[0].extend({ spec: PreBankGraphSpecSchema });
const [, ...spaceAndPlaneStudios] = Space3dGeometryStudioSchema.options;
const [, ...imageAndPlaneStudios] = ImageAnnotationGeometryStudioSchema.options;
export const PrePrimGeometrySelectionSchema = z.discriminatedUnion('id', [
  ...Space3dGeometryStudioSchema.options,
  musicStudio,
]);
export const GeometrySelectionSchema = z.discriminatedUnion('id', [
  preBankGraphStudio,
  ...spaceAndPlaneStudios,
  musicStudio,
]);
export const PrePrimGeometryStudioSchema = z.discriminatedUnion('id', [
  ...ImageAnnotationGeometryStudioSchema.options,
  musicStudio,
]);
export const PreBankGeometryStudioSchema = z.discriminatedUnion('id', [
  preBankGraphStudio,
  ...imageAndPlaneStudios,
  musicStudio,
]);
const GeometryStudioSchema = z.discriminatedUnion('id', [
  graphStudio,
  ...imageAndPlaneStudios,
  musicStudio,
]);
export type GeometryStudioId = z.infer<typeof GeometryStudioSchema>['id'];

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
      if (geometryStudio.id === 'music') checkMusicSpec(geometryStudio.spec);
      if (geometryStudio.id === 'space-3d') checkSpace3dSpec(geometryStudio.spec);
      if (geometryStudio.id === 'trajectories') checkTrajectoriesSpec(geometryStudio.spec);
      if (geometryStudio.id === 'image-annotate' && !isValidImageAnnotation(geometryStudio.spec))
        throw new Error('Invalid image annotations.');
    },
  });
}
