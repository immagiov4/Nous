import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  createProductionRegistry,
  WORKFLOW_SET_VERSION,
} from '../apps/backend/src/workflows/runtime/workflowRuntimeComposition.js';

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Expected an output path for the workflow deployment fixture.');

execFileSync('git', ['diff', 'HEAD', '--quiet']);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const migrations = execFileSync(
  'git',
  ['ls-tree', '-r', '--name-only', 'HEAD', 'supabase/migrations/'],
  { encoding: 'utf8' }
)
  .trim()
  .split('\n')
  .filter(path => path.endsWith('.sql'))
  .map(path => path.slice('supabase/migrations/'.length));
const fixture = {
  commit,
  workflowSetVersion: WORKFLOW_SET_VERSION,
  migrations,
  deployments: createProductionRegistry().listDefinitionDeployments(),
};
writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
