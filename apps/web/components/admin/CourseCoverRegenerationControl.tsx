import { Image, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type CourseCoverRegenerationJob,
  loadCourseCoverRegenerationStatus,
  startCourseCoverRegeneration,
} from '../../services/admin/adminApi.ts';

const COURSE_COVER_JOB_POLL_INTERVAL_MS = 2_000;
const COURSE_COVER_STATUS_ERROR = 'Stato della rigenerazione cover non disponibile.';

const getJobStatusText = (job: CourseCoverRegenerationJob | null): string => {
  if (!job) return t('Nessuna rigenerazione cover avviata.');
  if (job.status === 'running') {
    return t(
      '{regenerated} di {total} cover rigenerate, {failed} non riuscite, {pending} in attesa.',
      {
        failed: job.summary.failed,
        pending: job.summary.pending,
        regenerated: job.summary.regenerated,
        total: job.summary.total,
      }
    );
  }
  if (job.status === 'failed') return t('La rigenerazione cover non è partita.');
  return t('{regenerated} cover rigenerate, {skipped} saltate e {failed} non riuscite.', {
    failed: job.summary.failed,
    regenerated: job.summary.regenerated,
    skipped: job.summary.skipped,
  });
};

export default function CourseCoverRegenerationControl() {
  const [job, setJob] = useState<CourseCoverRegenerationJob | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    void loadCourseCoverRegenerationStatus()
      .then(nextJob => {
        if (!cancelled) {
          setJob(nextJob);
          setErrorMessage('');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setErrorMessage(t(COURSE_COVER_STATUS_ERROR));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (job?.status !== 'running') return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      timer = globalThis.window.setTimeout(async () => {
        try {
          const nextJob = await loadCourseCoverRegenerationStatus();
          if (!cancelled) {
            setJob(nextJob);
            setErrorMessage('');
            if (nextJob?.status === 'running') void poll();
          }
        } catch {
          if (!cancelled) {
            setErrorMessage(t(COURSE_COVER_STATUS_ERROR));
            void poll();
          }
        }
      }, COURSE_COVER_JOB_POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.window.clearTimeout(timer);
    };
  }, [job?.status]);

  const handleStart = async () => {
    setIsLoading(true);
    setErrorMessage('');
    try {
      setJob(await startCourseCoverRegeneration());
    } catch {
      setErrorMessage(t('Avvio della rigenerazione cover non riuscito.'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="mt-5 rounded-2xl border border-stone-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-zinc-100">
            <Image className="h-4 w-4 text-orange-600 dark:text-orange-400" />
            <h3>{t('Cover dei corsi')}</h3>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500 dark:text-zinc-400">
            {t(
              'Rigenera in background le cover dei tuoi corsi con il prompt corrente. Le cover esistenti restano disponibili fino al completamento.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={isLoading || job?.status === 'running'}
          aria-busy={isLoading || job?.status === 'running'}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-stone-950 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950"
        >
          <RefreshCw className={`h-4 w-4 ${job?.status === 'running' ? 'animate-spin' : ''}`} />
          {job?.status === 'running' ? t('Rigenerazione in corso') : t('Rigenera cover')}
        </button>
      </div>
      <output className="mt-4 block text-sm text-stone-700 dark:text-zinc-300">
        {isLoading && !job ? t('Caricamento...') : getJobStatusText(job)}
      </output>
      {errorMessage ? (
        <p className="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}
