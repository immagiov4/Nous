import { describe, expect, test } from 'vitest';

import {
  CHECK_GATE_STAGES,
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

    await executeFullQualityGate(async stage => {
      invokedScripts.push(stage.script);
      return passedResult(stage);
    });

    expect(invokedScripts).toEqual([
      ...CHECK_GATE_STAGES.map(stage => stage.script),
      'test:coverage',
      'sonar:up',
      'sonar:scan',
      'sonar:stop',
    ]);
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

  test.each(['sonar:up', 'sonar:scan'])('stops Sonar when %s throws', async failedScript => {
    const invokedScripts: string[] = [];

    await expect(
      executeFullQualityGate(async stage => {
        invokedScripts.push(stage.script);
        if (stage.script === failedScript) throw new Error('Sonar command crashed');
        return passedResult(stage);
      })
    ).rejects.toThrow('Sonar command crashed');

    expect(invokedScripts.at(-1)).toBe('sonar:stop');
  });
});
