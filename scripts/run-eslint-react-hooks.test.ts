import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ESLint } from 'eslint';
import { describe, expect, test, vi } from 'vitest';

import { resolveEslintCachePath } from './eslint-cache.ts';
import {
  generateReactHooksLintReport,
  hasReactHooksLintFailures,
  resolveEslintReportPath,
} from './run-eslint-react-hooks.ts';

const fixture = vi.hoisted(() => ({ directory: '' }));

vi.mock('eslint', async importOriginal => {
  const actual = await importOriginal<typeof import('eslint')>();
  return {
    ...actual,
    ESLint: class extends actual.ESLint {
      constructor(options: ESLint.Options) {
        assert(options.cacheLocation);
        super({
          ...options,
          cwd: fixture.directory,
          cacheLocation: path.join(fixture.directory, path.basename(options.cacheLocation)),
        });
      }
    },
  };
});

describe('React Hooks ESLint report', () => {
  test('preserves the zero-warning gate contract', () => {
    expect(hasReactHooksLintFailures([{ errorCount: 0, warningCount: 0 }])).toBe(false);
    expect(hasReactHooksLintFailures([{ errorCount: 0, warningCount: 1 }])).toBe(true);
    expect(hasReactHooksLintFailures([{ errorCount: 1, warningCount: 0 }])).toBe(true);
  });

  test('uses the full-gate report path when provided', () => {
    const reportPath = resolveEslintReportPath({
      SONAR_ESLINT_REPORT_PATH: '.temp/sonar/eslint-report-gate.json',
    });

    expect(reportPath).toBe(path.resolve('.temp/sonar/eslint-report-gate.json'));
  });

  test('writes cached diagnostics and invalidates them when a source file changes', async () => {
    fixture.directory = await mkdtemp(path.join(tmpdir(), 'nous-react-hooks-'));
    const sourceDirectory = path.join(fixture.directory, 'apps/web');
    const sourcePath = path.join(sourceDirectory, 'Component.tsx');
    const reportPath = path.join(fixture.directory, 'eslint-report.json');
    const outputSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await mkdir(sourceDirectory, { recursive: true });
      await writeFile(
        sourcePath,
        "import { useEffect } from 'react';\nexport function Component({ enabled }) { if (enabled) useEffect(() => {}, []); return null; }"
      );
      const coldResults = await generateReactHooksLintReport(reportPath);
      expect(hasReactHooksLintFailures(coldResults)).toBe(true);
      expect(coldResults[0].messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'react-hooks/rules-of-hooks' })])
      );
      const cachedEntries = await readFile(
        path.join(fixture.directory, path.basename(await resolveEslintCachePath('react-hooks'))),
        'utf8'
      );
      expect(cachedEntries).toContain(path.basename(sourcePath));
      await rm(reportPath);
      const warmResults = await generateReactHooksLintReport(reportPath);
      expect(warmResults).toEqual(coldResults);
      expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(warmResults);

      await writeFile(sourcePath, 'export function Component() { return null; }');
      const changedResults = await generateReactHooksLintReport(reportPath);
      expect(hasReactHooksLintFailures(changedResults)).toBe(false);
      expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(changedResults);
    } finally {
      outputSpy.mockRestore();

      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
