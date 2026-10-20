import postgres, { type Sql } from 'postgres';

/** Owner-scoped reuse with short queries and one stored winner across independent workers. */
export const createSpeechPreparationCache = (sql: Sql) => {
  const inFlight = new Map<string, Promise<unknown>>();
  const resolveStored = async <T>(owner: string, key: string, prepare: () => Promise<T>) => {
    const rows =
      await sql`select narration from public.speech_preparations where owner_id = ${owner} and cache_key = ${key}`;
    if (rows.length) return rows[0].narration;
    const narration = await prepare();
    await sql`insert into public.speech_preparations (owner_id, cache_key, narration) values (${owner}, ${key}, ${sql.json(JSON.parse(JSON.stringify(narration)))}) on conflict (owner_id, cache_key) do nothing`;
    const stored =
      await sql`select narration from public.speech_preparations where owner_id = ${owner} and cache_key = ${key}`;
    if (!stored.length) throw new Error('The prepared narration was not stored.');
    return stored[0].narration;
  };
  return {
    async resolve<T>(
      owner: string,
      key: string,
      parse: (value: unknown) => T,
      prepare: () => Promise<T>
    ): Promise<T> {
      const identity = JSON.stringify([owner, key]);
      let pending = inFlight.get(identity);
      if (!pending) {
        pending = resolveStored(owner, key, prepare);
        inFlight.set(identity, pending);
      }
      try {
        return parse(await pending);
      } finally {
        if (inFlight.get(identity) === pending) inFlight.delete(identity);
      }
    },
  };
};

let sql: Sql | undefined;
let cache: ReturnType<typeof createSpeechPreparationCache> | undefined;
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
      cache = createSpeechPreparationCache(sql);
    }
    if (!cache) throw new Error('The speech preparation cache is missing.');
    return cache.resolve(owner, key, parse, prepare);
  },
};

export const closeSpeechPreparationCache = async (): Promise<void> => {
  await sql?.end();
  sql = undefined;
  cache = undefined;
};
