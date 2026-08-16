import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { affectsWorkflowPostgresContract } from './select-workflow-postgres-contract.js';

describe('workflow PostgreSQL contract selection', () => {
  test.each([
    '.github/workflows/ci.yml',
    'apps/backend/package.json',
    'apps/backend/src/config/modelConfig.ts',
    'apps/backend/src/projects/postgresProjectStore.ts',
    'apps/backend/src/services/lessonVisualModelConfig.ts',
    'apps/backend/src/utils/validation.ts',
    'apps/backend/src/workflows/postgresWorkflowStore.ts',
    'apps/backend/tests/projects/projectTransaction.integration.test.ts',
    'apps/backend/tests/workflows/workflowProcessCrash.integration.test.ts',
    'apps/web/tests/setup.ts',
    'apps/web/vitest.config.ts',
    'bun.lock',
    'package.json',
    'packages/shared-types/projectContract.ts',
    'scripts/run-workflow-postgres-contract.ts',
    'scripts/select-workflow-postgres-contract.ts',
    'supabase/config.toml',
    'supabase/migrations/20260729113844_create_workflow_runtime.sql',
  ])('selects the contract for %s', changedPath => {
    expect(affectsWorkflowPostgresContract([changedPath])).toBe(true);
  });

  test('selects the contract when any changed path crosses its ownership boundary', () => {
    expect(
      affectsWorkflowPostgresContract([
        'apps/web/components/library/HomeChatPanel.tsx',
        'supabase/migrations/20260729113844_create_workflow_runtime.sql',
      ])
    ).toBe(true);
  });

  test('skips unrelated product and documentation changes', () => {
    expect(
      affectsWorkflowPostgresContract([
        'apps/web/components/library/HomeChatPanel.tsx',
        'docs/ARCHITECTURE.md',
      ])
    ).toBe(false);
  });

  test('writes GitHub output from NUL-delimited CI input', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'workflow-postgres-selector-'));
    const githubOutput = join(temporaryDirectory, 'github-output');

    try {
      const result = spawnSync(
        'bun',
        ['run', resolve('scripts/select-workflow-postgres-contract.ts')],
        {
          cwd: resolve('.'),
          encoding: 'utf8',
          env: { ...process.env, GITHUB_OUTPUT: githubOutput },
          input: 'docs/TESTING.md\0apps/web/tests/setup.ts\0',
        }
      );

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(githubOutput, 'utf8')).toBe('changed=true\n');
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
