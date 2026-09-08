import { type AccountPreferences, AccountPreferencesSchema } from '@shared/accountPreferences';
import { setAccountLocale } from '../../i18n/uiMessages.ts';
import { fetchWithSupabaseAuth, readSupabaseSession } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';

const requestPreferences = async (
  method: 'GET' | 'PUT' | 'DELETE',
  preferences?: AccountPreferences
): Promise<AccountPreferences> => {
  const accountId = readSupabaseSession()?.user?.id;
  if (!accountId) throw new Error('An account is required for saved preferences.');
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/account/preferences`,
    {
      method,
      ...(preferences
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(AccountPreferencesSchema.parse(preferences)),
          }
        : {}),
    },
    { accountId }
  );
  if (!response.ok) throw new Error('Account preferences request failed.');
  const body = await response.json();
  const saved = AccountPreferencesSchema.parse(body.preferences);
  if (method !== 'GET' && readSupabaseSession()?.user?.id === accountId) {
    setAccountLocale(saved.interfaceLocale);
  }
  return saved;
};

export const loadAccountPreferences = (): Promise<AccountPreferences> => requestPreferences('GET');
export const saveAccountPreferences = (
  preferences: AccountPreferences
): Promise<AccountPreferences> => requestPreferences('PUT', preferences);
export const clearAccountPreferences = (): Promise<AccountPreferences> =>
  requestPreferences('DELETE');
