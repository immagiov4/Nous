import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FlaskConical,
  Search,
  XCircle,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type AdminYouTubeResearchCandidate,
  type AdminYouTubeResearchLabResult,
  type AdminYouTubeTranscriptOverride,
  runAdminYouTubeResearchLab,
} from '../../services/admin/adminApi.ts';
import { readSupabaseAccessRole, readSupabaseSession } from '../../services/auth/supabaseAuth.ts';
import {
  evaluateYouTubeResearchLab,
  type YouTubeResearchLabEvaluation,
} from '../../services/openrouter/research.ts';
import {
  buildLessonYouTubeResearchQuery,
  readYouTubeTranscriptOverrides,
  saveYouTubeTranscriptOverrides,
} from '../../services/openrouter/youtubeResearchClient.ts';
import { buildYouTubeClipEmbedUrl, extractYouTubeVideoId } from '../../utils/youtube.ts';

interface LabRun {
  evaluation: YouTubeResearchLabEvaluation | null;
  research: AdminYouTubeResearchLabResult;
}

const fieldClassName =
  'w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-950 outline-none transition-colors focus:border-orange-500 focus:ring-1 focus:ring-orange-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100';
const TRANSCRIPT_OVERRIDE_LIMITS = {
  languageLength: 32,
  overrides: 30,
  segmentDurationSeconds: 24 * 60 * 60,
  segmentTextLength: 2_000,
  segments: 5_000,
  timestampSeconds: 7 * 24 * 60 * 60,
  totalCharacters: 1_000_000,
  videoIdLength: 128,
} as const;

const isValidTranscriptSegment = (segment: unknown): boolean => {
  if (typeof segment !== 'object' || segment === null) return false;
  const value = segment as Record<string, unknown>;
  return (
    typeof value.text === 'string' &&
    value.text.trim() !== '' &&
    value.text.trim().length <= TRANSCRIPT_OVERRIDE_LIMITS.segmentTextLength &&
    typeof value.startSeconds === 'number' &&
    Number.isFinite(value.startSeconds) &&
    value.startSeconds >= 0 &&
    value.startSeconds <= TRANSCRIPT_OVERRIDE_LIMITS.timestampSeconds &&
    (value.durationSeconds === undefined ||
      (typeof value.durationSeconds === 'number' &&
        Number.isFinite(value.durationSeconds) &&
        value.durationSeconds >= 0 &&
        value.durationSeconds <= TRANSCRIPT_OVERRIDE_LIMITS.segmentDurationSeconds))
  );
};

const parseTranscriptOverrides = (value: string): AdminYouTubeTranscriptOverride[] | undefined => {
  if (!value.trim()) return undefined;

  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > TRANSCRIPT_OVERRIDE_LIMITS.overrides) {
    throw new Error('invalid transcript overrides');
  }

  const videoIds = new Set<string>();
  let totalCharacters = 0;
  for (const override of parsed) {
    if (typeof override !== 'object' || override === null) {
      throw new Error('invalid transcript overrides');
    }
    const videoId = typeof override.videoId === 'string' ? override.videoId.trim() : '';
    const language = override.language;
    if (
      !videoId ||
      videoId.length > TRANSCRIPT_OVERRIDE_LIMITS.videoIdLength ||
      videoIds.has(videoId) ||
      (language !== undefined &&
        (typeof language !== 'string' ||
          !language.trim() ||
          language.trim().length > TRANSCRIPT_OVERRIDE_LIMITS.languageLength)) ||
      !Array.isArray(override.segments) ||
      !override.segments.length ||
      override.segments.length > TRANSCRIPT_OVERRIDE_LIMITS.segments ||
      !override.segments.every(isValidTranscriptSegment)
    ) {
      throw new Error('invalid transcript overrides');
    }
    totalCharacters += override.segments.reduce(
      (sum: number, segment: { text: string }) => sum + segment.text.trim().length,
      0
    );
    if (totalCharacters > TRANSCRIPT_OVERRIDE_LIMITS.totalCharacters) {
      throw new Error('invalid transcript overrides');
    }
    videoIds.add(videoId);
  }
  if (!parsed.length) return undefined;
  return parsed as AdminYouTubeTranscriptOverride[];
};

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
    'transcript-not-requested': t('Non interrogato dopo un blocco o budget esaurito'),
  } as const;
  return labels[candidate.decision];
};

const getTranscriptAttemptLabel = (
  outcome: AdminYouTubeResearchCandidate['transcriptAttempts'][number]['outcome']
): string =>
  ({
    available: t('disponibile'),
    empty: t('vuoto'),
    'ip-blocked': t('IP bloccato'),
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
    'selected-clip': t('Scelto come clip pratica'),
    'selected-source': t('Scelto come fonte, senza clip'),
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
  const blockedAttempt = candidate.transcriptAttempts.some(
    attempt => attempt.outcome === 'ip-blocked'
  );

  return (
    <article className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-zinc-400">
            <span className="rounded-full bg-stone-100 px-2 py-1 font-semibold uppercase dark:bg-zinc-800">
              {candidate.kind}
            </span>
            <span>#{candidate.id}</span>
            <span>
              {t('punteggio')} {candidate.rankScore.toFixed(1)}
            </span>
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

      {blockedAttempt ? (
        <p className="mt-3 flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t('YouTube sta bloccando i transcript per questo IP.')}
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
            {candidate.transcript.text}
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
  const [transcriptOverridesJson, setTranscriptOverridesJson] = useState(() => {
    const savedOverrides = readYouTubeTranscriptOverrides();
    return savedOverrides.length ? JSON.stringify(savedOverrides, null, 2) : '';
  });
  const [run, setRun] = useState<LabRun | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [stage, setStage] = useState('');
  const session = readSupabaseSession();
  const sessionRole = session ? readSupabaseAccessRole(session.accessToken) : null;
  const hasAdminAccess = sessionRole === 'admin';

  useEffect(() => {
    if (!hasAdminAccess) {
      window.location.replace('/');
    }
  }, [hasAdminAccess]);

  const query = useMemo(
    () =>
      buildLessonYouTubeResearchQuery({
        courseTitle: lessonGoal.trim() ? topic.trim() : '',
        lessonDescription: lessonGoal,
        lessonTitle: lessonGoal.trim() || topic.trim(),
      }),
    [lessonGoal, topic]
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!query) return;

    setErrorMessage('');
    setRun(null);
    let transcriptOverrides: AdminYouTubeTranscriptOverride[] | undefined;
    try {
      transcriptOverrides = parseTranscriptOverrides(transcriptOverridesJson);
    } catch {
      setErrorMessage(t('Il JSON dei transcript non è valido. Controlla videoId e segmenti.'));
      return;
    }
    setIsRunning(true);
    try {
      setStage(t('Ricerca e transcript reali…'));
      const research = await runAdminYouTubeResearchLab({
        contextWindowTokens,
        language,
        nonYouTubePromptTokens,
        query,
        reservedOutputTokens,
        ...(transcriptOverrides ? { transcriptOverrides } : {}),
      });
      if (transcriptOverrides) {
        saveYouTubeTranscriptOverrides(transcriptOverrides);
      }
      setRun({ evaluation: null, research });
      const hasTranscriptContext = Boolean(research.diagnostic.bundle.context);
      if (!hasTranscriptContext) {
        return;
      }

      setStage(t('Valutazione con i modelli di produzione…'));
      const evaluation = await evaluateYouTubeResearchLab({
        language,
        lessonGoal,
        topic,
        youtubeResearch: {
          context: research.diagnostic.bundle.context,
          videoCandidates: research.diagnostic.bundle.videoCandidates,
          videoClipsEnabled: true,
        },
      });
      setRun({ evaluation, research });
    } catch (error) {
      console.warn('[Nous] YouTube research lab failed:', error);
      setErrorMessage(t('Laboratorio YouTube non disponibile.'));
    } finally {
      setIsRunning(false);
      setStage('');
    }
  };

  const selectedClips =
    run?.evaluation?.dossier.sources.flatMap(source => {
      const clip = source.videoClip;
      const embedUrl = clip
        ? buildYouTubeClipEmbedUrl(source.url || '', clip.startSeconds, clip.endSeconds)
        : null;
      return clip && embedUrl ? [{ embedUrl, source }] : [];
    }) || [];
  const diagnostic = run?.research.diagnostic;
  const blockedCount =
    diagnostic?.candidates.filter(candidate =>
      candidate.transcriptAttempts.some(attempt => attempt.outcome === 'ip-blocked')
    ).length || 0;

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
                  'Esegue la stessa ricerca, raccolta transcript e selezione usata per una lezione. Non salva nulla.'
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
                'Ogni transcript usa al massimo min(20% W, 50% B); se è più lungo vengono scelte le finestre più pertinenti.'
              )}
            </p>
          </fieldset>
          <details className="rounded-xl border border-stone-200 p-3 dark:border-zinc-700">
            <summary className="cursor-pointer text-sm font-semibold">
              {t('Transcript dal browser (opzionale)')}
            </summary>
            <label className="mt-3 block">
              <span className="text-xs leading-5 text-stone-500 dark:text-zinc-400">
                {t(
                  'Incolla un array JSON. Verrà usato anche nelle successive generazioni di corsi e lezioni.'
                )}
              </span>
              <textarea
                value={transcriptOverridesJson}
                onChange={event => setTranscriptOverridesJson(event.target.value)}
                className={`${fieldClassName} mt-2 min-h-40 resize-y font-mono`}
                placeholder={
                  '[{"videoId":"dQw4w9WgXcQ","language":"it","segments":[{"text":"Testo","startSeconds":0,"durationSeconds":4}]}]'
                }
                spellCheck={false}
              />
            </label>
          </details>
          <div className="rounded-xl bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:bg-zinc-800 dark:text-zinc-300">
            <span className="font-semibold">{t('Query reale')}:</span> {query || '—'}
          </div>
          <button
            type="submit"
            disabled={isRunning || !query}
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
                    {t('Clip in produzione')}
                  </span>
                </div>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  [t('Tempo totale CLI'), `${diagnostic.timings.totalMs} ms`],
                  [t('Candidati'), String(diagnostic.candidates.length)],
                  [
                    t('Tentativi CLI transcript'),
                    String(diagnostic.operations.transcriptCommandAttempts),
                  ],
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

              {blockedCount ? (
                <p className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {t('YouTube ha bloccato i transcript per {blockedCount} candidati.', {
                    blockedCount,
                  })}
                </p>
              ) : null}

              {diagnostic.circuitOpened ? (
                <p className="mt-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  {t(
                    'Circuito transcript aperto: blocco IP rilevato. I candidati successivi non sono stati interrogati.'
                  )}
                </p>
              ) : null}

              {!diagnostic.bundle.context ? (
                <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  {t(
                    'Nessun transcript è entrato nel contesto. La valutazione dei modelli non è stata eseguita per evitare due chiamate inutili.'
                  )}
                </p>
              ) : null}
            </section>

            {selectedClips.length ? (
              <section aria-labelledby="youtube-lab-clips-title">
                <h2 id="youtube-lab-clips-title" className="font-serif text-2xl">
                  {t('Clip scelte')}
                </h2>
                <div className="mt-3 grid gap-4 lg:grid-cols-2">
                  {selectedClips.map(({ embedUrl, source }) => (
                    <article
                      key={`${source.url}-${source.videoClip?.startSeconds}`}
                      className="overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <iframe
                        title={source.title}
                        src={embedUrl}
                        className="aspect-video w-full"
                        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                      />
                      <div className="p-4">
                        <h3 className="font-semibold">{source.title}</h3>
                        <p className="mt-1 text-sm text-stone-600 dark:text-zinc-400">
                          {source.note || t('Nessuna motivazione restituita.')}
                        </p>
                        <p className="mt-2 flex items-center gap-1 text-xs text-stone-500 dark:text-zinc-400">
                          <Clock3 className="h-3.5 w-3.5" />
                          {source.videoClip?.startSeconds}–{source.videoClip?.endSeconds}s
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            <section aria-labelledby="youtube-lab-candidates-title">
              <h2 id="youtube-lab-candidates-title" className="font-serif text-2xl">
                {t('Candidati e decisioni')}
              </h2>
              <p className="mt-1 text-sm text-stone-500 dark:text-zinc-400">
                {t(
                  'Discovery attuale: {videos} video, {playlists} playlist e fino a {playlistVideos} video per playlist. I transcript continuano finché c’è budget, con concorrenza {concurrency}.',
                  {
                    videos: diagnostic.limits.discoveryVideos,
                    playlists: diagnostic.limits.playlistResults,
                    playlistVideos: diagnostic.limits.playlistVideos,
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
