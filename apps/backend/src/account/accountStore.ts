import {
  type AccountPreferences,
  AccountPreferencesSchema,
  EMPTY_ACCOUNT_PREFERENCES,
} from '@shared/accountPreferences.js';
import {
  type AccountSetupStatus,
  AccountSetupStatusSchema,
  type FinishAccountSetup,
} from '@shared/accountSetup.js';
import postgres, { type Sql } from 'postgres';
import { getAuthMode, LOCAL_AUTH_MODE } from '../auth/currentUser.js';
import type { AccountUsageGroup } from './accountUsage.js';

export interface AccountStore {
  readSetupStatus(userId: string): Promise<AccountSetupStatus>;
  finishSetup(userId: string, result: FinishAccountSetup): Promise<void>;
  readUsage(userId: string): Promise<AccountUsageGroup[]>;
  readPreferences(userId: string): Promise<AccountPreferences>;
  savePreferences(userId: string, preferences: AccountPreferences): Promise<AccountPreferences>;
  clearPreferences(userId: string): Promise<void>;
}

export class PostgresAccountStore implements AccountStore {
  constructor(private readonly sql: Sql) {}

  async readSetupStatus(userId: string): Promise<AccountSetupStatus> {
    const [row] = await this.sql<{ status: string }[]>`
      select status from public.account_setup where user_id = ${userId}
    `;
    return row ? AccountSetupStatusSchema.parse(row.status) : 'not-required';
  }

  async finishSetup(userId: string, result: FinishAccountSetup): Promise<void> {
    if (result.status === 'skipped') {
      await this.sql`
        insert into public.account_setup (user_id, status) values (${userId}, 'skipped')
        on conflict (user_id) do update set status = 'skipped'
      `;
      return;
    }
    const preferences = AccountPreferencesSchema.parse(result.preferences);
    // Preferences and completion must survive together, including a failed write.
    await this.sql`
      with saved_preferences as (
        insert into public.account_preferences (user_id, preferences)
        values (${userId}, ${this.sql.json(preferences)})
        on conflict (user_id) do update set preferences = excluded.preferences
        returning user_id
      )
      insert into public.account_setup (user_id, status)
      select user_id, 'completed' from saved_preferences
      on conflict (user_id) do update set status = 'completed'
    `;
  }

  async readUsage(userId: string): Promise<AccountUsageGroup[]> {
    return this.sql<AccountUsageGroup[]>`
      select usage.provider, usage.model,
        usage.input_tokens as "inputTokens", usage.output_tokens as "outputTokens",
        usage.cache_read_tokens as "cacheReadTokens", usage.cache_write_tokens as "cacheWriteTokens",
        sum(usage.provider_cost)::double precision as "reportedCostUsd",
        count(*)::integer as calls
      from public.workflow_ai_usage usage
      join public.workflow_runs run on run.id = usage.run_id
      where run.user_id = ${userId}
      group by usage.provider, usage.model, usage.input_tokens, usage.output_tokens,
        usage.cache_read_tokens, usage.cache_write_tokens, (usage.provider_cost is null)
      order by usage.provider, usage.model, min(usage.created_at)
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
