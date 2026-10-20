import postgres, { type Sql } from 'postgres';

/** Serialized, owner-scoped reuse of paid narration, shared by every speech consumer. */
export const createSpeechPreparationCache = (sql: Sql) => ({
  async resolve<T>(
    owner: string,
    key: string,
    parse: (value: unknown) => T,
    prepare: () => Promise<T>
  ): Promise<T> {
    return sql.begin(async transaction => {
      // The transaction lock deduplicates the same content across HTTP requests and workflow workers.
      await transaction`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([owner, key])}, 0))`;
      const rows =
        await transaction`select narration from public.speech_preparations where owner_id = ${owner} and cache_key = ${key}`;
      if (rows.length) return parse(rows[0].narration);
      const narration = await prepare();
      await transaction`insert into public.speech_preparations (owner_id, cache_key, narration) values (${owner}, ${key}, ${transaction.json(JSON.parse(JSON.stringify(narration)))})`;
      return narration;
    }) as Promise<T>;
  },
});

let sql: Sql | undefined;
export const speechPreparationCache = {
  resolve<T>(
    owner: string,
    key: string,
    parse: (value: unknown) => T,
    prepare: () => Promise<T>
  ): Promise<T> {
    if (!sql) {
      const databaseUrl = process.env.DATABASE_URL?.trim();
      if (!databaseUrl) throw new Error('DATABASE_URL is required for speech preparation.');
      sql = postgres(databaseUrl);
    }
    return createSpeechPreparationCache(sql).resolve(owner, key, parse, prepare);
  },
};

export const closeSpeechPreparationCache = async (): Promise<void> => {
  await sql?.end();
  sql = undefined;
};
