import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';

const execute = promisify(execFile);
export type ProofMigration = { version: string; name: string; sql: string; hash: string };

function migration(file: string, sql: string): ProofMigration {
  const match = /^(\d+)_(.+)\.sql$/.exec(file);
  if (!match) throw new Error(`Invalid migration filename: ${file}`);
  return {
    version: match[1],
    name: match[2],
    sql,
    hash: createHash('sha256').update(sql).digest('hex'),
  };
}

/** Freeze the remote-tracking tree once; pending SQL comes from that tree, never a mutable checkout. */
export async function proofMigrationSnapshot(root: string, signal?: AbortSignal) {
  const git = async (...args: string[]) =>
    (await execute('git', ['-C', root, ...args], { windowsHide: true, signal })).stdout;
  const revision = (await git('rev-parse', 'origin/main')).trim();
  const files = (await git('ls-tree', '--name-only', `${revision}:supabase/migrations`))
    .trim()
    .split(/\r?\n/)
    .filter(file => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
  const main: ProofMigration[] = [];
  for (const file of files)
    main.push(migration(file, await git('show', `${revision}:supabase/migrations/${file}`)));
  const local: ProofMigration[] = [];
  for (const file of (await readdir(join(root, 'supabase/migrations')))
    .filter(file => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right))) {
    local.push(migration(file, await readFile(join(root, 'supabase/migrations', file), 'utf8')));
  }
  if (
    new Set(main.map(entry => entry.version)).size !== main.length ||
    new Set(local.map(entry => entry.version)).size !== local.length
  )
    throw new Error('Duplicate migration versions.');
  return { revision, main, local };
}

export type MigrationStore = {
  applied: () => Promise<string[]>;
  apply: (migration: ProofMigration) => Promise<void>;
  close: () => Promise<void>;
};

/** Start services without application migrations, including when a retained volume is resumed. */
export async function stageSharedStartup(root: string, state: string): Promise<string> {
  const workdir = await mkdtemp(join(state, 'startup-'));
  await mkdir(join(workdir, 'supabase/migrations'), { recursive: true });
  await cp(join(root, 'supabase/config.toml'), join(workdir, 'supabase/config.toml'));
  await cp(join(root, 'supabase/templates'), join(workdir, 'supabase/templates'), {
    recursive: true,
  });
  return workdir;
}

export function checkoutTracksMain({
  main,
  local,
}: Awaited<ReturnType<typeof proofMigrationSnapshot>>): boolean {
  return (
    local.length === main.length &&
    local.every(
      (entry, index) =>
        entry.version === main[index].version &&
        entry.name === main[index].name &&
        entry.hash === main[index].hash
    )
  );
}

export function migrationStore(url: string, signal?: AbortSignal): MigrationStore {
  const sql = postgres(url, { max: 1 });
  let historyExists = false;
  async function query<T extends readonly postgres.Row[]>(
    pending: postgres.PendingQuery<T>
  ): Promise<T> {
    signal?.throwIfAborted();
    const cancel = () => pending.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await pending;
      signal?.throwIfAborted();
      return result;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  return {
    applied: async () => {
      historyExists =
        (
          await query(sql`select to_regclass('supabase_migrations.schema_migrations') as relation`)
        )[0].relation !== null;
      if (!historyExists) return [];
      return (
        await query(
          sql<
            { version: string }[]
          >`select version from supabase_migrations.schema_migrations order by version`
        )
      ).map(row => row.version);
    },
    apply: async migration => {
      await sql.begin(async transaction => {
        if (!historyExists) {
          await query(transaction`create schema if not exists supabase_migrations`);
          await query(
            transaction`create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`
          );
        }
        await query(transaction.unsafe(migration.sql).simple());
        await query(
          transaction`insert into supabase_migrations.schema_migrations (version, name, statements) values (${migration.version}, ${migration.name}, ${[migration.sql]})`
        );
      });
      historyExists = true;
    },
    close: async () => {
      await sql.end();
    },
  };
}

/** Caller holds the shared lifecycle lock for comparison, every transaction and admission. */
export async function reconcileProofMigrations(
  snapshot: Awaited<ReturnType<typeof proofMigrationSnapshot>>,
  store: MigrationStore,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const { main } = snapshot;
    if (!checkoutTracksMain(snapshot)) return false;
    const applied = await store.applied();
    if (applied.some(version => !main.some(entry => entry.version === version))) return false;
    for (const entry of main) {
      signal?.throwIfAborted();
      if (!applied.includes(entry.version)) await store.apply(entry);
    }
    signal?.throwIfAborted();
    return true;
  } finally {
    await store.close();
  }
}
