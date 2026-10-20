import { afterEach, describe, expect, test, vi } from 'vitest';
import { probePackageScripts } from '../apps/web/tests/helpers/packageScriptProbe';

import {
  executeFullQualityGate,
  type GateStage,
  type GateStageResult,
} from './run-full-quality-gate.ts';

const GATE_SCRIPTS = {
  ciChecks: 'gate:checks',
  coverage: 'test:coverage',
  sonarStart: 'sonar:up',
  sonarPreflight: 'doctor:gate',
  sonarScan: 'sonar:scan',
} as const;

const EXPECTED_GATE_SCRIPTS = Object.values(GATE_SCRIPTS);

const passedResult = (stage: GateStage): GateStageResult => ({
  ...stage,
  durationMs: 1,
  exitCode: 0,
});

afterEach(() => vi.restoreAllMocks());

describe('full quality gate runner', () => {
  test('runs one heavy stage at a time and keeps Sonar available', async () => {
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

    expect(invokedScripts).toEqual(EXPECTED_GATE_SCRIPTS);
    expect(maximumActiveStageCount).toBe(1);
  });

  test('continues through Sonar and exposes every failed stage', async () => {
    const invokedScripts: string[] = [];
    const failedScripts = new Set([GATE_SCRIPTS.ciChecks, GATE_SCRIPTS.coverage]);

    const results = await executeFullQualityGate(async stage => {
      invokedScripts.push(stage.script);
      return {
        ...passedResult(stage),
        exitCode: failedScripts.has(stage.script) ? 1 : 0,
      };
    });

    expect(invokedScripts.at(-1)).toBe(GATE_SCRIPTS.sonarScan);
    expect(results.filter(result => result.exitCode !== 0).map(result => result.script)).toEqual([
      GATE_SCRIPTS.ciChecks,
      GATE_SCRIPTS.coverage,
    ]);
  });

  test('continues after runner crashes and reports every crashed stage', async () => {
    const invokedScripts: string[] = [];
    const crashedScripts = new Set([
      GATE_SCRIPTS.ciChecks,
      GATE_SCRIPTS.sonarStart,
      GATE_SCRIPTS.sonarScan,
    ]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const results = await executeFullQualityGate(async stage => {
      invokedScripts.push(stage.script);
      if (crashedScripts.has(stage.script)) throw new Error(`${stage.script} crashed`);
      return passedResult(stage);
    });

    expect(invokedScripts).toEqual(EXPECTED_GATE_SCRIPTS);
    expect(results.filter(result => result.exitCode !== 0).map(result => result.script)).toEqual([
      GATE_SCRIPTS.ciChecks,
      GATE_SCRIPTS.sonarStart,
      GATE_SCRIPTS.sonarScan,
    ]);
    expect(stderr).toHaveBeenCalledTimes(3);
    expect(invokedScripts.at(-1)).toBe(GATE_SCRIPTS.sonarScan);
  });
});

test('rechecks readiness and scans on the next gate after a scan crashes', async () => {
  const invokedScripts: string[] = [];
  let failScan = true;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const runStage = async (stage: GateStage) => {
    invokedScripts.push(stage.script);
    if (stage.script === GATE_SCRIPTS.sonarScan && failScan) {
      failScan = false;
      throw new Error('interrupted scan');
    }
    return passedResult(stage);
  };
  const first = await executeFullQualityGate(runStage);
  const second = await executeFullQualityGate(runStage);
  expect(first.at(-1)?.exitCode).toBe(1);
  expect(second.every(result => result.exitCode === 0)).toBe(true);
  expect(invokedScripts).toEqual([...EXPECTED_GATE_SCRIPTS, ...EXPECTED_GATE_SCRIPTS]);
});

test('runs the CI checks and complete suite once, producing coverage for Sonar', async () => {
  const localAnalysisScripts: readonly string[] = [
    GATE_SCRIPTS.sonarStart,
    GATE_SCRIPTS.sonarPreflight,
    GATE_SCRIPTS.sonarScan,
  ];
  const invokedScripts: string[] = [];

  await executeFullQualityGate(async stage => {
    invokedScripts.push(stage.script);
    return passedResult(stage);
  });

  const invokedCommands = await probePackageScripts(
    invokedScripts.filter(script => !localAnalysisScripts.includes(script))
  );
  expect(invokedCommands).toEqual(['quality:ci', 'check:fallow:ci', 'test:coverage']);
  expect(await probePackageScripts(['gate:ci'])).toEqual(invokedCommands);
});
