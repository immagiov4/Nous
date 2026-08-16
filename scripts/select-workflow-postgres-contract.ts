import { appendFileSync } from 'node:fs';

const EXACT_CONTRACT_PATHS = new Set([
  '.github/workflows/ci.yml',
  'apps/backend/package.json',
  'apps/backend/tests/projects/projectTransaction.integration.test.ts',
  'apps/web/tests/setup.ts',
  'apps/web/vitest.config.ts',
  'bun.lock',
  'package.json',
  'scripts/run-workflow-postgres-contract.ts',
  'scripts/select-workflow-postgres-contract.ts',
  'supabase/config.toml',
]);

const CONTRACT_PATH_PREFIXES = [
  'apps/backend/src/',
  'apps/backend/tests/workflows/',
  'packages/shared-types/',
  'supabase/migrations/',
];

export const affectsWorkflowPostgresContract = (changedPaths: readonly string[]): boolean =>
  changedPaths.some(
    changedPath =>
      EXACT_CONTRACT_PATHS.has(changedPath) ||
      CONTRACT_PATH_PREFIXES.some(prefix => changedPath.startsWith(prefix))
  );

if (import.meta.main) {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (!githubOutput) throw new Error('GITHUB_OUTPUT is required in CI.');

  const changedPaths = (await Bun.stdin.text()).split('\0').filter(Boolean);
  appendFileSync(githubOutput, `changed=${affectsWorkflowPostgresContract(changedPaths)}\n`);
}
