import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { assertCodexRequestAccess, CodexAccessError } from '../../src/services/codexAccess.js';

const ORIGINAL_ENV = { ...process.env };

const requestFor = (
  userId: string,
  remoteAddress: string,
  aiProvider?: 'codex' | 'openai' | 'openrouter',
  role?: string
): Request =>
  ({
    currentUser: { id: userId, aiProvider, role },
    hostname: 'localhost',
    socket: { remoteAddress },
  }) as unknown as Request;

describe('Codex local access boundary', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      CODEX_APP_SERVER_ENABLED: 'true',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('accepts Codex-assigned users and administrators locally or through a remote Nous host', () => {
    expect(() =>
      assertCodexRequestAccess(requestFor('codex-user', '::ffff:127.0.0.1', 'codex'))
    ).not.toThrow();
    expect(() =>
      assertCodexRequestAccess(requestFor('admin-user', '127.0.0.1', 'openrouter', 'admin'))
    ).not.toThrow();
    const remoteRequest = requestFor('codex-user', '203.0.113.20', 'codex');
    Object.defineProperty(remoteRequest, 'hostname', { value: 'nous.example.com' });
    expect(() => assertCodexRequestAccess(remoteRequest)).not.toThrow();
  });

  test('rejects users not assigned to Codex and disabled mode', () => {
    expect(() =>
      assertCodexRequestAccess(requestFor('other-user', '127.0.0.1', 'openrouter'))
    ).toThrow(CodexAccessError);
    process.env.CODEX_APP_SERVER_ENABLED = 'false';
    expect(() => assertCodexRequestAccess(requestFor('codex-user', '127.0.0.1', 'codex'))).toThrow(
      CodexAccessError
    );
  });
});
