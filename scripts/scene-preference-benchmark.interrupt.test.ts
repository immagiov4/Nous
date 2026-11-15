import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

test.each([
  'SIGINT',
  'SIGTERM',
])('checkpoints a parent %s through the real CLI lease wrapper', async signal => {
  const folder = await mkdtemp(join(tmpdir(), 'scene-interrupt-'));
  const dataset = join(folder, 'cases.jsonl');
  const output = join(folder, 'report.json');
  const preload = join(folder, 'preload.ts');
  await writeFile(
    dataset,
    JSON.stringify({
      id: 'synthetic-interrupt',
      passage: 'Rain falls.',
      sectionTitle: 'Water',
      sectionDescription: '',
      preferred: 'parts',
      rejected: 'concepts',
      tie: false,
    })
  );
  await writeFile(
    preload,
    `
if (process.env.HEAVY_RUN_HELD !== '1') process.on('message', () => process.emit('${signal}'));
globalThis.fetch = async (_request, init) => {
  process.stdout.write('SCENE_BENCHMARK_ACTIVE\\n');
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new Error('synthetic abort'));
    if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
  });
};
`
  );
  const child = spawn(
    'bun',
    [
      '--preload',
      preload,
      '--tsconfig-override',
      resolve('apps/backend/tsconfig.json'),
      resolve('scripts/scene-preference-benchmark.ts'),
      '--dataset',
      dataset,
      '--output',
      output,
      '--run',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI: 'false',
        HEAVY_RUN_HELD: '',
        HEAVY_RUN_GROUP_PID: '',
        HEAVY_RUN_OWNER_ID: '',
        HEAVY_RUN_DIR: join(folder, 'leases'),
        OPENROUTER_API_KEY: 'synthetic-key',
        AI_PROVIDER: 'openrouter',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );
  children.push(child);
  let sent = false;
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => {
    stdout += chunk;
    if (!sent && stdout.includes('SCENE_BENCHMARK_ACTIVE')) {
      sent = true;
      child.send('interrupt', () => child.disconnect());
    }
  });
  child.stderr?.on('data', chunk => {
    stderr += chunk;
  });
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    expect(sent, stderr).toBe(true);
    expect(code, stderr).toBe(130);
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report).toMatchObject({
      cancelled: true,
      summary: { completedTrials: 0, cancelledTrials: 1 },
    });
    expect(report.trials).toHaveLength(1);
    expect(report.trials[0].kind).toBe('cancelled');
  } finally {
    child.kill();
    await rm(folder, { recursive: true, force: true });
  }
});
