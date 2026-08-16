import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SONAR_COMPOSE_PATH = 'docker-compose.sonarqube.yml';
const LEGACY_SONAR_SETTINGS_PATH = path.resolve('sonar.local.properties');
const SONAR_PERMISSION_PROVISIONER_SERVICE = 'sonar-permissions';

type SonarProvisioningCredentials = {
  login: string;
  password: string;
};

export const parseLegacySonarProvisioningCredentials = (
  settings: string
): SonarProvisioningCredentials | undefined => {
  const values = new Map(
    settings
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'))
      .flatMap(line => {
        const separatorIndex = line.indexOf('=');
        return separatorIndex === -1
          ? []
          : [
              [
                line.slice(0, separatorIndex).trim(),
                line.slice(separatorIndex + 1).trim(),
              ] as const,
            ];
      })
  );
  const login = values.get('sonar.admin.login');
  const password = values.get('sonar.admin.password');
  return login && password ? { login, password } : undefined;
};

export const resolveSonarProvisioningEnvironment = (
  environment: Record<string, string | undefined>,
  legacySettings?: string
) => {
  const credentials = legacySettings
    ? parseLegacySonarProvisioningCredentials(legacySettings)
    : undefined;
  return credentials
    ? {
        ...environment,
        SONAR_PROVISIONING_ADMIN_LOGIN: credentials.login,
        SONAR_PROVISIONING_ADMIN_PASSWORD: credentials.password,
      }
    : environment;
};

const readLegacySonarSettings = () =>
  existsSync(LEGACY_SONAR_SETTINGS_PATH)
    ? readFileSync(LEGACY_SONAR_SETTINGS_PATH, 'utf8')
    : undefined;

type SonarCommandRunner = (command: string[], environment: NodeJS.ProcessEnv) => Promise<number>;

const runSonarCommand: SonarCommandRunner = async (command, environment) => {
  const processHandle = Bun.spawn(command, {
    cwd: process.cwd(),
    env: environment,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return processHandle.exited;
};

export const reconcileSonarStack = async (
  environment: NodeJS.ProcessEnv = process.env,
  legacySettings = readLegacySonarSettings(),
  runCommand: SonarCommandRunner = runSonarCommand
) => {
  const provisioningEnvironment = resolveSonarProvisioningEnvironment(environment, legacySettings);
  const composeCommand = ['docker', 'compose', '-f', SONAR_COMPOSE_PATH];
  const startupExitCode = await runCommand(
    [...composeCommand, 'up', '-d'],
    provisioningEnvironment
  );
  if (startupExitCode !== 0) return startupExitCode;

  return runCommand(
    [...composeCommand, 'wait', SONAR_PERMISSION_PROVISIONER_SERVICE],
    provisioningEnvironment
  );
};

const main = async () => {
  process.exitCode = await reconcileSonarStack();
};

if (import.meta.main) await main();
