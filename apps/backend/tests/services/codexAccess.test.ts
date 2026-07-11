import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  assertCodexRequestAccess,
  CodexAccessError,
  isLoopbackAddress,
} from '../../src/services/codexAccess.js';

const ORIGINAL_ENV = { ...process.env };

const requestFor = (userId: string, remoteAddress: string): Request =>
  ({
    currentUser: { id: userId },
    hostname: 'localhost',
    socket: { remoteAddress },
  }) as unknown as Request;

describe('Codex local owner boundary', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      CODEX_APP_SERVER_ENABLED: 'true',
      CODEX_OWNER_USER_ID: 'owner-user',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('accepts only the configured owner over the actual loopback socket', () => {
    expect(() =>
      assertCodexRequestAccess(requestFor('owner-user', '::ffff:127.0.0.1'))
    ).not.toThrow();
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('127.12.0.4')).toBe(true);
  });

  test('rejects remote clients, other users, disabled mode, and missing owner configuration', () => {
    expect(() => assertCodexRequestAccess(requestFor('owner-user', '192.168.1.20'))).toThrow(
      CodexAccessError
    );
    expect(() => assertCodexRequestAccess(requestFor('other-user', '127.0.0.1'))).toThrow(
      CodexAccessError
    );
    const publicHostRequest = requestFor('owner-user', '127.0.0.1');
    Object.defineProperty(publicHostRequest, 'hostname', { value: 'nous.example.com' });
    expect(() => assertCodexRequestAccess(publicHostRequest)).toThrow(CodexAccessError);

    process.env.CODEX_APP_SERVER_ENABLED = 'false';
    expect(() => assertCodexRequestAccess(requestFor('owner-user', '127.0.0.1'))).toThrow(
      CodexAccessError
    );

    process.env.CODEX_APP_SERVER_ENABLED = 'true';
    delete process.env.CODEX_OWNER_USER_ID;
    expect(() => assertCodexRequestAccess(requestFor('owner-user', '127.0.0.1'))).toThrow(
      CodexAccessError
    );
  });
});
