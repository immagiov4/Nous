import path from 'node:path';

export type GateStage = {
  label: string;
  script: string;
};

export type GateStageResult = GateStage & {
  durationMs: number;
  exitCode: number;
};

type RunGateStage = (stage: GateStage) => Promise<GateStageResult>;

const CHECK_GATE_STAGES: GateStage[] = [
  { label: 'Type, lint, and dependency quality', script: 'quality' },
  { label: 'Fallow regression check', script: 'check:fallow:ci' },
  { label: 'Bun test suite', script: 'test' },
];

const COVERAGE_STAGE: GateStage = {
  label: 'Application LCOV coverage',
  script: 'test:coverage',
};

const SONAR_STAGE: GateStage = {
  label: 'Sonar analysis',
  script: 'sonar:scan',
};

const SONAR_START_STAGE: GateStage = {
  label: 'Start local Sonar',
  script: 'sonar:up',
};

const SONAR_STOP_STAGE: GateStage = {
  label: 'Stop local Sonar',
  script: 'sonar:stop',
};

const formatDuration = (durationMs: number): string => `${(durationMs / 1_000).toFixed(3)}s`;

const writeStageOutput = (result: GateStageResult, stdout: string, stderr: string) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  const outcome = result.exitCode === 0 ? 'passed' : `failed with exit code ${result.exitCode}`;
  process.stdout.write(
    `\n=== ${result.label} ${outcome} in ${formatDuration(result.durationMs)} ===\n`
  );
};

const createScriptRunner =
  (environment: Record<string, string | undefined>): RunGateStage =>
  async stage => {
    process.stdout.write(`\n=== Starting ${stage.label} ===\n`);
    const startedAt = performance.now();
    const processHandle = Bun.spawn([process.execPath, 'run', stage.script], {
      cwd: process.cwd(),
      env: environment,
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    const result = {
      ...stage,
      durationMs: performance.now() - startedAt,
      exitCode,
    };
    writeStageOutput(result, stdout, stderr);
    return result;
  };

export const executeFullQualityGate = async (
  runStage: RunGateStage
): Promise<GateStageResult[]> => {
  const runStageSafely = async (stage: GateStage): Promise<GateStageResult> => {
    try {
      return await runStage(stage);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\n=== ${stage.label} crashed: ${reason} ===\n`);
      return { ...stage, durationMs: 0, exitCode: 1 };
    }
  };

  const results: GateStageResult[] = [];
  for (const stage of CHECK_GATE_STAGES) results.push(await runStageSafely(stage));
  const coverageResult = await runStageSafely(COVERAGE_STAGE);
  results.push(coverageResult);
  try {
    results.push(await runStageSafely(SONAR_START_STAGE), await runStageSafely(SONAR_STAGE));
  } finally {
    results.push(await runStageSafely(SONAR_STOP_STAGE));
  }
  return results;
};

const main = async () => {
  const eslintReportPath = path.resolve(
    '.temp/sonar',
    `eslint-report-full-gate-${process.pid}.json`
  );
  const environment = {
    ...process.env,
    SONAR_ESLINT_REPORT_PATH: eslintReportPath,
  };
  const startedAt = performance.now();
  const results = await executeFullQualityGate(createScriptRunner(environment));
  const failedStages = results.filter(result => result.exitCode !== 0);
  const totalDuration = formatDuration(performance.now() - startedAt);

  if (failedStages.length > 0) {
    const failedLabels = failedStages.map(stage => stage.label).join(', ');
    process.stderr.write(`\nFull quality gate failed in ${totalDuration}: ${failedLabels}.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`\nFull quality gate passed in ${totalDuration}.\n`);
  }
};

if (import.meta.main) await main();
