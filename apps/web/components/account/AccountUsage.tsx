import { type AccountUsageSummary, AccountUsageSummarySchema } from '@shared/accountUsage';
import { useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { fetchWithSupabaseAuth, readSupabaseSession } from '../../services/auth/supabaseAuth.ts';
import { getBackendUrl } from '../../services/openrouter/config.ts';

const formatTokens = (tokens: number): string =>
  new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(tokens);

const formatCost = (cost: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumSignificantDigits: 3,
  }).format(cost);

export default function AccountUsage() {
  const [usage, setUsage] = useState<AccountUsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const accountId = readSupabaseSession()?.user?.id;
    const isCurrentAccount = () =>
      !controller.signal.aborted && readSupabaseSession()?.user?.id === accountId;
    const readUsage = async (estimate: boolean) => {
      if (!accountId) throw new Error('An account is required for recorded usage.');
      const response = await fetchWithSupabaseAuth(
        `${getBackendUrl()}/api/account/usage${estimate ? '?estimate=true' : ''}`,
        { signal: controller.signal },
        { accountId }
      );
      if (!response.ok) throw new Error('Account usage unavailable.');
      return AccountUsageSummarySchema.parse(await response.json());
    };
    const loadUsage = async () => {
      const recorded = await readUsage(false);
      if (!isCurrentAccount()) return;
      setUsage(recorded);
      if (recorded.missingCostCalls === 0) return;
      try {
        const estimated = await readUsage(true);
        if (isCurrentAccount()) setUsage(estimated);
      } catch (error) {
        if (isCurrentAccount()) console.error('[Nous][Account] Cost estimate unavailable.', error);
      }
    };
    void loadUsage().catch(error => {
      if (isCurrentAccount()) {
        console.error('[Nous][Account] Usage load failed.', error);
        setFailed(true);
      }
    });
    return () => {
      controller.abort();
    };
  }, []);

  const cost =
    usage && (usage.reportedCostUsd !== null || usage.estimatedCostUsd !== null)
      ? formatCost((usage.reportedCostUsd ?? 0) + (usage.estimatedCostUsd ?? 0))
      : null;
  return (
    <div className="border-b border-gray-100 px-3 py-3 dark:border-zinc-800">
      <p className="text-xs font-medium text-gray-500 dark:text-zinc-400">
        {t('Consumo registrato')}
      </p>
      {!usage ? (
        <p className="mt-1 text-xs text-gray-500 dark:text-zinc-400">
          {failed ? t('Consumo non disponibile') : t('Caricamento...')}
        </p>
      ) : usage.recordedCalls === 0 ? (
        <p className="mt-1 text-sm">{t('Nessun consumo registrato')}</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-gray-900 dark:text-zinc-100">
            {usage.tokens === null
              ? t('Token non disponibili')
              : t('{tokens} token', { tokens: formatTokens(usage.tokens) })}
            {usage.missingTokenCalls > 0 && usage.tokens !== null ? ` ${t('parziali')}` : ''}
            {cost ? (
              <span className="ml-1 text-xs text-gray-500 dark:text-zinc-400">
                ({cost}
                {usage.estimatedCostUsd !== null ? ` ${t('stima')}` : ''}
                {usage.missingCostCalls > 0 ? `, ${t('parziale')}` : ''})
              </span>
            ) : null}
          </p>
          {!cost ? (
            <p className="mt-1 text-xs text-gray-500 dark:text-zinc-400">
              {t('Costo non disponibile')}
            </p>
          ) : null}
          {usage.estimatedCostUsd !== null ? (
            <p className="mt-1 text-xs leading-4 text-gray-500 dark:text-zinc-400">
              {t('Include token stimati alle tariffe attuali, non una fattura.')}
            </p>
          ) : null}
        </>
      )}
      <p className="mt-2 text-xs leading-4 text-gray-500 dark:text-zinc-400">
        {t('Solo generazioni registrate. Chat e audio esclusi.')}
      </p>
    </div>
  );
}
