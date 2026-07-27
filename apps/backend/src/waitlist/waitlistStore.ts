import postgres from 'postgres';

type PostgresSql = ReturnType<typeof postgres>;

export interface WaitlistStore {
  add(email: string): Promise<void>;
}

class PostgresWaitlistStore implements WaitlistStore {
  private readonly sql: PostgresSql;

  constructor(databaseUrl = process.env.DATABASE_URL?.trim(), sqlClient?: PostgresSql) {
    if (!databaseUrl && !sqlClient) {
      throw new Error('DATABASE_URL is required to store waitlist entries.');
    }

    this.sql = sqlClient ?? postgres(databaseUrl as string, { max: 2 });
  }

  async add(email: string): Promise<void> {
    await this.sql`
      insert into public.waitlist_entries (email)
      values (${email})
      on conflict (email) do nothing
    `;
  }
}

let waitlistStore: WaitlistStore | null = null;

export const getWaitlistStore = (): WaitlistStore => {
  waitlistStore ??= new PostgresWaitlistStore();
  return waitlistStore;
};

export const setWaitlistStoreForTesting = (store: WaitlistStore | null): void => {
  waitlistStore = store;
};
