import { describe, expect, test } from 'vitest';

import {
  assertWorkflowExecutionDefaults,
  mergeWorkflowConfig,
  unset,
} from '../../src/workflows/config.js';

describe('workflow configuration inheritance', () => {
  test.each([
    ['maxAttempts', 0],
    ['timeoutMs', -1],
    ['maxAttempts', 1.5],
    ['maxAttempts', 2_147_483_648],
    ['timeoutMs', 2_147_483_648],
    ['timeoutMs', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects an out-of-range %s', (key, invalidValue) => {
    expect(() =>
      assertWorkflowExecutionDefaults(
        { maxAttempts: 3, timeoutMs: 60_000, [key]: invalidValue },
        'resolvedConfig'
      )
    ).toThrow(`resolvedConfig.${key} must be a positive PostgreSQL integer.`);
  });

  test('inherits absent values, replaces scalars and arrays, and recursively merges objects', () => {
    expect(
      mergeWorkflowConfig(
        {
          model: 'luna',
          provider: { mode: 'normal', retries: 3 },
          tags: ['default'],
          timeoutMs: 60_000,
        },
        {
          provider: { mode: 'fast' },
          tags: ['lesson'],
          timeoutMs: 90_000,
        }
      )
    ).toEqual({
      model: 'luna',
      provider: { mode: 'fast', retries: 3 },
      tags: ['lesson'],
      timeoutMs: 90_000,
    });
  });

  test('removes explicitly unset inherited properties', () => {
    expect(
      mergeWorkflowConfig(
        { model: 'luna', provider: { apiKey: 'injected', mode: 'normal' } },
        { model: unset(), provider: { apiKey: unset() } }
      )
    ).toEqual({ provider: { mode: 'normal' } });
  });

  test('reads only own properties while inheriting configuration', () => {
    const inheritedOverride = Object.create({ model: 'prototype-model' }) as Record<
      string,
      unknown
    >;

    expect(mergeWorkflowConfig({ model: 'default-model' }, inheritedOverride)).toEqual({
      model: 'default-model',
    });
    expect(
      mergeWorkflowConfig({ constructor: 'base-constructor', toString: 'base-to-string' }, {})
    ).toEqual({ constructor: 'base-constructor', toString: 'base-to-string' });
  });

  test('preserves prototype-named keys without changing the result prototype', () => {
    const prototypeNamedOverride = JSON.parse('{"__proto__":{"injected":true}}') as Record<
      string,
      unknown
    >;

    const merged = mergeWorkflowConfig({}, prototypeNamedOverride);

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, '__proto__')).toBe(true);
    expect(merged.__proto__).toEqual({ injected: true });
    expect(merged.injected).toBeUndefined();
  });
});
