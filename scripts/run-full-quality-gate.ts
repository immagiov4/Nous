// Runs every full-gate stage even when an earlier stage fails, so Sonar always receives a scan.
type GateStage = {
  label: string;
  script: string;
};

const GATE_STAGES: GateStage[] = [
  { label: 'Local gate readiness', script: 'doctor:gate' },
  { label: 'Quality checks and Bun test suite', script: 'gate' },
  { label: 'Application LCOV coverage', script: 'test:coverage' },
  { label: 'Sonar analysis', script: 'sonar:scan' },
];

const runScript = async ({ label, script }: GateStage) => {
  process.stdout.write(`\n=== ${label} ===\n`);
  const processHandle = Bun.spawn([process.execPath, 'run', script], {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  return processHandle.exited;
};

const failedStages: GateStage[] = [];

for (const stage of GATE_STAGES) {
  const exitCode = await runScript(stage);
  if (exitCode !== 0) {
    failedStages.push(stage);
  }
}

if (failedStages.length > 0) {
  const failedLabels = failedStages.map(stage => stage.label).join(', ');
  process.stderr.write(`\nFull quality gate failed: ${failedLabels}.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nFull quality gate passed.\n');
}
