import type { Sql } from 'postgres';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  close: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('postgres', () => ({ default: state.connect }));

import {
  closeSpeechPreparationCache,
  createSpeechPreparationCache,
  speechPreparationCache,
} from '../../src/services/speechPreparationCache.js';

// Exercise the cache through the SQL transaction interface; the real PostgreSQL concurrency
// and rollback contract is also exercised by the configured-provider headless proof.
const sql = {
  begin: async (operation: (transaction: unknown) => Promise<unknown>) => {
    const pending = new Map(state.stored);
    const transaction = Object.assign(
      async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const query = parts.join('?');
        if (query.startsWith('select narration')) {
          const key = JSON.stringify(values);
          return pending.has(key) ? [{ narration: pending.get(key) }] : [];
        }
        if (query.startsWith('insert into'))
          pending.set(JSON.stringify(values.slice(0, 2)), values[2]);
        return [];
      },
      { json: (value: unknown) => value }
    );
    const result = await operation(transaction);
    state.stored = pending;
    return result;
  },
  end: state.close,
} as unknown as Sql;

beforeEach(() => {
  state.stored.clear();
  state.connect.mockReset().mockReturnValue(sql);
  state.close.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await closeSpeechPreparationCache();
  vi.unstubAllEnvs();
});

const parse = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('Invalid stored narration');
  return value;
};

test('reuses a validated result for its owner and content, but not another owner or source', async () => {
  const cache = createSpeechPreparationCache(sql);
  const prepare = vi.fn().mockResolvedValue('pi di a');
  expect(await cache.resolve('one', 'paragraph', parse, prepare)).toBe('pi di a');
  expect(await cache.resolve('one', 'paragraph', parse, prepare)).toBe('pi di a');
  expect(prepare).toHaveBeenCalledOnce();
  await cache.resolve('two', 'paragraph', parse, prepare);
  await cache.resolve('one', 'changed-paragraph', parse, prepare);
  expect(prepare).toHaveBeenCalledTimes(3);
});

test('rolls back failed preparation and rejects corrupt stored narration', async () => {
  const cache = createSpeechPreparationCache(sql);
  await expect(
    cache.resolve('one', 'paragraph', parse, async () => {
      throw new Error('Provider failed');
    })
  ).rejects.toThrow('Provider failed');
  expect(state.stored.size).toBe(0);
  state.stored.set(JSON.stringify(['one', 'paragraph']), null);
  const prepare = vi.fn();
  await expect(cache.resolve('one', 'paragraph', parse, prepare)).rejects.toThrow(
    'Invalid stored narration'
  );
  expect(prepare).not.toHaveBeenCalled();
});

test('requires database configuration, reuses its connection and closes it explicitly', async () => {
  vi.stubEnv('DATABASE_URL', '');
  expect(() => speechPreparationCache.resolve('one', 'paragraph', parse, async () => 'pi')).toThrow(
    'DATABASE_URL'
  );
  vi.stubEnv('DATABASE_URL', 'postgres://speech-test.invalid/database');
  expect(await speechPreparationCache.resolve('one', 'paragraph', parse, async () => 'pi')).toBe(
    'pi'
  );
  expect(await speechPreparationCache.resolve('one', 'paragraph', parse, async () => 'wrong')).toBe(
    'pi'
  );
  expect(state.connect).toHaveBeenCalledOnce();
  await closeSpeechPreparationCache();
  expect(state.close).toHaveBeenCalledOnce();
});
