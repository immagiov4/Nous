import { Inbox, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type AdminFeedbackReport,
  listAdminFeedback,
  retryAdminFeedback,
  syncAdminFeedback,
} from '../../services/admin/adminApi.ts';
import { AdminFeedbackDetail, AdminFeedbackList } from './AdminFeedbackView.tsx';

const FEEDBACK_PAGE_SIZE = 10;
const DESKTOP_DETAIL_BREAKPOINT_PX = 1280;

export default function AdminFeedbackPanel() {
  const [reports, setReports] = useState<AdminFeedbackReport[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const detailRef = useRef<HTMLElement>(null);

  const totalPages = Math.max(1, Math.ceil(total / FEEDBACK_PAGE_SIZE));
  const selectedReport =
    reports.find(report => report.id === selectedReportId) || reports[0] || null;

  const loadPage = useCallback(async (requestedPage: number) => {
    setIsLoading(true);
    setErrorMessage('');
    try {
      const result = await listAdminFeedback(requestedPage, FEEDBACK_PAGE_SIZE);
      setReports(result.reports);
      setTotal(result.total);
      setPage(result.page);
      setSelectedReportId(currentId =>
        result.reports.some(report => report.id === currentId)
          ? currentId
          : result.reports[0]?.id || null
      );
    } catch (error) {
      console.error('[Nous][Admin] Feedback list failed.', error);
      setErrorMessage(t('Segnalazioni non disponibili. Riprova.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadPage(1);
    });
  }, [loadPage]);

  const handleReportSelection = (reportId: string) => {
    setSelectedReportId(reportId);
    if (globalThis.window.innerWidth >= DESKTOP_DETAIL_BREAKPOINT_PX) return;
    globalThis.window.requestAnimationFrame(() => {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  };

  const handleRetry = async (report: AdminFeedbackReport) => {
    setRetryingId(report.id);
    setErrorMessage('');
    setStatusMessage('');
    try {
      await retryAdminFeedback(report.id);
      setStatusMessage(t('Segnalazione rimessa in coda.'));
      await loadPage(page);
    } catch (error) {
      console.error('[Nous][Admin] Feedback retry failed.', error);
      setErrorMessage(t('Nuovo tentativo non riuscito. Riprova.'));
    } finally {
      setRetryingId(null);
    }
  };

  const handleGithubSync = async () => {
    setIsSyncing(true);
    setErrorMessage('');
    setStatusMessage('');
    try {
      const result = await syncAdminFeedback();
      await loadPage(1);
      setStatusMessage(
        t('{issueCount} issue sincronizzate da GitHub alle {syncTime}.', {
          issueCount: result.issueCount,
          syncTime: new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
            new Date(result.synchronizedAt)
          ),
        })
      );
    } catch (error) {
      console.error('[Nous][Admin] GitHub feedback sync failed.', error);
      setErrorMessage(t('Sincronizzazione GitHub non riuscita. Riprova.'));
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <section aria-labelledby="admin-feedback-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">
            {t('Voce degli utenti')}
          </p>
          <h2
            id="admin-feedback-title"
            className="mt-1 font-serif text-2xl text-stone-950 dark:text-zinc-100"
          >
            {t('Segnalazioni')}
          </h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-zinc-400">
            {t('{feedbackCount} segnalazioni ricevute', { feedbackCount: total })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleGithubSync()}
          disabled={isLoading || isSyncing}
          className="inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 transition-colors hover:border-stone-500 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        >
          <RefreshCw
            className={`h-4 w-4 ${isSyncing ? 'animate-spin motion-reduce:animate-none' : ''}`}
          />
          {t('Sincronizza GitHub')}
        </button>
      </div>

      {errorMessage ? (
        <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-300">
          {errorMessage}
        </p>
      ) : null}
      {statusMessage ? (
        <output className="mt-4 block text-sm text-emerald-700 dark:text-emerald-300">
          {statusMessage}
        </output>
      ) : null}

      {reports.length === 0 && !isLoading ? (
        <div className="mt-8 border-y border-stone-200 py-14 text-center dark:border-zinc-700">
          <Inbox className="mx-auto h-7 w-7 text-stone-400" />
          <h3 className="mt-4 font-serif text-xl text-stone-900 dark:text-zinc-100">
            {t('Nessuna segnalazione')}
          </h3>
          <p className="mt-2 text-sm text-stone-500 dark:text-zinc-400">
            {t('Quando un utente invia un feedback, comparirà qui.')}
          </p>
        </div>
      ) : (
        <div className="mt-6 grid overflow-hidden rounded-2xl border border-stone-200 bg-white xl:grid-cols-[minmax(20rem,0.82fr)_minmax(0,1.18fr)] dark:border-zinc-700 dark:bg-zinc-900">
          <AdminFeedbackList
            reports={reports}
            selectedReportId={selectedReport?.id || null}
            page={page}
            totalPages={totalPages}
            isLoading={isLoading}
            onSelect={handleReportSelection}
            onPageChange={requestedPage => void loadPage(requestedPage)}
          />
          {selectedReport ? (
            <AdminFeedbackDetail
              key={selectedReport.id}
              report={selectedReport}
              retryingId={retryingId}
              detailRef={detailRef}
              onRetry={handleRetry}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
