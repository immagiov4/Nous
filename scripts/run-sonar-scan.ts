// Runs the local Sonar scan workflow for this repository.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getProperties } from 'properties-file';

import { generateReactHooksLintReport, resolveEslintReportPath } from './run-eslint-react-hooks.ts';
import { LOCAL_SONAR_HOST_URL } from './sonar-local.ts';

const resolveScannerExecutable = () =>
  process.platform === 'win32'
    ? path.resolve('node_modules/.bin/sonar-scanner.exe')
    : path.resolve('node_modules/.bin/sonar-scanner');

// The npm scanner reads only root sonar-project.properties; pass the relocated settings explicitly.
export const createLocalScannerArguments = (
  settings: string,
  eslintReportPath: string
): string[] => [
  resolveScannerExecutable(),
  ...Object.entries(getProperties(settings)).map(([key, value]) => `-D${key}=${value}`),
  `-Dsonar.host.url=${LOCAL_SONAR_HOST_URL}`,
  `-Dsonar.eslint.reportPaths=${eslintReportPath}`,
];

export const createAnonymousScannerEnvironment = (environment: NodeJS.ProcessEnv) => {
  const scannerEnvironment = { ...environment };
  delete scannerEnvironment.SONAR_TOKEN;
  return scannerEnvironment;
};

const runCommand = async (command: string[]) => {
  const processHandle = Bun.spawn(command, {
    cwd: process.cwd(),
    env: createAnonymousScannerEnvironment(process.env),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  return processHandle.exited;
};

export const main = async (): Promise<number> => {
  const eslintReportPath = resolveEslintReportPath();
  const preparedByFullGate = Boolean(process.env.SONAR_ESLINT_REPORT_PATH);
  if (!preparedByFullGate || !existsSync(eslintReportPath)) {
    await generateReactHooksLintReport(eslintReportPath);
  }

  const settings = await readFile('config/sonar-project.properties', 'utf8');
  return runCommand(createLocalScannerArguments(settings, eslintReportPath));
};

if (import.meta.main) process.exitCode = await main();
