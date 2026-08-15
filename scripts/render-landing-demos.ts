import { mkdir } from 'node:fs/promises';
import { constants as osConstants, setPriority } from 'node:os';
import { join } from 'node:path';

const DEMO_LOCALES = ['it', 'en'] as const;
const DEMO_COMPOSITIONS = DEMO_LOCALES.map(locale => `journey-wide-${locale}`);
const PROJECT_ROOT = import.meta.dir.replace(/[\\/]scripts$/, '');
const DEMO_ROOT = join(PROJECT_ROOT, 'apps', 'web', 'public', 'marketing', 'demos');
const requestedConcurrency = Number.parseInt(Bun.env.LANDING_DEMO_RENDER_CONCURRENCY || '4', 10);
const RENDER_CONCURRENCY = Number.isFinite(requestedConcurrency)
  ? Math.min(8, Math.max(1, requestedConcurrency))
  : 4;
const requestedCompositions = new Set(Bun.argv.slice(2));
const unknownCompositions: string[] = [...requestedCompositions].filter(
  composition => !DEMO_COMPOSITIONS.includes(composition)
);
if (unknownCompositions.length > 0) {
  throw new Error(
    `Unknown landing demo composition: ${unknownCompositions.join(', ')}. Expected one of: ${DEMO_COMPOSITIONS.join(', ')}`
  );
}

const run = async (command: string[]) => {
  const process = Bun.spawn(command, {
    cwd: PROJECT_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  try {
    setPriority(process.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch (error) {
    console.warn(`Could not lower render priority: ${String(error)}`);
  }
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`);
  }
};

await mkdir(DEMO_ROOT, { recursive: true });
await run([
  'bunx',
  'tailwindcss',
  '-c',
  'apps/web/remotion/tailwind.config.cjs',
  '-i',
  'apps/web/remotion/landingDemos.tailwind.css',
  '-o',
  'apps/web/remotion/landingDemos.tailwind.generated.css',
  '--minify',
]);

for (const composition of DEMO_COMPOSITIONS) {
  if (requestedCompositions.size > 0 && !requestedCompositions.has(composition)) {
    continue;
  }

  const outputPath = join(DEMO_ROOT, `${composition}.mp4`);
  await run([
    'bunx',
    'remotion',
    'render',
    'apps/web/remotion/landingDemos.entry.tsx',
    composition,
    outputPath,
    '--codec=h264',
    '--crf=17',
    '--image-format=png',
    '--color-space=bt709',
    '--pixel-format=yuv420p',
    '--x264-preset=slow',
    '--chrome-mode=chrome-for-testing',
    '--scale=2',
    `--concurrency=${RENDER_CONCURRENCY}`,
    '--muted',
  ]);
  console.log(`${composition} -> ${outputPath}`);
}
