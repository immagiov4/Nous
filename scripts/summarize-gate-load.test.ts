import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

test('summarizes owned workers, native children, CPU deltas and reused process IDs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nous-gate-load-'));
  const worker = {
    id: 1,
    name: 'bun.exe',
    kind: 'vitest-worker',
    cpuSeconds: 0,
    owned: true,
    createdUtc: '2026-10-15T00:00:00.000Z',
    threads: 2,
  };
  const secondWorker = { ...worker, id: 2 };
  const parser = { ...worker, id: 3, kind: 'mermaid' };
  const unrelated = { ...worker, id: 4, owned: false, cpuSeconds: 100 };
  const samples = [
    { elapsedSeconds: 0, stage: 'ci', processes: [worker, secondWorker, parser, unrelated] },
    {
      elapsedSeconds: 1,
      stage: 'ci',
      processes: [
        { ...worker, cpuSeconds: 1 },
        { ...secondWorker, cpuSeconds: 0.5 },
        { ...parser, cpuSeconds: 0.25 },
        { ...unrelated, cpuSeconds: 200 },
      ],
    },
    {
      elapsedSeconds: 2,
      stage: 'coverage',
      processes: [
        { ...worker, name: 'node.exe', cpuSeconds: 0.1, createdUtc: '2026-10-15T00:00:01.500Z' },
        { ...parser, id: 5, name: 'chrome.exe', kind: 'browser', cpuSeconds: 0.2 },
      ],
    },
  ];
  try {
    await writeFile(
      path.join(directory, 'processes.jsonl'),
      samples.map(sample => JSON.stringify(sample)).join('\n')
    );
    await writeFile(path.join(directory, 'run.json'), JSON.stringify({ exitCode: 0 }));
    const summary = JSON.parse(
      execFileSync('node', ['scripts/summarize-gate-load.mjs', directory], {
        encoding: 'utf8',
        windowsHide: true,
      })
    );
    expect(summary.stages).toEqual([
      expect.objectContaining({
        stage: 'ci',
        peakBunWorkers: 2,
        peakNodeWorkers: 0,
        peakMermaidProcesses: 1,
        peakOwnedThreads: 6,
        p95ObservedCpuCores: 1.75,
      }),
      expect.objectContaining({
        stage: 'coverage',
        peakBunWorkers: 0,
        peakNodeWorkers: 1,
        peakBrowserProcesses: 1,
        p95ObservedCpuCores: 0,
      }),
    ]);
    expect(summary.run.exitCode).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
