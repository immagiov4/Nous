import {
  type AccountPreferences,
  AccountPreferencesSchema,
  EMPTY_ACCOUNT_PREFERENCES,
} from '@shared/accountPreferences.js';
import postgres, { type Sql } from 'postgres';
import { getAuthMode, LOCAL_AUTH_MODE } from '../auth/currentUser.js';
import type { AccountUsageGroup } from './accountUsage.js';

export interface AccountStore {
  readUsage(userId: string): Promise<AccountUsageGroup[]>;
  readPreferences(userId: string): Promise<AccountPreferences>;
  savePreferences(userId: string, preferences: AccountPreferences): Promise<AccountPreferences>;
  clearPreferences(userId: string): Promise<void>;
}

export class PostgresAccountStore implements AccountStore {
  constructor(private readonly sql: Sql) {}

  async readUsage(userId: string): Promise<AccountUsageGroup[]> {
    return this.sql<AccountUsageGroup[]>`
      select usage.provider, usage.model,
        usage.input_tokens as "inputTokens", usage.output_tokens as "outputTokens",
        usage.cache_read_tokens as "cacheReadTokens", usage.cache_write_tokens as "cacheWriteTokens",
        sum(usage.provider_cost)::double precision as "reportedCostUsd",
        count(*)::integer as calls,
        min(usage.created_at)::text as "firstRecordedAt", max(usage.created_at)::text as "lastRecordedAt"
      from public.workflow_ai_usage usage
      join public.workflow_runs run on run.id = usage.run_id
      where run.user_id = ${userId}
      group by usage.provider, usage.model, usage.input_tokens, usage.output_tokens,
        usage.cache_read_tokens, usage.cache_write_tokens, (usage.provider_cost is null)
      order by usage.provider, usage.model, "firstRecordedAt"
    `;
  }

  async readPreferences(userId: string): Promise<AccountPreferences> {
    const [row] = await this.sql<{ preferences: unknown }[]>`
      select preferences from public.account_preferences where user_id = ${userId}
    `;
    return row ? AccountPreferencesSchema.parse(row.preferences) : { ...EMPTY_ACCOUNT_PREFERENCES };
  }

  async savePreferences(
    userId: string,
    preferences: AccountPreferences
  ): Promise<AccountPreferences> {
    const validated = AccountPreferencesSchema.parse(preferences);
    await this.sql`
      insert into public.account_preferences (user_id, preferences)
      values (${userId}, ${this.sql.json(validated)})
      on conflict (user_id) do update set preferences = excluded.preferences
    `;
    return validated;
  }

  async clearPreferences(userId: string): Promise<void> {
    await this.sql`delete from public.account_preferences where user_id = ${userId}`;
  }
}

let accountSql: Sql | undefined;
let accountStore: PostgresAccountStore | undefined;

export const getAccountStore = (): PostgresAccountStore => {
  if (!accountStore) {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error('DATABASE_URL is required for account storage.');
    accountSql = postgres(databaseUrl);
    accountStore = new PostgresAccountStore(accountSql);
  }
  return accountStore;
};

export const closeAccountStore = async (): Promise<void> => {
  await accountSql?.end();
  accountSql = undefined;
  accountStore = undefined;
};

/** Local development identities have no persisted Supabase account. */
export const readCurrentAccountPreferences = async (userId: string): Promise<AccountPreferences> =>
  getAuthMode() === LOCAL_AUTH_MODE
    ? { ...EMPTY_ACCOUNT_PREFERENCES }
    : getAccountStore().readPreferences(userId);
