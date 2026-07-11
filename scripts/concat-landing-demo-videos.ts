import { mkdir, rename, rm } from 'node:fs/promises';
import { constants as osConstants, setPriority } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_FPS,
  DEMO_STAGE_CONFIG,
} from '../apps/web/components/marketing/landingDemoTimeline.ts';

const DEMO_LAYOUTS = ['wide', 'compact'] as const;
const DEMO_LOCALES = ['it', 'en'] as const;
const PROJECT_ROOT = import.meta.dir.replace(/[\\/]scripts$/, '');
const DEMO_ROOT = join(PROJECT_ROOT, 'apps', 'web', 'public', 'marketing', 'demos');
const TEMP_ROOT = join(PROJECT_ROOT, '.temp');
const DURATION_TOLERANCE_SECONDS = 2 / DEMO_FPS;
const EXPECTED_JOURNEY_DURATION_SECONDS = DEMO_STAGE_CONFIG.reduce(
  (total, stage) => total + stage.durationInFrames / DEMO_FPS,
  0
);
const requestedVariants = new Set(Bun.argv.slice(2));

const run = async (command: string[], captureOutput = false): Promise<string> => {
  const process = Bun.spawn(command, {
    cwd: PROJECT_ROOT,
    stdout: captureOutput ? 'pipe' : 'inherit',
    stderr: 'inherit',
  });
  try {
    setPriority(process.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch (error) {
    console.warn(`Could not lower media-process priority: ${String(error)}`);
  }
  const output = captureOutput ? await new Response(process.stdout).text() : '';
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`);
  }
  return output.trim();
};

const probeDuration = async (path: string): Promise<number> => {
  const output = await run(
    [
      'ffprobe',
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ],
    true
  );
  const duration = Number.parseFloat(output);
  if (!Number.isFinite(duration)) {
    throw new Error(`Could not read duration for ${path}`);
  }
  return duration;
};

const toConcatPath = (path: string): string => path.replaceAll('\\', '/').replaceAll("'", "'\\''");

await mkdir(TEMP_ROOT, { recursive: true });

for (const layout of DEMO_LAYOUTS) {
  for (const locale of DEMO_LOCALES) {
    const variant = `${layout}-${locale}`;
    if (requestedVariants.size > 0 && !requestedVariants.has(variant)) {
      continue;
    }

    const inputPaths = DEMO_STAGE_CONFIG.map(({ stage }) =>
      join(DEMO_ROOT, `${stage}-${layout}-${locale}.mp4`)
    );
    for (const [index, inputPath] of inputPaths.entries()) {
      if (!(await Bun.file(inputPath).exists())) {
        throw new Error(`Missing demo scene: ${inputPath}`);
      }
      const expectedDuration = DEMO_STAGE_CONFIG[index].durationInFrames / DEMO_FPS;
      const actualDuration = await probeDuration(inputPath);
      if (Math.abs(actualDuration - expectedDuration) > DURATION_TOLERANCE_SECONDS) {
        throw new Error(
          `Unexpected duration for ${inputPath}: expected ${expectedDuration}s, got ${actualDuration}s`
        );
      }
    }

    const manifestPath = join(TEMP_ROOT, `landing-demo-${variant}.txt`);
    const temporaryOutputPath = join(TEMP_ROOT, `journey-${variant}.mp4`);
    const outputPath = join(DEMO_ROOT, `journey-${variant}.mp4`);
    const manifest = inputPaths.map(path => `file '${toConcatPath(path)}'`).join('\n');

    await Bun.write(manifestPath, `${manifest}\n`);
    try {
      await run([
        'ffmpeg',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        manifestPath,
        '-map',
        '0:v:0',
        '-an',
        '-c:v',
        'copy',
        '-movflags',
        '+faststart',
        temporaryOutputPath,
      ]);
      const outputDuration = await probeDuration(temporaryOutputPath);
      if (
        Math.abs(outputDuration - EXPECTED_JOURNEY_DURATION_SECONDS) > DURATION_TOLERANCE_SECONDS
      ) {
        throw new Error(
          `Invalid concatenated duration for ${variant}: expected ${EXPECTED_JOURNEY_DURATION_SECONDS}s, got ${outputDuration}s`
        );
      }
      await rm(outputPath, { force: true });
      await rename(temporaryOutputPath, outputPath);
      console.log(`${variant}: ${outputDuration}s -> ${outputPath}`);
    } finally {
      await rm(manifestPath, { force: true });
      await rm(temporaryOutputPath, { force: true });
    }
  }
}
