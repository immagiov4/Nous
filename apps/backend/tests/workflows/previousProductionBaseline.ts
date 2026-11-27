import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { parseDefinitionManifest } from '../../src/workflows/workflowDefinitionReconciler.js';
import committedBaseline from './fixtures/previousProductionWorkflowDeployment.fixture.js';

const capturedBaselineSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  workflowSetVersion: z.number().int().positive(),
  migrations: z.array(z.string()).nonempty(),
  deployments: z.array(z.unknown()).nonempty(),
});

export function loadPreviousProductionBaseline() {
  const path = process.env.NOUS_PRODUCTION_BASELINE;
  if (path) {
    const { deployments, ...baseline } = capturedBaselineSchema.parse(
      JSON.parse(readFileSync(path, 'utf8'))
    );
    return { ...baseline, deployments: parseDefinitionManifest(deployments) };
  }
  return committedBaseline;
}

export function migrationVersion(filename: string) {
  return filename.split('_', 1)[0];
}

export function loadPreviousProductionMigrationVersions(trackedMigrations: readonly string[]) {
  const appliedVersions = readFileSync(
    new URL('./fixtures/productionAppliedMigrationVersions.txt', import.meta.url),
    'utf8'
  )
    .trim()
    .split(/\r?\n/u);
  return [...new Set([...appliedVersions, ...trackedMigrations.map(migrationVersion)])];
}
