import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { type ProofMigration, reconcileProofMigrations } from '../../../scripts/proof-migrations';

function entry(version: string, sql = `create table proof_${version} (id int);`): ProofMigration {
  return {
    version,
    name: `proof_${version}`,
    sql,
    hash: createHash('sha256').update(sql).digest('hex'),
  };
}
function database(applied: string[]) {
  return {
    applied: vi.fn(async () => [...applied]),
    apply: vi.fn(async (migration: ProofMigration) => {
      applied.push(migration.version);
    }),
    close: vi.fn(async () => {}),
  };
}
it('applies missing main migrations in order and once, retaining existing history', async () => {
  const main = [entry('1'), entry('2'), entry('3')];
  const applied = ['1'];
  const store = database(applied);
  const snapshot = { revision: 'main', main, local: main };
  expect(await reconcileProofMigrations(snapshot, store)).toBe(true);
  expect(applied).toEqual(['1', '2', '3']);
  expect(store.apply.mock.calls.map(([migration]) => migration.sql)).toEqual([
    main[1].sql,
    main[2].sql,
  ]);
  expect(await reconcileProofMigrations(snapshot, store)).toBe(true);
  expect(store.apply).toHaveBeenCalledTimes(2);
});
it.each([
  'extra',
  'changed',
  'older',
  'renamed',
])('isolates a %s checkout before any shared mutation', async kind => {
  const main = [entry('1')];
  const local =
    kind === 'extra'
      ? [...main, entry('2')]
      : kind === 'older'
        ? []
        : kind === 'renamed'
          ? [{ ...main[0], name: 'other' }]
          : [entry('1', 'drop table important;')];
  const store = database([]);
  expect(await reconcileProofMigrations({ revision: 'main', main, local }, store)).toBe(false);
  expect(store.applied).not.toHaveBeenCalled();
  expect(store.apply).not.toHaveBeenCalled();
  expect(store.close).toHaveBeenCalledOnce();
});
it('isolates when the shared database contains a version outside main', async () => {
  const main = [entry('1')];
  const store = database(['unpublished']);
  expect(await reconcileProofMigrations({ revision: 'main', main, local: main }, store)).toBe(
    false
  );
  expect(store.apply).not.toHaveBeenCalled();
});
it('propagates a failed migration, stops before the next one and closes the connection', async () => {
  const main = [entry('1'), entry('2')];
  const store = database([]);
  store.apply.mockRejectedValueOnce(new Error('migration failed'));
  await expect(
    reconcileProofMigrations({ revision: 'main', main, local: main }, store)
  ).rejects.toThrow('migration failed');
  expect(store.apply).toHaveBeenCalledOnce();
  expect(store.close).toHaveBeenCalledOnce();
});
it('cancels before a pending migration', async () => {
  const main = [entry('1')];
  const store = database([]);
  await expect(
    reconcileProofMigrations(
      { revision: 'main', main, local: main },
      store,
      AbortSignal.abort(new Error('cancelled'))
    )
  ).rejects.toThrow('cancelled');
  expect(store.apply).not.toHaveBeenCalled();
  expect(store.close).toHaveBeenCalledOnce();
});
