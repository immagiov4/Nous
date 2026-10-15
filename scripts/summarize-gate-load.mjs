import { readFileSync } from 'node:fs';
import path from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/summarize-gate-load.mjs <capture-directory>');

const samples = readFileSync(path.join(directory, 'processes.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line));
const run = JSON.parse(readFileSync(path.join(directory, 'run.json'), 'utf8'));
const stages = new Map();
let previous = new Map();
let previousElapsed;

for (const sample of samples) {
  const stage = typeof sample.stage === 'string' ? sample.stage : 'command';
  const metrics = stages.get(stage) ?? {
    samples: 0,
    peakBunWorkers: 0,
    peakNodeWorkers: 0,
    peakBrowserProcesses: 0,
    peakMermaidProcesses: 0,
    peakOwnedThreads: 0,
    observedCpuCores: [],
  };
  const owned = sample.processes.filter(process => process.owned);
  const workers = owned.filter(process => process.kind === 'vitest-worker');
  metrics.samples += 1;
  metrics.peakBunWorkers = Math.max(
    metrics.peakBunWorkers,
    workers.filter(process => process.name === 'bun.exe').length
  );
  metrics.peakNodeWorkers = Math.max(
    metrics.peakNodeWorkers,
    workers.filter(process => process.name === 'node.exe').length
  );
  metrics.peakBrowserProcesses = Math.max(
    metrics.peakBrowserProcesses,
    owned.filter(process => process.kind === 'browser').length
  );
  metrics.peakMermaidProcesses = Math.max(
    metrics.peakMermaidProcesses,
    owned.filter(process => process.kind === 'mermaid').length
  );
  metrics.peakOwnedThreads = Math.max(
    metrics.peakOwnedThreads,
    owned.reduce((sum, process) => sum + process.threads, 0)
  );
  const current = new Map();
  let cpuDelta = 0;
  for (const process of owned) {
    const identity = `${process.id}:${process.createdUtc}`;
    current.set(identity, process.cpuSeconds);
    const prior = previous.get(identity);
    if (prior !== undefined) cpuDelta += process.cpuSeconds - prior;
  }
  if (previousElapsed !== undefined) {
    metrics.observedCpuCores.push(cpuDelta / (sample.elapsedSeconds - previousElapsed));
  }
  previous = current;
  previousElapsed = sample.elapsedSeconds;
  stages.set(stage, metrics);
}

const results = [...stages].map(([stage, metrics]) => {
  const cpu = metrics.observedCpuCores.toSorted((left, right) => left - right);
  return {
    stage,
    ...metrics,
    observedCpuCores: undefined,
    p95ObservedCpuCores: cpu[Math.ceil(cpu.length * 0.95) - 1],
    peakObservedCpuCores: cpu.at(-1),
  };
});
process.stdout.write(`${JSON.stringify({ run, stages: results }, null, 2)}\n`);
