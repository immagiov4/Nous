import { AccountSetupStatusSchema, type FinishAccountSetup } from '@shared/accountSetup';
import { fetchWithSupabaseAuth, readSupabaseSession } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';

export const ACCOUNT_SETUP_PATH = '/preferences/setup';
export const ACCOUNT_SETUP_DEMO_PATH = '/dev/first-run';

const requestSetup = async (result?: FinishAccountSetup) => {
  const accountId = readSupabaseSession()?.user?.id;
  if (!accountId) throw new Error('An account is required for initial setup.');
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/account/setup`,
    {
      method: result ? 'PUT' : 'GET',
      ...(result
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }
        : {}),
    },
    { accountId }
  );
  if (!response.ok) throw new Error('Account setup request failed.');
  return AccountSetupStatusSchema.parse((await response.json()).status);
};
export const loadAccountSetupStatus = () => requestSetup();
export const finishAccountSetup = async (result: FinishAccountSetup): Promise<void> => {
  await requestSetup(result);
};
