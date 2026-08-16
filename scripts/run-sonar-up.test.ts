import { describe, expect, test } from 'vitest';

import {
  parseLegacySonarProvisioningCredentials,
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
