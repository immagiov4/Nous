// Runs the local Sonar scan workflow for this repository.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { generateReactHooksLintReport, resolveEslintReportPath } from './run-eslint-react-hooks.ts';
import { LOCAL_SONAR_HOST_URL } from './sonar-local.ts';

const resolveScannerExecutable = () =>
  process.platform === 'win32'
    ? path.resolve('node_modules/.bin/sonar-scanner.exe')
    : path.resolve('node_modules/.bin/sonar-scanner');

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

const main = async () => {
  const eslintReportPath = resolveEslintReportPath();
  const preparedByFullGate = Boolean(process.env.SONAR_ESLINT_REPORT_PATH);
  if (!preparedByFullGate || !existsSync(eslintReportPath)) {
    await generateReactHooksLintReport(eslintReportPath);
  }

  const scannerExecutable = resolveScannerExecutable();
  const exitCode = await runCommand([
    scannerExecutable,
    `-Dsonar.host.url=${LOCAL_SONAR_HOST_URL}`,
    `-Dsonar.eslint.reportPaths=${eslintReportPath}`,
  ]);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
};

if (import.meta.main) await main();
