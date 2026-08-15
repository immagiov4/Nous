import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { hasReactHooksLintFailures, resolveEslintReportPath } from './run-eslint-react-hooks.ts';

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
});
