import { mkdir, readdir, rm } from 'node:fs/promises';
import { constants as osConstants, setPriority } from 'node:os';
import { join } from 'node:path';

const DEMO_SCENES = [
  'plan-wide',
  'plan-compact',
  'generation-wide',
  'generation-compact',
  'lesson-wide',
  'lesson-compact',
  'library-wide',
  'library-compact',
] as const;
const DEMO_LOCALES = ['it', 'en'] as const;
const PROJECT_ROOT = import.meta.dir.replace(/[\\/]scripts$/, '');
const FRAME_ROOT = join(PROJECT_ROOT, 'temp-landing-demo-frames');
const requestedConcurrency = Number.parseInt(Bun.env.LANDING_DEMO_RENDER_CONCURRENCY || '4', 10);
const RENDER_CONCURRENCY = Number.isFinite(requestedConcurrency)
  ? Math.min(8, Math.max(1, requestedConcurrency))
  : 4;
const requestedCompositions = new Set(Bun.argv.slice(2));
const renderedVariants = new Set<string>();

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

await mkdir(FRAME_ROOT, { recursive: true });
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

for (const scene of DEMO_SCENES) {
  for (const locale of DEMO_LOCALES) {
    const composition = `${scene}-${locale}`;
    if (requestedCompositions.size > 0 && !requestedCompositions.has(composition)) {
      continue;
    }

    const frameDirectory = join(FRAME_ROOT, composition);
    const outputPath = join(
      PROJECT_ROOT,
      'apps',
      'web',
      'public',
      'marketing',
      'demos',
      `${composition}.mp4`
    );

    await rm(frameDirectory, { force: true, recursive: true });
    await mkdir(frameDirectory, { recursive: true });
    await run([
      'bunx',
      'remotion',
      'render',
      'apps/web/remotion/landingDemos.entry.tsx',
      composition,
      frameDirectory,
      '--sequence',
      '--image-format=png',
      '--image-sequence-pattern=frame-[frame].[ext]',
      `--concurrency=${RENDER_CONCURRENCY}`,
      '--muted',
    ]);
    const firstFrameName = (await readdir(frameDirectory)).sort()[0];
    const frameNumber = firstFrameName?.match(/\d+/);
    if (!firstFrameName || !frameNumber) {
      throw new Error(`No rendered frames found for ${composition}`);
    }
    const framePattern = firstFrameName.replace(frameNumber[0], `%0${frameNumber[0].length}d`);
    await run([
      'ffmpeg',
      '-y',
      '-framerate',
      '30',
      '-i',
      join(frameDirectory, framePattern),
      '-an',
      '-vf',
      'format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'veryslow',
      '-tune',
      'animation',
      '-crf',
      '17',
      '-profile:v',
      'high',
      '-level:v',
      '4.1',
      '-x264-params',
      'keyint=60:min-keyint=30:scenecut=0:colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off',
      '-color_range',
      'tv',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-movflags',
      '+faststart',
      '-video_track_timescale',
      '15360',
      outputPath,
    ]);
    await rm(frameDirectory, { force: true, recursive: true });
    renderedVariants.add(`${scene.endsWith('-compact') ? 'compact' : 'wide'}-${locale}`);
  }
}

if (renderedVariants.size > 0) {
  await run(['bun', 'run', 'scripts/concat-landing-demo-videos.ts', ...renderedVariants]);
}
