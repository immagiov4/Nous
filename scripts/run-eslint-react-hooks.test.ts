import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, test, vi } from 'vitest';

import { resolveEslintCachePath } from './eslint-cache.ts';
import {
  generateReactHooksLintReport,
  hasReactHooksLintFailures,
  resolveEslintReportPath,
} from './run-eslint-react-hooks.ts';

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
    const sourceDirectory = await mkdtemp(path.resolve('apps/web/tests/eslint-cache-'));
    const reportDirectory = await mkdtemp(path.join(tmpdir(), 'nous-eslint-report-'));
    const sourcePath = path.join(sourceDirectory, 'Component.tsx');
    const reportPath = path.join(reportDirectory, 'eslint-report.json');
    const lintFiles = ESLint.prototype.lintFiles;
    const lintSpy = vi.spyOn(ESLint.prototype, 'lintFiles').mockImplementation(function (
      this: ESLint
    ) {
      return lintFiles.call(this, [sourcePath]);
    });
    const outputSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await writeFile(
        sourcePath,
        "import { useEffect } from 'react';\nexport function Component({ enabled }) { if (enabled) useEffect(() => {}, []); return null; }"
      );
      const coldResults = await generateReactHooksLintReport(reportPath);
      expect(hasReactHooksLintFailures(coldResults)).toBe(true);
      expect(coldResults[0].messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'react-hooks/rules-of-hooks' })])
      );
      const cachedEntries = await readFile(await resolveEslintCachePath('react-hooks'), 'utf8');
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
      lintSpy.mockRestore();
      outputSpy.mockRestore();
      await rm(sourceDirectory, { recursive: true, force: true });
      await rm(reportDirectory, { recursive: true, force: true });
    }
  });
});
