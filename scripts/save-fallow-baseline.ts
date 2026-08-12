import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const BASELINE_PATH = '.fallow-baselines/regression.json';
const CANDIDATE_PATH = `${BASELINE_PATH}.next`;

await mkdir(dirname(BASELINE_PATH), { recursive: true });
await rm(CANDIDATE_PATH, { force: true });

const fallowProcess = Bun.spawn(
  ['bunx', 'fallow', 'dead-code', '--save-regression-baseline', CANDIDATE_PATH],
  { stderr: 'inherit', stdout: 'inherit' }
);
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

const baseline = await readFile(CANDIDATE_PATH, 'utf8');
await writeFile(CANDIDATE_PATH, `${baseline.trimEnd()}\n`);
await rename(CANDIDATE_PATH, BASELINE_PATH);
