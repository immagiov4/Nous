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

// The SQL fake implements atomic conflict insertion; real PostgreSQL is checked separately.
let activeTransactions = 0;
const execute = async (parts: TemplateStringsArray, ...values: unknown[]) => {
  const query = parts.join('?');
  const key = JSON.stringify(values.slice(0, 2));
  if (query.startsWith('select narration'))
    return state.stored.has(key) ? [{ narration: state.stored.get(key) }] : [];
  if (query.startsWith('insert into') && !state.stored.has(key)) state.stored.set(key, values[2]);
  return [];
};
const sql = Object.assign(execute, {
  json: (value: unknown) => value,
  begin: async (operation: (transaction: unknown) => Promise<unknown>) => {
    activeTransactions += 1;
    try {
      return await operation(sql);
    } finally {
      activeTransactions -= 1;
    }
  },
  end: state.close,
}) as unknown as Sql;

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

test('prepares without an open transaction and shares an in-process cold request', async () => {
  const cache = createSpeechPreparationCache(sql);
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const prepare = vi.fn(async () => {
    expect(activeTransactions).toBe(0);
    await pending;
    return 'pi';
  });
  const first = cache.resolve('one', 'cold', parse, prepare);
  const second = cache.resolve('one', 'cold', parse, prepare);
  release();
  expect(await Promise.all([first, second])).toEqual(['pi', 'pi']);
  expect(prepare).toHaveBeenCalledOnce();
});

test('independent workers return the stored winner of concurrent cold preparations', async () => {
  const first = createSpeechPreparationCache(sql);
  const second = createSpeechPreparationCache(sql);
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const resolveFirst = first.resolve('one', 'race', parse, async () => {
    await pending;
    return 'first';
  });
  const winner = await second.resolve('one', 'race', parse, async () => 'second');
  release();
  expect(await resolveFirst).toBe(winner);
  expect(winner).toBe('second');
});

test('a failed first consumer does not cancel a queued consumer with its own preparation', async () => {
  const cache = createSpeechPreparationCache(sql);
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const first = cache.resolve('one', 'cancelled-first', parse, async () => {
    await pending;
    throw new Error('First consumer cancelled');
  });
  const rejected = expect(first).rejects.toThrow('First consumer cancelled');
  const second = cache.resolve(
    'one',
    'cancelled-first',
    parse,
    async () => 'second remains active'
  );
  release();
  await rejected;
  expect(await second).toBe('second remains active');
});
