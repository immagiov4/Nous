import { describe, expect, test, vi } from 'vitest';

import {
  parseLegacySonarProvisioningCredentials,
  reconcileSonarStack,
  resolveSonarProvisioningEnvironment,
} from './run-sonar-up.ts';

describe('parseLegacySonarProvisioningCredentials', () => {
  test('reads a complete legacy administrator credential pair', () => {
    expect(
      parseLegacySonarProvisioningCredentials(
        'sonar.admin.login=local-admin\nsonar.admin.password=local-password\nsonar.token=unused'
      )
    ).toEqual({ login: 'local-admin', password: 'local-password' });
  });

  test('does not treat a partial legacy setting as credentials', () => {
    expect(
      parseLegacySonarProvisioningCredentials('sonar.admin.login=local-admin')
    ).toBeUndefined();
  });
});

describe('resolveSonarProvisioningEnvironment', () => {
  test('uses legacy credentials only for the internal provisioner', () => {
    expect(
      resolveSonarProvisioningEnvironment(
        { PATH: 'test-path' },
        'sonar.admin.login=local-admin\nsonar.admin.password=local-password\nsonar.token=unused'
      )
    ).toEqual({
      PATH: 'test-path',
      SONAR_PROVISIONING_ADMIN_LOGIN: 'local-admin',
      SONAR_PROVISIONING_ADMIN_PASSWORD: 'local-password',
    });
  });
});

describe('reconcileSonarStack', () => {
  test('waits for anonymous permission provisioning after startup', async () => {
    const runCommand = vi.fn().mockResolvedValue(0);

    await expect(reconcileSonarStack({ PATH: 'test-path' }, undefined, runCommand)).resolves.toBe(
      0
    );

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['docker', 'compose', '-f', 'docker-compose.sonarqube.yml', 'up', '-d'],
      { PATH: 'test-path' }
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      ['docker', 'compose', '-f', 'docker-compose.sonarqube.yml', 'wait', 'sonar-permissions'],
      { PATH: 'test-path' }
    );
  });

  test('does not wait when Compose startup fails', async () => {
    const runCommand = vi.fn().mockResolvedValue(1);

    await expect(reconcileSonarStack({ PATH: 'test-path' }, undefined, runCommand)).resolves.toBe(
      1
    );

    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  test('propagates a failed anonymous permission provisioner exit code', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(reconcileSonarStack({ PATH: 'test-path' }, undefined, runCommand)).resolves.toBe(
      1
    );
  });
});
