import {
  Bug,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Github,
  Image as ImageIcon,
  Lightbulb,
  RotateCcw,
} from 'lucide-react';
import { type Ref, useEffect, useState } from 'react';
import { getAppLocale, translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type AdminFeedbackReport,
  type AdminFeedbackStatus,
  loadAdminFeedbackScreenshot,
} from '../../services/admin/adminApi.ts';
import { createFeedbackBreadcrumbListItems } from '../../services/feedback/feedbackBreadcrumbList.ts';
import {
  getFeedbackBreadcrumbOperationLabel,
  getFeedbackProductSurfaceLabel,
  getFeedbackWorkflowOperationLabel,
  getFeedbackWorkflowStatusLabel,
} from '../../services/feedback/feedbackDiagnosticsLabels.ts';

const STATUS_LABELS: Record<AdminFeedbackStatus, () => string> = {
  failed: () => t('Invio fallito'),
  pending: () => t('In attesa'),
  processing: () => t('Invio in corso'),
  submitted: () => t('Pubblicata'),
};

const STATUS_CLASS_NAMES: Record<AdminFeedbackStatus, string> = {
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
  processing: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  submitted: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
};

const GITHUB_STATE_CLASS_NAMES = {
  closed: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  missing: 'bg-stone-200 text-stone-700 dark:bg-zinc-700 dark:text-zinc-200',
  open: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
} as const;

const getGithubStateLabel = (state: NonNullable<AdminFeedbackReport['githubIssueState']>) => {
  if (state === 'open') return t('Aperta su GitHub');
  if (state === 'closed') return t('Chiusa su GitHub');
  return t('Non trovata su GitHub');
};

const getCategoryPresentation = (category: AdminFeedbackReport['category']) => {
  if (category === 'bug') return { icon: Bug, label: t('Problema'), tone: 'red' } as const;
  if (category === 'enhancement')
    return { icon: Lightbulb, label: t('Suggerimento'), tone: 'amber' } as const;
  return { icon: Github, label: t('Issue GitHub'), tone: 'stone' } as const;
};

const formatFeedbackDate = (value: string): string =>
  new Intl.DateTimeFormat(getAppLocale() === 'it' ? 'it-IT' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

const getFeedbackTitle = (report: AdminFeedbackReport): string => {
  if (report.title) return report.title;
  const firstLine = report.description.split('\n')[0]?.trim() || report.id;
  return firstLine.length > 88 ? `${firstLine.slice(0, 85)}…` : firstLine;
};

function FeedbackStatusBadge({ report }: { report: AdminFeedbackReport }) {
  if (report.githubIssueState) {
    return (
      <span
        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${GITHUB_STATE_CLASS_NAMES[report.githubIssueState]}`}
      >
        {getGithubStateLabel(report.githubIssueState)}
      </span>
    );
  }

  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLASS_NAMES[report.status]}`}
    >
      {STATUS_LABELS[report.status]()}
    </span>
  );
}

function FeedbackReportListItem({
  isSelected,
  onSelect,
  report,
}: {
  isSelected: boolean;
  onSelect: (reportId: string) => void;
  report: AdminFeedbackReport;
}) {
  const category = getCategoryPresentation(report.category);
  const CategoryIcon = category.icon;

  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={() => onSelect(report.id)}
      className="group flex w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-stone-50 aria-pressed:bg-orange-50/80 sm:px-5 dark:hover:bg-white/[0.03] dark:aria-pressed:bg-orange-500/10"
    >
      <CategoryIcon
        className={`mt-0.5 h-4 w-4 shrink-0 ${
          category.tone === 'red'
            ? 'text-red-500'
            : category.tone === 'amber'
              ? 'text-amber-600'
              : 'text-stone-500'
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm font-semibold leading-5 text-stone-900 dark:text-zinc-100">
          {getFeedbackTitle(report)}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-zinc-400">
          <FeedbackStatusBadge report={report} />
          <span>{formatFeedbackDate(report.createdAt)}</span>
        </span>
      </span>
    </button>
  );
}

export function AdminFeedbackList({
  isLoading,
  onPageChange,
  onSelect,
  page,
  reports,
  selectedReportId,
  totalPages,
}: {
  isLoading: boolean;
  onPageChange: (page: number) => void;
  onSelect: (reportId: string) => void;
  page: number;
  reports: AdminFeedbackReport[];
  selectedReportId: string | null;
  totalPages: number;
}) {
  return (
    <div className="border-b border-stone-200 xl:border-r xl:border-b-0 dark:border-zinc-700">
      <div className="divide-y divide-stone-100 dark:divide-zinc-800">
        {reports.map(report => (
          <FeedbackReportListItem
            key={report.id}
            report={report}
            isSelected={selectedReportId === report.id}
            onSelect={onSelect}
          />
        ))}
      </div>
      <nav
        aria-label={t('Pagine segnalazioni')}
        className="flex items-center justify-between border-t border-stone-200 px-4 py-3 dark:border-zinc-700"
      >
        <button
          type="button"
          aria-label={t('Pagina precedente')}
          disabled={page <= 1 || isLoading}
          onClick={() => onPageChange(page - 1)}
          className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 disabled:opacity-30 dark:hover:bg-zinc-800"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-xs text-stone-500 dark:text-zinc-400">
          {t('Pagina {currentPage} di {pageCount}', {
            currentPage: page,
            pageCount: totalPages,
          })}
        </span>
        <button
          type="button"
          aria-label={t('Pagina successiva')}
          disabled={page >= totalPages || isLoading}
          onClick={() => onPageChange(page + 1)}
          className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 disabled:opacity-30 dark:hover:bg-zinc-800"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </nav>
    </div>
  );
}

function FeedbackDiagnostics({ report }: { report: AdminFeedbackReport }) {
  const diagnostics = report.diagnostics;

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-zinc-500">
        {t('Diagnostica')}
      </h4>
      <dl className="mt-3 space-y-2 text-sm">
        {diagnostics.pageUrl ? (
          <div>
            <dt className="text-xs text-stone-400 dark:text-zinc-500">{t('Pagina')}</dt>
            <dd className="mt-0.5 break-all text-stone-700 dark:text-zinc-200">
              {diagnostics.pageUrl}
            </dd>
          </div>
        ) : null}
        {diagnostics.appVersion ? (
          <div>
            <dt className="text-xs text-stone-400 dark:text-zinc-500">{t('Versione')}</dt>
            <dd className="text-stone-700 dark:text-zinc-200">{diagnostics.appVersion}</dd>
          </div>
        ) : null}
        {diagnostics.requestId ? (
          <div>
            <dt className="text-xs text-stone-400 dark:text-zinc-500">Request ID</dt>
            <dd className="break-all text-stone-700 dark:text-zinc-200">{diagnostics.requestId}</dd>
          </div>
        ) : null}
        {diagnostics.correlationIds?.length ? (
          <div>
            <dt className="text-xs text-stone-400 dark:text-zinc-500">Correlation ID</dt>
            <dd className="break-all text-stone-700 dark:text-zinc-200">
              {diagnostics.correlationIds.join(', ')}
            </dd>
          </div>
        ) : null}
        {diagnostics.productContext ? (
          <FeedbackProductContextDetails productContext={diagnostics.productContext} />
        ) : null}
      </dl>
    </div>
  );
}

function FeedbackProductContextDetails({
  productContext,
}: {
  productContext: NonNullable<AdminFeedbackReport['diagnostics']['productContext']>;
}) {
  return (
    <div>
      <dt className="text-xs text-stone-400 dark:text-zinc-500">{t('Contesto prodotto')}</dt>
      <dd className="mt-1 space-y-1 text-stone-700 dark:text-zinc-200">
        {productContext.project ? (
          <p>
            {t('Corso')}: {productContext.project.id}
            {productContext.project.revision === undefined
              ? ''
              : ` · ${t('Revisione')} ${productContext.project.revision}`}
          </p>
        ) : null}
        {productContext.section ? (
          <p>
            {t('Lezione')}: {productContext.section.id}
          </p>
        ) : null}
        {productContext.surface ? (
          <p>
            {t('Area')}: {getFeedbackProductSurfaceLabel(productContext.surface)}
          </p>
        ) : null}
        {productContext.workflow ? (
          <p>
            {t('Attività')}: {getFeedbackWorkflowOperationLabel(productContext.workflow.operation)}{' '}
            ({getFeedbackWorkflowStatusLabel(productContext.workflow.status)}) ·{' '}
            {productContext.workflow.runId}
          </p>
        ) : null}
        {productContext.breadcrumbs?.length ? (
          <ul className="space-y-1">
            {createFeedbackBreadcrumbListItems(productContext.breadcrumbs).map(
              ({ breadcrumb, key }) => (
                <li key={key}>
                  {getFeedbackBreadcrumbOperationLabel(breadcrumb.operation)} ·{' '}
                  {getFeedbackProductSurfaceLabel(breadcrumb.surface)}
                  {breadcrumb.projectId ? ` · ${breadcrumb.projectId}` : ''}
                  {breadcrumb.sectionId ? ` · ${breadcrumb.sectionId}` : ''} ·{' '}
                  {breadcrumb.timestamp}
                </li>
              )
            )}
          </ul>
        ) : null}
      </dd>
    </div>
  );
}

type ScreenshotLoadState =
  | { status: 'error' }
  | { status: 'loaded'; url: string }
  | { status: 'loading' };

function useFeedbackScreenshot(reportId: string): ScreenshotLoadState {
  const [state, setState] = useState<ScreenshotLoadState>({ status: 'loading' });

  useEffect(() => {
    let isActive = true;
    let objectUrl: string | null = null;

    void loadAdminFeedbackScreenshot(reportId)
      .then(blob => {
        if (!isActive) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'loaded', url: objectUrl });
      })
      .catch(error => {
        if (!isActive) return;
        console.warn('[Nous][Admin] Feedback screenshot failed.', error);
        setState({ status: 'error' });
      });

    return () => {
      isActive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reportId]);

  return state;
}

function FeedbackScreenshot({ reportId }: { reportId: string }) {
  const state = useFeedbackScreenshot(reportId);

  if (state.status === 'loaded') {
    return (
      <a href={state.url} target="_blank" rel="noreferrer">
        <img
          src={state.url}
          alt={t('Screenshot della segnalazione')}
          className="mt-3 max-h-64 w-full rounded-xl border border-stone-200 object-contain dark:border-zinc-700"
        />
      </a>
    );
  }

  if (state.status === 'error') {
    return (
      <output className="mt-3 rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
        {t('Screenshot non disponibile.')}
      </output>
    );
  }

  return (
    <output className="mt-3 flex h-32 items-center justify-center gap-2 rounded-xl bg-stone-100 text-sm text-stone-500 dark:bg-zinc-800 dark:text-zinc-400">
      <ImageIcon className="h-5 w-5" />
      {t('Caricamento screenshot…')}
    </output>
  );
}

function FeedbackTechnicalDetails({ report }: { report: AdminFeedbackReport }) {
  const hasDiagnostics = Object.keys(report.diagnostics).length > 0;
  if (!hasDiagnostics && !report.hasScreenshot) return null;

  return (
    <div className="mt-6 grid gap-6 border-t border-stone-200 pt-5 lg:grid-cols-2 dark:border-zinc-700">
      {hasDiagnostics ? <FeedbackDiagnostics report={report} /> : null}
      {report.hasScreenshot ? (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-zinc-500">
            Screenshot
          </h4>
          <FeedbackScreenshot reportId={report.id} />
        </div>
      ) : null}
    </div>
  );
}

function FeedbackConsoleLogs({ report }: { report: AdminFeedbackReport }) {
  const entries = report.diagnostics.consoleEntries;
  if (!entries?.length) return null;

  return (
    <details className="mt-6 border-t border-stone-200 pt-5 dark:border-zinc-700">
      <summary className="cursor-pointer text-sm font-semibold text-stone-700 dark:text-zinc-200">
        {t('Log della console ({logCount})', { logCount: entries.length })}
      </summary>
      <ol className="mt-3 max-h-64 space-y-2 overflow-auto rounded-xl bg-stone-950 p-4 text-xs text-stone-200">
        {entries.map(entry => (
          <li
            key={`${entry.timestamp || 'log'}-${entry.level}-${entry.message}`}
            className="break-words"
          >
            <span className="text-orange-300">[{entry.level}]</span> {entry.message}
          </li>
        ))}
      </ol>
    </details>
  );
}

function FeedbackGithubIssue({ report }: { report: AdminFeedbackReport }) {
  if (!report.githubIssueUrl) return null;

  return (
    <div className="mt-6 border-t border-stone-200 pt-5 dark:border-zinc-700">
      <a
        href={report.githubIssueUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 text-sm font-semibold text-orange-700 hover:text-orange-900 dark:text-orange-300 dark:hover:text-orange-200"
      >
        {t('Apri issue #{issueNumber} su GitHub', {
          issueNumber: report.githubIssueNumber || '—',
        })}
        <ExternalLink className="h-4 w-4" />
      </a>
    </div>
  );
}

export function AdminFeedbackDetail({
  detailRef,
  onRetry,
  report,
  retryingId,
}: {
  detailRef: Ref<HTMLElement>;
  onRetry: (report: AdminFeedbackReport) => Promise<void>;
  report: AdminFeedbackReport;
  retryingId: string | null;
}) {
  const category = getCategoryPresentation(report.category);

  return (
    <article
      ref={detailRef}
      tabIndex={-1}
      className="min-w-0 scroll-mt-4 p-5 outline-none sm:p-6"
      aria-labelledby="selected-feedback-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                category.tone === 'red'
                  ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                  : category.tone === 'amber'
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200'
                    : 'bg-stone-200 text-stone-700 dark:bg-zinc-700 dark:text-zinc-200'
              }`}
            >
              {category.label}
            </span>
            <FeedbackStatusBadge report={report} />
          </div>
          <h3
            id="selected-feedback-title"
            className="mt-3 font-serif text-2xl leading-tight text-stone-950 dark:text-zinc-100"
          >
            {getFeedbackTitle(report)}
          </h3>
          <p className="mt-2 text-xs text-stone-500 dark:text-zinc-400">
            {formatFeedbackDate(report.createdAt)} ·{' '}
            {report.reporterEmail || t('Utente autenticato')}
          </p>
          {report.githubLabels.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={t('Etichette GitHub')}>
              {report.githubLabels.map(label => (
                <li
                  key={label}
                  className="rounded-full bg-stone-100 px-2 py-0.5 text-[0.7rem] font-medium text-stone-600 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  {label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {report.status === 'failed' ? (
          <button
            type="button"
            disabled={retryingId !== null}
            onClick={() => void onRetry(report)}
            className="inline-flex items-center gap-2 rounded-full border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700 disabled:cursor-wait disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200"
          >
            <RotateCcw
              className={`h-3.5 w-3.5 ${
                retryingId === report.id ? 'animate-spin motion-reduce:animate-none' : ''
              }`}
            />
            {t('Riprova pubblicazione')}
          </button>
        ) : null}
      </div>

      <div className="mt-6 border-t border-stone-200 pt-5 dark:border-zinc-700">
        <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-zinc-500">
          {t('Descrizione')}
        </h4>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-stone-700 dark:text-zinc-200">
          {report.description}
        </p>
      </div>

      <FeedbackTechnicalDetails report={report} />
      <FeedbackConsoleLogs report={report} />
      <FeedbackGithubIssue report={report} />
    </article>
  );
}
