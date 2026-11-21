import * as z from 'zod';
import type { ProjectAssetRef } from './projectAsset';

export const ProjectAssetRefSchema = z.object({
  byteSize: z.number().int().nonnegative(),
  hash: z.string().length(64),
  id: z.string().length(64),
  mediaType: z.string().min(1),
}) satisfies z.ZodType<ProjectAssetRef>;
