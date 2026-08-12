import { readFile } from 'node:fs/promises';

const BASELINE_PATH = '.fallow-baselines/regression.json';

const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as {
  check?: { total_issues?: unknown };
};
const baselineIssueCount = baseline.check?.total_issues;
if (typeof baselineIssueCount !== 'number') {
  throw new Error(`Invalid Fallow regression baseline: ${BASELINE_PATH}.`);
}

const fallowProcess = Bun.spawn(['bunx', 'fallow', 'dead-code', '--format', 'json'], {
  stderr: 'inherit',
  stdout: 'pipe',
});
const output = await new Response(fallowProcess.stdout).text();
const exitCode = await fallowProcess.exited;
if (exitCode > 1) {
  throw new Error(`Fallow analysis failed with exit code ${exitCode}.`);
}

const report = JSON.parse(output) as { total_issues?: unknown };
const currentIssueCount = report.total_issues;
if (typeof currentIssueCount !== 'number') {
  throw new Error('Fallow did not return a valid dead-code report.');
}

const delta = currentIssueCount - baselineIssueCount;
if (delta > 0) {
  throw new Error(
    `Fallow regression detected: ${currentIssueCount} issues ` +
      `(baseline: ${baselineIssueCount}, delta: +${delta}).`
  );
}

process.stdout.write(
  `Fallow regression check passed: ${currentIssueCount} issues ` +
    `(baseline: ${baselineIssueCount}, delta: ${delta}).\n`
);
