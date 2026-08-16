import { describe, expect, test, vi } from 'vitest';
import {
  buildWorkflowPostgresCommands,
  runWorkflowPostgresContract,
} from './run-workflow-postgres-contract.js';

const STORE_CONTRACT_FILES = [
  'apps/backend/tests/workflows/postgresWorkflowRunStore.integration.test.ts',
  'apps/backend/tests/workflows/postgresWorkflowExecutionStore.integration.test.ts',
  'apps/backend/tests/workflows/postgresWorkflowSignalStore.integration.test.ts',
];

describe('workflow PostgreSQL contract runner', () => {
  test('builds the critical store and process-crash commands with integration enabled', () => {
    expect(buildWorkflowPostgresCommands('critical')).toEqual([
      {
        args: [
          process.execPath,
          '--bun',
          'vitest',
          'run',
          '--no-file-parallelism',
          '--config',
          'apps/web/vitest.config.ts',
          ...STORE_CONTRACT_FILES,
        ],
        env: { RUN_WORKFLOW_INTEGRATION_TESTS: '1' },
      },
      {
        args: [
          process.execPath,
          '--bun',
          'vitest',
          'run',
          '--config',
          'apps/web/vitest.config.ts',
          'apps/backend/tests/workflows/workflowProcessCrash.integration.test.ts',
        ],
        env: { RUN_WORKFLOW_INTEGRATION_TESTS: '1' },
      },
    ]);
  });

  test('adds undo and project transaction coverage to the full matrix', () => {
    const [storeCommand] = buildWorkflowPostgresCommands('full');

    expect(storeCommand?.args).toEqual(
      expect.arrayContaining([
        'apps/backend/tests/workflows/postgresWorkflowUndoStore.integration.test.ts',
        'apps/backend/tests/projects/projectTransaction.integration.test.ts',
      ])
    );
  });

  test('stops immediately and returns the failing command exit code', async () => {
    const execute = vi.fn().mockResolvedValueOnce(23);

    await expect(runWorkflowPostgresContract('critical', execute)).resolves.toBe(23);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('runs crash recovery only after stores pass and propagates its failure', async () => {
    const execute = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(42);

    await expect(runWorkflowPostgresContract('critical', execute)).resolves.toBe(42);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
