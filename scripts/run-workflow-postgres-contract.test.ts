import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const postgresTestClient = vi.hoisted(() => {
  const end = vi.fn(async () => undefined);
  const query = vi.fn(async () => [{ count: 0 }]);
  const sql = Object.assign(query, { end });
  return {
    end,
    postgres: vi.fn(() => sql),
    query,
  };
});

vi.mock('postgres', () => ({ default: postgresTestClient.postgres }));

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
  const isolatedDatabase = async () => 0;
  const previousDatabaseUrl = process.env.WORKFLOW_INTEGRATION_DATABASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    postgresTestClient.query.mockResolvedValue([{ count: 0 }]);
  });

  afterEach(() => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.WORKFLOW_INTEGRATION_DATABASE_URL;
      return;
    }
    process.env.WORKFLOW_INTEGRATION_DATABASE_URL = previousDatabaseUrl;
  });

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

    await expect(runWorkflowPostgresContract('critical', execute, isolatedDatabase)).resolves.toBe(
      23
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('runs crash recovery only after stores pass and propagates its failure', async () => {
    const execute = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(42);

    await expect(runWorkflowPostgresContract('critical', execute, isolatedDatabase)).resolves.toBe(
      42
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test('rejects a database used by another Postgres.js client before starting tests', async () => {
    const execute = vi.fn();

    await expect(runWorkflowPostgresContract('critical', execute, async () => 1)).rejects.toThrow(
      'Workflow PostgreSQL contract requires an isolated database without other Postgres.js clients.'
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test('probes the configured database and closes the preflight connection', async () => {
    process.env.WORKFLOW_INTEGRATION_DATABASE_URL = 'postgresql://contract-database';
    const execute = vi.fn().mockResolvedValue(0);

    await expect(runWorkflowPostgresContract('critical', execute)).resolves.toBe(0);

    expect(postgresTestClient.postgres).toHaveBeenCalledWith('postgresql://contract-database', {
      connection: { application_name: 'nous-workflow-postgres-contract' },
      max: 1,
    });
    expect(postgresTestClient.query).toHaveBeenCalledOnce();
    expect(postgresTestClient.end).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test('requires a database URL before opening the preflight connection', async () => {
    delete process.env.WORKFLOW_INTEGRATION_DATABASE_URL;

    await expect(runWorkflowPostgresContract('critical', vi.fn())).rejects.toThrow(
      'WORKFLOW_INTEGRATION_DATABASE_URL is required for workflow integration tests.'
    );
    expect(postgresTestClient.postgres).not.toHaveBeenCalled();
  });

  test('closes the preflight connection before rejecting a concurrent client', async () => {
    process.env.WORKFLOW_INTEGRATION_DATABASE_URL = 'postgresql://contract-database';
    postgresTestClient.query.mockResolvedValueOnce([{ count: 1 }]);
    const execute = vi.fn();

    await expect(runWorkflowPostgresContract('critical', execute)).rejects.toThrow(
      'Workflow PostgreSQL contract requires an isolated database without other Postgres.js clients.'
    );
    expect(postgresTestClient.end).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
});
