import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  attachFallowFindingsToBaseline,
  FALLOW_DEAD_CODE_JSON_COMMAND,
} from './check-fallow-regression';

const BASELINE_PATH = '.fallow-baselines/regression.json';
const CANDIDATE_PATH = `${BASELINE_PATH}.next`;

await mkdir(dirname(BASELINE_PATH), { recursive: true });
await rm(CANDIDATE_PATH, { force: true });

const fallowProcess = Bun.spawn(
  [...FALLOW_DEAD_CODE_JSON_COMMAND, '--save-regression-baseline', CANDIDATE_PATH],
  { stderr: 'inherit', stdout: 'pipe' }
);
const output = await new Response(fallowProcess.stdout).text();
const exitCode = await fallowProcess.exited;

try {
  await stat(CANDIDATE_PATH);
} catch {
  throw new Error(`Fallow did not produce ${CANDIDATE_PATH} (exit code ${exitCode}).`);
}

if (exitCode > 1) {
  await rm(CANDIDATE_PATH, { force: true });
  throw new Error(`Fallow baseline generation failed with exit code ${exitCode}.`);
}

const baseline = JSON.parse(await readFile(CANDIDATE_PATH, 'utf8')) as unknown;
const report = JSON.parse(output) as unknown;
const baselineWithFindings = attachFallowFindingsToBaseline(baseline, report);
await writeFile(CANDIDATE_PATH, `${JSON.stringify(baselineWithFindings, null, 2)}\n`);
await rename(CANDIDATE_PATH, BASELINE_PATH);
