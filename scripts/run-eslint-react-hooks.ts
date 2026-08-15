import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ESLint } from 'eslint';

const DEFAULT_ESLINT_REPORT_PATH = path.resolve('.temp/sonar/eslint-report.json');

export const resolveEslintReportPath = (
  environment: Record<string, string | undefined> = process.env
): string => path.resolve(environment.SONAR_ESLINT_REPORT_PATH ?? DEFAULT_ESLINT_REPORT_PATH);

export const hasReactHooksLintFailures = (
  results: ReadonlyArray<Pick<ESLint.LintResult, 'errorCount' | 'warningCount'>>
): boolean => results.some(result => result.errorCount > 0 || result.warningCount > 0);

export const generateReactHooksLintReport = async (
  reportPath = resolveEslintReportPath()
): Promise<ESLint.LintResult[]> => {
  const eslint = new ESLint({ overrideConfigFile: path.resolve('eslint.config.mjs') });
  const results = await eslint.lintFiles(['apps/web']);
  const formatter = await eslint.loadFormatter('stylish');
  const formattedResults = formatter.format(results);

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(results));
  if (formattedResults) process.stdout.write(formattedResults);

  return results;
};

if (import.meta.main) {
  const results = await generateReactHooksLintReport();
  if (hasReactHooksLintFailures(results)) process.exitCode = 1;
}
