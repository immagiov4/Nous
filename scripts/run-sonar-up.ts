import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SONAR_COMPOSE_PATH = 'docker-compose.sonarqube.yml';
const LEGACY_SONAR_SETTINGS_PATH = path.resolve('sonar.local.properties');

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

const main = async () => {
  const processHandle = Bun.spawn(['docker', 'compose', '-f', SONAR_COMPOSE_PATH, 'up', '-d'], {
    cwd: process.cwd(),
    env: resolveSonarProvisioningEnvironment(process.env, readLegacySonarSettings()),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(await processHandle.exited);
};

if (import.meta.main) await main();
