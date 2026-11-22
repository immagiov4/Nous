import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  createProductionRegistry,
  WORKFLOW_SET_VERSION,
} from '../apps/backend/src/workflows/runtime/workflowRuntimeComposition.js';

export function captureWorkflowDeployment(
  outputPath: string | undefined,
  gitPath: string | null
): void {
  if (!outputPath) throw new Error('Expected an output path for the workflow deployment fixture.');
  if (!gitPath || !isAbsolute(gitPath))
    throw new Error('Could not resolve an absolute Git executable.');

  const git = (...args: string[]) =>
    execFileSync(gitPath, args, { encoding: 'utf8', windowsHide: true });
  const migrationDirectory = 'supabase/migrations/';
  git('diff', 'HEAD', '--quiet');
  const commit = git('rev-parse', 'HEAD').trim();
  const migrations = git('ls-tree', '-r', '--name-only', 'HEAD', migrationDirectory)
    .split(/\r?\n/u)
    .filter(path => path.endsWith('.sql'))
    .map(path => path.slice(migrationDirectory.length));
  const fixture = {
    commit,
    workflowSetVersion: WORKFLOW_SET_VERSION,
    migrations,
    deployments: createProductionRegistry().listDefinitionDeployments(),
  };
  writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
}

if (import.meta.main) captureWorkflowDeployment(process.argv[2], Bun.which('git'));
