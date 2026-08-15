import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FeatureMapObservation } from './feature-map.ts';

export const writeFeatureMapObservation = async (
  observation: FeatureMapObservation
): Promise<void> => {
  const outputDirectory = process.env.FEATURE_MAP_OBSERVATION_DIR;
  if (!outputDirectory) return;
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, `${observation.id}.json`),
    `${JSON.stringify(observation, null, 2)}\n`
  );
};
