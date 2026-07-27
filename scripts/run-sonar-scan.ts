// Runs the local Sonar scan workflow for this repository.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LOCAL_SETTINGS_PATH = path.resolve('sonar.local.properties');
const ESLINT_REPORT_PATH = path.resolve('.temp/sonar/eslint-report.json');

type LocalSettings = Record<string, string>;

const parsePropertiesFile = (filePath: string): LocalSettings => {
  if (!existsSync(filePath)) {
    return {};
  }

  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .reduce<LocalSettings>((settings, line) => {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1) {
        return settings;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      settings[key] = value;
      return settings;
    }, {});
};

const resolveScannerExecutable = () =>
  process.platform === 'win32'
    ? path.resolve('node_modules/.bin/sonar-scanner.exe')
    : path.resolve('node_modules/.bin/sonar-scanner');

const runCommand = async (command: string[]) => {
  const processHandle = Bun.spawn(command, {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  return processHandle.exited;
};

const exportEslintReport = async () => {
  mkdirSync(path.dirname(ESLINT_REPORT_PATH), { recursive: true });

  const eslintExitCode = await runCommand([
    process.execPath,
    path.resolve('node_modules/eslint/bin/eslint.js'),
    'apps/web',
    '--config',
    'eslint.config.mjs',
    '--format',
    'json',
    '--output-file',
    ESLINT_REPORT_PATH,
  ]);

  if (eslintExitCode > 1) {
    process.exit(eslintExitCode);
  }
};

const main = async () => {
  const settings = parsePropertiesFile(LOCAL_SETTINGS_PATH);
  const sonarHostUrl = settings['sonar.host.url']?.trim();
  const sonarToken = settings['sonar.token']?.trim();

  if (!sonarHostUrl || !sonarToken) {
    throw new Error(
      `Missing Sonar local settings in ${LOCAL_SETTINGS_PATH}. Run "bun run sonar:bootstrap" first.`
    );
  }

  await exportEslintReport();

  const scannerExecutable = resolveScannerExecutable();
  const exitCode = await runCommand([
    scannerExecutable,
    `-Dsonar.host.url=${sonarHostUrl}`,
    `-Dsonar.token=${sonarToken}`,
    `-Dsonar.eslint.reportPaths=${ESLINT_REPORT_PATH}`,
  ]);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
};

await main();
