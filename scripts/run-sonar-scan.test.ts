import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createAnonymousScannerEnvironment,
  createLocalScannerArguments,
  main,
} from './run-sonar-scan.ts';

describe('createAnonymousScannerEnvironment', () => {
  test('removes an inherited Sonar token without changing other environment values', () => {
    expect(
      createAnonymousScannerEnvironment({
        PATH: 'test-path',
        SONAR_TOKEN: 'other-sonar-token',
      })
    ).toEqual({ PATH: 'test-path' });
  });
});

describe('relocated Sonar settings', () => {
  test('passes analysis scope, coverage and quality gate settings to the local scanner', async () => {
    const settings = await readFile('config/sonar-project.properties', 'utf8');
    const args = createLocalScannerArguments(settings, '.temp/report.json');
    expect(args).toEqual(
      expect.arrayContaining([
        '-Dsonar.projectKey=lumina-reader',
        '-Dsonar.sources=apps/web,apps/backend,packages,scripts,e2e',
        '-Dsonar.javascript.lcov.reportPaths=coverage/lcov.info',
        '-Dsonar.qualitygate.wait=true',
      ])
    );
    expect(args.slice(-2)).toEqual([
      '-Dsonar.host.url=http://127.0.0.1:9000',
      '-Dsonar.eslint.reportPaths=.temp/report.json',
    ]);
  });

  test('parses Java properties and keeps local connection overrides last', () => {
    const args = createLocalScannerArguments(
      '# Synthetic settings\nsonar.projectName=Test\\ Reader\nsonar.host.url=https://example.test\n',
      'report.json'
    );
    expect(args).toContain('-Dsonar.projectName=Test Reader');
    expect(args.at(-2)).toBe('-Dsonar.host.url=http://127.0.0.1:9000');
  });
});

describe('local Sonar command entry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test.each([0, 7])('loads relocated settings and returns scanner status %s', async code => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nous-sonar-entry-'));
    try {
      const reportPath = path.join(directory, 'eslint-report.json');
      await writeFile(reportPath, '[]');
      vi.stubEnv('SONAR_ESLINT_REPORT_PATH', reportPath);
      vi.stubEnv('SONAR_TOKEN', 'synthetic-inherited-token');
      const spawn = vi.fn().mockReturnValue({ exited: Promise.resolve(code) });
      vi.stubGlobal('Bun', { spawn });
      expect(await main()).toBe(code);
      const [command, options] = spawn.mock.calls[0];
      expect(command).toEqual(
        await createLocalScannerArguments(
          await readFile('config/sonar-project.properties', 'utf8'),
          reportPath
        )
      );
      expect(options.env.SONAR_TOKEN).toBeUndefined();
      expect(process.env.SONAR_TOKEN).toBe('synthetic-inherited-token');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
