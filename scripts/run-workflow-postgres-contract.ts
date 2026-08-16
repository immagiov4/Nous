const STORE_CONTRACT_FILES = [
  'apps/backend/tests/workflows/postgresWorkflowRunStore.integration.test.ts',
  'apps/backend/tests/workflows/postgresWorkflowExecutionStore.integration.test.ts',
  'apps/backend/tests/workflows/postgresWorkflowSignalStore.integration.test.ts',
];

const FULL_CONTRACT_FILES = [
  ...STORE_CONTRACT_FILES,
  'apps/backend/tests/workflows/postgresWorkflowUndoStore.integration.test.ts',
  'apps/backend/tests/projects/projectTransaction.integration.test.ts',
];

const PROCESS_CRASH_FILE = 'apps/backend/tests/workflows/workflowProcessCrash.integration.test.ts';

export type WorkflowPostgresContractMode = 'critical' | 'full';

export type WorkflowPostgresCommand = {
  args: string[];
  env: Record<string, string>;
};

type ExecuteCommand = (command: WorkflowPostgresCommand) => Promise<number>;

export function buildWorkflowPostgresCommands(
  mode: WorkflowPostgresContractMode
): WorkflowPostgresCommand[] {
  const vitest = [process.execPath, '--bun', 'vitest', 'run'];
  const config = ['--config', 'apps/web/vitest.config.ts'];
  const env = { RUN_WORKFLOW_INTEGRATION_TESTS: '1' };

  return [
    {
      args: [
        ...vitest,
        '--no-file-parallelism',
        ...config,
        ...(mode === 'full' ? FULL_CONTRACT_FILES : STORE_CONTRACT_FILES),
      ],
      env,
    },
    { args: [...vitest, ...config, PROCESS_CRASH_FILE], env },
  ];
}

async function executeCommand(command: WorkflowPostgresCommand): Promise<number> {
  const child = Bun.spawn(command.args, {
    env: { ...process.env, ...command.env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return child.exited;
}

export async function runWorkflowPostgresContract(
  mode: WorkflowPostgresContractMode,
  execute: ExecuteCommand = executeCommand
): Promise<number> {
  for (const command of buildWorkflowPostgresCommands(mode)) {
    const exitCode = await execute(command);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== 'critical' && mode !== 'full') {
    throw new Error('Expected workflow PostgreSQL contract mode: critical or full.');
  }
  process.exitCode = await runWorkflowPostgresContract(mode);
}
