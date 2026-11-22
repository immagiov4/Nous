import postgres from 'postgres';

const julyVersion = '20260728120000';
const augustVersion = '20260808194000';

async function repairMigrationHistory(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [history] = await sql<Array<{ exists: boolean }>>`
      select to_regclass('supabase_migrations.schema_migrations') is not null as exists
    `;
    if (!history?.exists) return;

    // These releases shipped the same SQL under two versions. Reuse the applied entry.
    const repaired = await sql`
      insert into supabase_migrations.schema_migrations (version, name, statements)
      select ${julyVersion}, name, statements
      from supabase_migrations.schema_migrations
      where version = ${augustVersion}
      on conflict (version) do nothing
      returning version
    `;
    if (repaired.length) {
      console.log(
        `Recorded migration ${julyVersion} as applied using equivalent version ${augustVersion}.`
      );
    }
  } finally {
    await sql.end();
  }
}

export async function runMigrationRepair(databaseUrl: string | undefined): Promise<number> {
  if (!databaseUrl) {
    console.error('DATABASE_URL is required to repair migration history.');
    return 1;
  }
  try {
    await repairMigrationHistory(databaseUrl);
    return 0;
  } catch {
    // Connection errors can include the original URL and its password.
    console.error(
      'Could not repair migration history. Check DATABASE_URL and migration history permissions.'
    );
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runMigrationRepair(process.env.DATABASE_URL);
