import { describe, expect, test, vi } from 'vitest';

import {
  executeFullQualityGate,
  type GateStage,
  type GateStageResult,
} from './run-full-quality-gate.ts';

const passedResult = (stage: GateStage): GateStageResult => ({
  ...stage,
  durationMs: 1,
  exitCode: 0,
});

describe('full quality gate runner', () => {
  test('runs one heavy stage at a time and stops Sonar after the scan', async () => {
    const invokedScripts: string[] = [];
    let activeStageCount = 0;
    let maximumActiveStageCount = 0;

    await executeFullQualityGate(async stage => {
      invokedScripts.push(stage.script);
      activeStageCount += 1;
      maximumActiveStageCount = Math.max(maximumActiveStageCount, activeStageCount);
      await Promise.resolve();
      activeStageCount -= 1;
      return passedResult(stage);
    });

    expect(invokedScripts).toEqual([
      'quality',
      'check:fallow:ci',
      'test',
      'test:coverage',
      'sonar:up',
      'sonar:scan',
      'sonar:stop',
    ]);
    expect(maximumActiveStageCount).toBe(1);
  });

  test('continues through Sonar and exposes every failed stage', async () => {
    const invokedScripts: string[] = [];
    const failedScripts = new Set(['quality', 'test:coverage']);

    const results = await executeFullQualityGate(async stage => {
      invokedScripts.push(stage.script);
      return {
        ...passedResult(stage),
        exitCode: failedScripts.has(stage.script) ? 1 : 0,
      };
    });

    expect(invokedScripts.at(-1)).toBe('sonar:stop');
    expect(results.filter(result => result.exitCode !== 0).map(result => result.script)).toEqual([
      'quality',
      'test:coverage',
    ]);
  });

  test('continues after runner crashes and reports every crashed stage', async () => {
    const invokedScripts: string[] = [];
    const crashedScripts = new Set(['quality', 'sonar:up', 'sonar:stop']);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const results = await executeFullQualityGate(async stage => {
      invokedScripts.push(stage.script);
      if (crashedScripts.has(stage.script)) throw new Error(`${stage.script} crashed`);
      return passedResult(stage);
    });

    expect(invokedScripts).toEqual([
      'quality',
      'check:fallow:ci',
      'test',
      'test:coverage',
      'sonar:up',
      'sonar:scan',
      'sonar:stop',
    ]);
    expect(results.filter(result => result.exitCode !== 0).map(result => result.script)).toEqual([
      'quality',
      'sonar:up',
      'sonar:stop',
    ]);
    expect(stderr).toHaveBeenCalledTimes(3);
    expect(invokedScripts.at(-1)).toBe('sonar:stop');
    stderr.mockRestore();
  });
});
