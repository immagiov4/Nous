import { formatYouTubeTranscript } from '@shared/youtubeTranscript';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FlaskConical,
  Search,
  XCircle,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type AdminYouTubeResearchCandidate,
  type AdminYouTubeResearchLabResult,
  runAdminYouTubeResearchLab,
} from '../../services/admin/adminApi.ts';
import { readSupabaseAccessRole, readSupabaseSession } from '../../services/auth/supabaseAuth.ts';
import {
  evaluateYouTubeResearchLab,
  type YouTubeResearchLabEvaluation,
} from '../../services/openrouter/research.ts';
import { planYouTubeSearchQuery } from '../../services/openrouter/youtubeSearchQuery.ts';
import { buildYouTubeClipEmbedUrl, extractYouTubeVideoId } from '../../utils/youtube.ts';

interface LabRun {
  evaluation: YouTubeResearchLabEvaluation | null;
  research: AdminYouTubeResearchLabResult;
}

const fieldClassName =
  'w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-950 outline-none transition-colors focus:border-orange-500 focus:ring-1 focus:ring-orange-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100';
const formatDuration = (seconds?: number): string => {
  if (!seconds) return '—';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

const formatCount = (value?: number): string =>
  typeof value === 'number' ? new Intl.NumberFormat().format(value) : '—';

const getPipelineDecisionLabel = (candidate: AdminYouTubeResearchCandidate): string => {
  const labels = {
    'context-included': t('Transcript incluso nel contesto'),
    'no-transcript': t('Scartato: transcript non disponibile'),
    'playlist-expanded': t('Playlist espansa'),
    'playlist-expansion-failed': t('Scartato: espansione playlist fallita'),
    'transcript-budget': t('Scartato: budget transcript esaurito'),
    'transcript-not-requested': t('Non interrogato: budget esaurito'),
  } as const;
  return labels[candidate.decision];
};

const getTranscriptAttemptLabel = (
  outcome: AdminYouTubeResearchCandidate['transcriptAttempts'][number]['outcome']
): string =>
  ({
    available: t('disponibile'),
    empty: t('vuoto'),
    unavailable: t('non disponibile'),
  })[outcome];

const getTranscriptKindLabel = (
  kind: AdminYouTubeResearchCandidate['transcriptAttempts'][number]['kind']
): string =>
  ({
    automatic: t('automatico'),
    manual: t('manuale'),
    translated: t('tradotto'),
  })[kind];

const getModelDecisionLabel = (
  decision: YouTubeResearchLabEvaluation['youtubeCandidateDecisions'][number]['decision']
): string =>
  ({
    rejected: t('Scartato dal modello'),
    'selected-source': t('Scelto come fonte video'),
  })[decision];

const CandidateCard = ({
  candidate,
  evaluation,
}: {
  candidate: AdminYouTubeResearchCandidate;
  evaluation: YouTubeResearchLabEvaluation | null;
}) => {
  const videoId = extractYouTubeVideoId(candidate.url);
  const selectedSource = videoId
    ? evaluation?.dossier.sources.find(
        source => extractYouTubeVideoId(source.url || '') === videoId
      )
    : undefined;
  const modelDecision = videoId
    ? evaluation?.youtubeCandidateDecisions.find(
        decision => extractYouTubeVideoId(decision.url) === videoId
      )
    : undefined;
  return (
    <article className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-zinc-400">
            <span className="rounded-full bg-stone-100 px-2 py-1 font-semibold uppercase dark:bg-zinc-800">
              {candidate.kind}
            </span>
            <span>#{candidate.id}</span>
          </div>
          <h3 className="mt-2 text-base font-semibold leading-6">{candidate.title}</h3>
          <p className="mt-1 text-xs text-stone-500 dark:text-zinc-400">
            {candidate.channelTitle || t('Canale non disponibile')} ·{' '}
            {formatDuration(candidate.durationSeconds)} · {formatCount(candidate.viewCount)}{' '}
            {t('visualizzazioni')}
          </p>
        </div>
        <a
          href={candidate.url}
          target="_blank"
          rel="noreferrer"
          aria-label={t('Apri {videoTitle} su YouTube', { videoTitle: candidate.title })}
          className="shrink-0 rounded-full border border-stone-300 p-2 text-stone-500 hover:text-stone-950 dark:border-zinc-700 dark:hover:text-zinc-100"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <p className="rounded-xl bg-stone-50 px-3 py-2 dark:bg-zinc-800/70">
          <span className="font-semibold">Pipeline:</span> {getPipelineDecisionLabel(candidate)}
          {candidate.estimatedTokens !== undefined ? (
            <span className="mt-1 block text-stone-500 dark:text-zinc-400">
              {candidate.includedTokens || 0}/{candidate.estimatedTokens} token
            </span>
          ) : null}
        </p>
        <div className="rounded-xl bg-stone-50 px-3 py-2 dark:bg-zinc-800/70">
          <span className="font-semibold">Modello:</span>{' '}
          {!evaluation
            ? t('Non eseguito')
            : candidate.kind === 'playlist'
              ? t('Non valutabile come clip: è una playlist')
              : candidate.decision !== 'context-included'
                ? t('Non valutato: il transcript non è entrato nel contesto')
                : modelDecision
                  ? getModelDecisionLabel(modelDecision.decision)
                  : t('Nessuna motivazione restituita.')}
          {modelDecision ? (
            <span className="mt-1 block leading-5 text-stone-600 dark:text-zinc-300">
              {modelDecision.reason}
            </span>
          ) : null}
        </div>
      </div>

      {selectedSource?.note ? (
        <p className="mt-3 text-sm leading-6 text-stone-700 dark:text-zinc-300">
          {selectedSource.note}
        </p>
      ) : null}

      {candidate.transcriptAttempts.length ? (
        <details className="mt-3 rounded-xl border border-stone-200 dark:border-zinc-700">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
            {t('Tentativi transcript')} ({candidate.transcriptAttempts.length}) ·{' '}
            {candidate.transcriptLookupMs ?? 0} ms
            {candidate.transcriptCached ? ` · ${t('cache')}` : ''}
          </summary>
          <div className="border-t border-stone-200 px-3 py-2 text-xs dark:border-zinc-700">
            {candidate.transcriptAttempts.map(attempt => (
              <p key={`${attempt.language}-${attempt.kind}`} className="py-1">
                {attempt.language} · {getTranscriptKindLabel(attempt.kind)} ·{' '}
                {getTranscriptAttemptLabel(attempt.outcome)} · {attempt.durationMs} ms
              </p>
            ))}
          </div>
        </details>
      ) : null}

      {candidate.transcript ? (
        <details className="mt-2 rounded-xl border border-stone-200 dark:border-zinc-700">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
            Transcript {candidate.transcript.language} ·{' '}
            {getTranscriptKindLabel(candidate.transcript.kind)} ·{' '}
            {candidate.transcript.segmentCount} {t('segmenti')} ·{' '}
            {candidate.transcript.characterCount} {t('caratteri')}
          </summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-stone-200 p-3 text-xs leading-5 dark:border-zinc-700">
            {formatYouTubeTranscript(candidate.transcript.segments)}
          </pre>
        </details>
      ) : null}
    </article>
  );
};

export default function YouTubeResearchLab() {
  const [topic, setTopic] = useState('');
  const [lessonGoal, setLessonGoal] = useState('');
  const [language, setLanguage] = useState('Italiano');
  const [contextWindowTokens, setContextWindowTokens] = useState(128_000);
  const [reservedOutputTokens, setReservedOutputTokens] = useState(32_000);
  const [nonYouTubePromptTokens, setNonYouTubePromptTokens] = useState(8_000);
  const [run, setRun] = useState<LabRun | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [stage, setStage] = useState('');
  const session = readSupabaseSession();
  const sessionRole = session ? readSupabaseAccessRole(session.accessToken) : null;
  const hasAdminAccess = sessionRole === 'admin';

  useEffect(() => {
    if (!hasAdminAccess) {
      globalThis.window.location.replace('/');
    }
  }, [hasAdminAccess]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!topic.trim()) return;

    setErrorMessage('');
    setRun(null);
    setIsRunning(true);
    try {
      const searchPlan = await planYouTubeSearchQuery({
        courseTitle: topic.trim(),
        language,
        lessonDescription: lessonGoal.trim(),
        lessonTitle: lessonGoal.trim() || undefined,
      });
      setStage(t('Ricerca e transcript reali…'));
      const research = await runAdminYouTubeResearchLab({
        contextWindowTokens,
        language,
        nonYouTubePromptTokens,
        query: searchPlan.specificQuery,
        reservedOutputTokens,
      });
      setRun({ evaluation: null, research });
      const hasTranscriptContext = Boolean(research.diagnostic.bundle.context);
      if (!hasTranscriptContext) {
        console.info('[Nous] Non sono state selezionate fonti YouTube.');
        return;
      }

      setStage(t('Valutazione con i modelli di produzione…'));
      const evaluation = await evaluateYouTubeResearchLab({
        language,
        lessonGoal,
        topic,
        youtubeResearch: {
          context: research.diagnostic.bundle.context,
          rationale: `${research.diagnostic.bundle.videoCandidates.length} candidati con transcript disponibili nel laboratorio.`,
          videoCandidates: research.diagnostic.bundle.videoCandidates,
          videoClipsEnabled: true,
        },
      });
      setRun({ evaluation, research });
      const selectedYouTubeSource = evaluation.dossier.sources.some(source =>
        research.diagnostic.bundle.videoCandidates.some(
          candidate =>
            extractYouTubeVideoId(candidate.url) === extractYouTubeVideoId(source.url || '')
        )
      );
      if (!selectedYouTubeSource) {
        console.info('[Nous] Non sono state selezionate fonti YouTube.');
      }
    } catch {
      console.error('[Nous] Errore tecnico durante la procedura YouTube.');
      setErrorMessage(t('Laboratorio YouTube non disponibile.'));
    } finally {
      setIsRunning(false);
      setStage('');
    }
  };

  const selectedClip =
    run?.evaluation?.youtubeCandidateDecisions.flatMap(decision => {
      if (decision.decision !== 'selected-source') return [];
      const candidate = run.research.diagnostic.bundle.videoCandidates.find(
        item => extractYouTubeVideoId(item.url) === extractYouTubeVideoId(decision.url)
      );
      if (!candidate) return [];
      const range = candidate.segments[0];
      const details = run.research.diagnostic.candidates.find(
        item => extractYouTubeVideoId(item.url) === extractYouTubeVideoId(decision.url)
      );
      const embedUrl = range
        ? buildYouTubeClipEmbedUrl(candidate.url, range.startSeconds, range.endSeconds)
        : null;
      return range && embedUrl
        ? [
            {
              embedUrl,
              endSeconds: range.endSeconds,
              isDiagnosticFallback: true,
              note: t(
                'Anteprima diagnostica del primo intervallo timestampato. La stesura sceglierà la clip effettiva nel contesto della lezione.'
              ),
              startSeconds: range.startSeconds,
              title: details?.title || decision.url,
            },
          ]
        : [];
    })[0] ||
    run?.research.diagnostic.bundle.videoCandidates.flatMap(candidate => {
      const range = candidate.segments[0];
      const details = run.research.diagnostic.candidates.find(
        item => extractYouTubeVideoId(item.url) === extractYouTubeVideoId(candidate.url)
      );
      const embedUrl = range
        ? buildYouTubeClipEmbedUrl(candidate.url, range.startSeconds, range.endSeconds)
        : null;
      return range && embedUrl
        ? [
            {
              embedUrl,
              endSeconds: range.endSeconds,
              isDiagnosticFallback: true,
              note: t(
                'Nessun video è stato selezionato. Questa è l’anteprima del primo intervallo timestampato disponibile.'
              ),
              startSeconds: range.startSeconds,
              title: details?.title || candidate.url,
            },
          ]
        : [];
    })[0] ||
    null;
  const diagnostic = run?.research.diagnostic;

  if (!hasAdminAccess) {
    return null;
  }

  return (
    <main className="min-h-screen bg-[#f8f7f4] px-3 py-4 text-stone-950 sm:px-5 sm:py-6 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-stone-200 pb-5 dark:border-zinc-800">
          <a
            href="/admin"
            className="inline-flex items-center gap-2 text-sm text-stone-600 hover:text-stone-950 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('Amministrazione')}
          </a>
          <div className="mt-3 flex items-start gap-3">
            <FlaskConical className="mt-1 h-6 w-6 text-orange-600 dark:text-orange-400" />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">
                {t('Diagnostica temporanea')}
              </p>
              <h1 className="mt-1 font-serif text-3xl sm:text-4xl">YouTube Research Lab</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600 dark:text-zinc-400">
                {t(
                  'Esegue la stessa ricerca e raccolta transcript Decodo usata per una lezione. Non salva nulla.'
                )}
              </p>
            </div>
          </div>
        </header>

        <form
          onSubmit={handleSubmit}
          className="mt-6 grid gap-4 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <label>
            <span className="text-sm font-semibold">{t('Argomento del corso')}</span>
            <input
              value={topic}
              onChange={event => setTopic(event.target.value)}
              className={`${fieldClassName} mt-1`}
              placeholder="Pixel art"
              maxLength={500}
              required
            />
          </label>
          <label>
            <span className="text-sm font-semibold">{t('Titolo o obiettivo della lezione')}</span>
            <textarea
              value={lessonGoal}
              onChange={event => setLessonGoal(event.target.value)}
              className={`${fieldClassName} mt-1 min-h-24 resize-y`}
              placeholder={t('Opzionale: per esempio bordi, curve, sfumature e texture')}
              maxLength={500}
            />
          </label>
          <label className="sm:max-w-xs">
            <span className="text-sm font-semibold">{t('Lingua')}</span>
            <select
              value={language}
              onChange={event => setLanguage(event.target.value)}
              className={`${fieldClassName} mt-1`}
            >
              <option value="Italiano">Italiano</option>
              <option value="English">English</option>
            </select>
          </label>
          <fieldset className="grid gap-3 rounded-xl border border-stone-200 p-3 sm:grid-cols-3 dark:border-zinc-700">
            <legend className="px-1 text-sm font-semibold">{t('Budget token')}</legend>
            <label>
              <span className="text-xs text-stone-500 dark:text-zinc-400">W · context window</span>
              <input
                type="number"
                min={1}
                max={2_000_000}
                value={contextWindowTokens}
                onChange={event => setContextWindowTokens(Number(event.target.value))}
                className={`${fieldClassName} mt-1`}
              />
            </label>
            <label>
              <span className="text-xs text-stone-500 dark:text-zinc-400">
                O · output {t('riservato')}
              </span>
              <input
                type="number"
                min={0}
                max={2_000_000}
                value={reservedOutputTokens}
                onChange={event => setReservedOutputTokens(Number(event.target.value))}
                className={`${fieldClassName} mt-1`}
              />
            </label>
            <label>
              <span className="text-xs text-stone-500 dark:text-zinc-400">
                F · prompt + fonti non-YouTube
              </span>
              <input
                type="number"
                min={0}
                max={2_000_000}
                value={nonYouTubePromptTokens}
                onChange={event => setNonYouTubePromptTokens(Number(event.target.value))}
                className={`${fieldClassName} mt-1`}
              />
            </label>
            <p className="text-xs leading-5 text-stone-500 sm:col-span-3 dark:text-zinc-400">
              R = max(0, W − O − F). B = min(40% W, 60% R).{' '}
              {t(
                'Ogni transcript usa al massimo metà del budget residuo; se è più lungo viene escluso senza selezioni per keyword.'
              )}
            </p>
          </fieldset>
          <div className="rounded-xl bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:bg-zinc-800 dark:text-zinc-300">
            <span className="font-semibold">{t('Query reale')}:</span>{' '}
            {run?.research.diagnostic.query || '—'}
          </div>
          <button
            type="submit"
            disabled={isRunning || !topic.trim()}
            className="inline-flex w-fit items-center gap-2 rounded-full bg-stone-950 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950"
          >
            <Search className="h-4 w-4" />
            {isRunning ? stage : t('Esegui il percorso reale')}
          </button>
        </form>

        {errorMessage ? (
          <p
            role="alert"
            className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
          >
            {errorMessage}
          </p>
        ) : null}

        {run && diagnostic ? (
          <div className="mt-6 space-y-6">
            <section aria-labelledby="youtube-lab-run-title">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">
                    {t('Esecuzione')}
                  </p>
                  <h2 id="youtube-lab-run-title" className="mt-1 font-serif text-2xl">
                    {diagnostic.query}
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-white px-3 py-1.5 dark:bg-zinc-900">
                    {run.research.productionVideoClipsEnabled ? (
                      <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <XCircle className="mr-1 inline h-3.5 w-3.5 text-red-600" />
                    )}
                    {t('Clip YouTube abilitate nella generazione')}
                  </span>
                </div>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  [t('Tempo totale'), `${diagnostic.timings.totalMs} ms`],
                  [t('Candidati'), String(diagnostic.candidates.length)],
                  [t('Richieste transcript API'), String(diagnostic.operations.transcriptRequests)],
                  [t('Tentativi modello'), String(run.evaluation?.model.attempts.total || 0)],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-xl border border-stone-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    <p className="text-xs text-stone-500 dark:text-zinc-400">{label}</p>
                    <p className="mt-1 text-lg font-semibold">{value}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid gap-2 rounded-2xl border border-stone-200 bg-white p-4 sm:grid-cols-4 dark:border-zinc-700 dark:bg-zinc-900">
                {[
                  ['R', diagnostic.budget.residualTokens],
                  ['B', diagnostic.budget.transcriptBudgetTokens],
                  [t('Usato'), diagnostic.budget.usedTokens],
                  [t('Residuo'), diagnostic.budget.remainingTokens],
                ].map(([label, value]) => (
                  <p key={label} className="text-sm">
                    <span className="text-xs text-stone-500 dark:text-zinc-400">{label}</span>
                    <span className="mt-1 block font-semibold">{value} token</span>
                  </p>
                ))}
                <p className="text-xs leading-5 text-stone-500 sm:col-span-4 dark:text-zinc-400">
                  W {diagnostic.budget.contextWindowTokens} − O{' '}
                  {diagnostic.budget.reservedOutputTokens} − F{' '}
                  {diagnostic.budget.nonYouTubePromptTokens}; max per transcript{' '}
                  {diagnostic.budget.perTranscriptMaxTokens} token.{' '}
                  {t('Stima conservativa: caratteri diviso 4, arrotondati per eccesso.')}
                </p>
              </div>

              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                <p className="text-xs text-stone-500 dark:text-zinc-400">
                  {t('Ricerca')}: {diagnostic.timings.discoveryMs} ms
                </p>
                <p className="text-xs text-stone-500 dark:text-zinc-400">
                  {t('Playlist')}: {diagnostic.timings.playlistExpansionMs} ms
                </p>
                <p className="text-xs text-stone-500 dark:text-zinc-400">
                  Transcript: {diagnostic.timings.transcriptsMs} ms
                </p>
                <p className="text-xs text-stone-500 dark:text-zinc-400">
                  {t('Ricerca modello')}: {run.evaluation?.model.attempts.research || 0}{' '}
                  {t('tentativi')} · {run.evaluation?.model.timings.researchMs || 0} ms
                </p>
                <p className="text-xs text-stone-500 dark:text-zinc-400">
                  {t('Strutturazione modello')}: {run.evaluation?.model.attempts.structuring || 0}{' '}
                  {t('tentativi')} · {run.evaluation?.model.timings.structuringMs || 0} ms
                </p>
              </div>

              {!diagnostic.bundle.context ? (
                <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  {t(
                    'Nessun transcript è entrato nel contesto. La valutazione dei modelli non è stata eseguita per evitare due chiamate inutili.'
                  )}
                </p>
              ) : null}
            </section>

            {selectedClip ? (
              <section aria-labelledby="youtube-lab-clips-title">
                <h2 id="youtube-lab-clips-title" className="font-serif text-2xl">
                  {t('Anteprima video')}
                </h2>
                <article className="mt-3 max-w-3xl overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                  <iframe
                    title={selectedClip.title}
                    src={selectedClip.embedUrl}
                    className="aspect-video w-full"
                    allowFullScreen
                  />
                  <div className="p-4">
                    <h3 className="font-semibold">{selectedClip.title}</h3>
                    <p className="mt-1 text-sm text-stone-600 dark:text-zinc-400">
                      {selectedClip.note || t('Nessuna motivazione restituita.')}
                    </p>
                    {selectedClip.isDiagnosticFallback ? (
                      <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
                        {t('Intervallo di anteprima; la stesura sceglie quello definitivo')}
                      </p>
                    ) : null}
                    <p className="mt-2 flex items-center gap-1 text-xs text-stone-500 dark:text-zinc-400">
                      <Clock3 className="h-3.5 w-3.5" />
                      {selectedClip.startSeconds}–{selectedClip.endSeconds}s
                    </p>
                  </div>
                </article>
              </section>
            ) : (
              <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                {t('Nessun intervallo YouTube timestampato disponibile per l’anteprima.')}
              </p>
            )}

            {run.evaluation ? (
              <section aria-labelledby="youtube-lab-model-decisions-title">
                <h2 id="youtube-lab-model-decisions-title" className="font-serif text-2xl">
                  {t('Decisioni isolate del modello')}
                </h2>
                <p className="mt-1 text-sm text-stone-500 dark:text-zinc-400">
                  {t(
                    'Per ogni candidato mostra l’esito strutturato e la motivazione sintetica restituita dal modello.'
                  )}
                </p>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  {run.evaluation.youtubeCandidateDecisions.map(decision => {
                    const candidate = diagnostic.candidates.find(
                      item =>
                        extractYouTubeVideoId(item.url) === extractYouTubeVideoId(decision.url)
                    );
                    return (
                      <article
                        key={decision.url}
                        className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        <p className="text-xs font-semibold uppercase tracking-wide text-orange-700 dark:text-orange-300">
                          {getModelDecisionLabel(decision.decision)}
                        </p>
                        <h3 className="mt-1 font-semibold">{candidate?.title || decision.url}</h3>
                        <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-zinc-300">
                          {decision.reason}
                        </p>
                      </article>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <section aria-labelledby="youtube-lab-candidates-title">
              <h2 id="youtube-lab-candidates-title" className="font-serif text-2xl">
                {t('Candidati e decisioni')}
              </h2>
              <p className="mt-1 text-sm text-stone-500 dark:text-zinc-400">
                {t(
                  'Discovery attuale: {videos} video complessivi da {playlists} playlist. I transcript continuano finché c’è budget, con concorrenza {concurrency}.',
                  {
                    videos: diagnostic.limits.discoveryVideos,
                    playlists: diagnostic.limits.playlistResults,
                    concurrency: diagnostic.limits.transcriptConcurrency,
                  }
                )}
              </p>
              <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                {t(
                  'Limite noto: il web search dipende ancora dal provider attivo; questo laboratorio isola la pipeline YouTube.'
                )}
              </p>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {diagnostic.candidates.map(candidate => (
                  <CandidateCard
                    key={`${candidate.kind}-${candidate.id}`}
                    candidate={candidate}
                    evaluation={run.evaluation}
                  />
                ))}
              </div>
            </section>

            {run.evaluation ? (
              <section className="grid gap-3 lg:grid-cols-2">
                <details className="rounded-2xl border border-stone-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                  <summary className="cursor-pointer p-4 font-semibold">
                    {t('Brief di ricerca reale')}
                  </summary>
                  <div className="max-h-[32rem] overflow-auto whitespace-pre-wrap border-t border-stone-200 p-4 text-sm leading-6 dark:border-zinc-700">
                    {run.evaluation.researchBrief}
                  </div>
                </details>
                <details className="rounded-2xl border border-stone-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                  <summary className="cursor-pointer p-4 font-semibold">
                    {t('Contesto transcript inviato')}
                  </summary>
                  <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap border-t border-stone-200 p-4 text-xs leading-5 dark:border-zinc-700">
                    {diagnostic.bundle.context}
                  </pre>
                </details>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
