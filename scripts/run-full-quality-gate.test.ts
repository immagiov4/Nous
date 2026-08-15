import { describe, expect, test } from 'vitest';

import {
  executeFullQualityGate,
  type GateStage,
  type GateStageResult,
  INDEPENDENT_GATE_STAGES,
} from './run-full-quality-gate.ts';

const passedResult = (stage: GateStage): GateStageResult => ({
  ...stage,
  durationMs: 1,
  exitCode: 0,
});

describe('full quality gate runner', () => {
  test('runs independent checks together, then coverage before Sonar', async () => {
    const events: string[] = [];
    let releaseIndependentStages: () => void = () => undefined;
    const independentStagesStarted = new Promise<void>(resolve => {
      releaseIndependentStages = resolve;
    });
    let independentStartCount = 0;

    const runStage = async (stage: GateStage): Promise<GateStageResult> => {
      events.push(`start:${stage.script}`);
      if (INDEPENDENT_GATE_STAGES.some(candidate => candidate.script === stage.script)) {
        independentStartCount += 1;
        if (independentStartCount === INDEPENDENT_GATE_STAGES.length) {
          releaseIndependentStages();
        }
        await independentStagesStarted;
      }
      events.push(`end:${stage.script}`);
      return passedResult(stage);
    };

    await executeFullQualityGate(runStage);

    const coverageStart = events.indexOf('start:test:coverage');
    const sonarStart = events.indexOf('start:sonar:scan');
    expect(coverageStart).toBeGreaterThan(
      Math.max(...INDEPENDENT_GATE_STAGES.map(stage => events.indexOf(`end:${stage.script}`)))
    );
    expect(sonarStart).toBeGreaterThan(events.indexOf('end:test:coverage'));
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

    expect(invokedScripts.at(-1)).toBe('sonar:scan');
    expect(results.filter(result => result.exitCode !== 0).map(result => result.script)).toEqual([
      'quality',
      'test:coverage',
    ]);
  });
});
