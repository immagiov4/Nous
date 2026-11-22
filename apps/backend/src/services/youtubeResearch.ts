import { formatYouTubeTranscript, type YouTubeTranscriptSegment } from '@shared/youtubeTranscript';
import { APICallError } from 'ai';
import { readRetryAfterMs } from '../workflows/retryPolicy.js';

const VIDEO_RESULT_LIMIT = 6;
const PLAYLIST_RESULT_LIMIT = 2;
const TRANSCRIPT_CONCURRENCY = 2;
const ESTIMATED_CHARACTERS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 32_000;
const DEFAULT_NON_YOUTUBE_PROMPT_TOKENS = 8_000;
const TRANSCRIPT_CACHE_MAX_ENTRIES = 200;
const TRANSCRIPT_CACHE_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const TRANSCRIPT_CACHE_FAILURE_TTL_MS = 15 * 60 * 1000;
const APIFY_API_URL = 'https://api.apify.com/v2';
// Apify's maximum long-poll interval, not a research deadline.
const APIFY_WAIT_FOR_FINISH_SECONDS = 60;
const APIFY_RESEARCH_DEADLINE_MS = 90_000;
const APIFY_DATASET_RETRY_LIMIT = 2;
const APIFY_DATASET_RETRY_DELAY_MS = 3_000;
// Apify's 429 guidance starts at 500 ms and doubles the base after each rate limit.
const APIFY_RATE_LIMIT_BACKOFF_MS = 500;

type YouTubeCandidateKind = 'playlist' | 'video';
type YouTubeTranscriptKind = 'automatic' | 'manual' | 'translated';

export interface YouTubeCandidate {
  availableLanguages?: string[];
  channelTitle: string;
  channelVerified: boolean;
  durationSeconds?: number;
  id: string;
  kind: YouTubeCandidateKind;
  playlistId?: string;
  playlistVideos?: YouTubeCandidate[];
  playlistPosition?: number;
  publishedAt?: number;
  title: string;
  url: string;
  viewCount?: number;
}

export interface YouTubeTranscript {
  kind: YouTubeTranscriptKind;
  language: string;
  segments: YouTubeTranscriptSegment[];
}

export interface YouTubeTranscriptAttempt {
  durationMs: number;
  kind: YouTubeTranscriptKind;
  language: string;
  outcome: 'available' | 'empty' | 'unavailable';
}

export interface YouTubeTranscriptLookup {
  attempts: YouTubeTranscriptAttempt[];
  cached?: boolean;
  transcript: YouTubeTranscript | null;
}

export interface YouTubeVideoEvidence {
  commentCount?: number;
  likeCount?: number;
  segments: YouTubeTranscriptSegment[];
  title: string;
  url: string;
  viewCount?: number;
}

export interface YouTubeResearchBundle {
  context: string;
  videoCandidates: YouTubeVideoEvidence[];
}

export interface YouTubeResearchOutcome extends YouTubeResearchBundle {
  discoveredVideoCount: number;
  rationale: string;
}

export type YouTubeResearchCandidateDecision =
  | 'context-included'
  | 'no-transcript'
  | 'playlist-expanded'
  | 'playlist-expansion-failed'
  | 'transcript-budget'
  | 'transcript-not-requested';

export interface YouTubeResearchDiagnosticCandidate extends YouTubeCandidate {
  decision: YouTubeResearchCandidateDecision;
  origins: Array<'playlist' | 'search'>;
  estimatedTokens?: number;
  includedTokens?: number;
  transcript?: {
    characterCount: number;
    kind: YouTubeTranscriptKind;
    language: string;
    segments: YouTubeTranscriptSegment[];
    segmentCount: number;
  };
  transcriptAttempts: YouTubeTranscriptAttempt[];
  transcriptCached?: boolean;
  transcriptLookupMs?: number;
}

export interface YouTubeResearchDiagnostic {
  budget: {
    contextWindowTokens: number;
    nonYouTubePromptTokens: number;
    perTranscriptMaxTokens: number;
    remainingTokens: number;
    reservedOutputTokens: number;
    residualTokens: number;
    transcriptBudgetTokens: number;
    usedTokens: number;
  };
  bundle: YouTubeResearchBundle;
  candidates: YouTubeResearchDiagnosticCandidate[];
  errors: Array<'playlist-expansion-failed' | 'provider-item-unavailable'>;
  limits: {
    discoveryVideos: number;
    playlistResults: number;
    transcriptConcurrency: number;
  };
  operations: {
    discoveryRequests: number;
    playlistPreviewsExpanded: number;
    transcriptRequests: number;
    transcriptLookups: number;
  };
  preferredLanguages: string[];
  query: string;
  timings: {
    discoveryMs: number;
    playlistExpansionMs: number;
    totalMs: number;
    transcriptsMs: number;
  };
}

export interface YouTubeResearchBudgetInput {
  contextWindowTokens?: number;
  nonYouTubePromptTokens?: number;
  reservedOutputTokens?: number;
}

export interface YouTubeResearchOptions {
  budget?: YouTubeResearchBudgetInput;
  discovery?: YouTubeDiscoveryProvider;
  includeEngagementMetadata?: boolean;
  metadata?: YouTubeMetadataProvider;
  signal?: AbortSignal;
  transcripts?: YouTubeTranscriptProvider;
}

export interface YouTubeDiscoveryProvider {
  expandPlaylist(candidate: YouTubeCandidate, signal?: AbortSignal): Promise<YouTubeCandidate[]>;
  search(
    query: string,
    signal?: AbortSignal,
    onItemUnavailable?: () => void
  ): Promise<YouTubeCandidate[]>;
}

export interface YouTubeTranscriptProvider {
  getTranscriptDiagnostic?(
    videoId: string,
    preferredLanguages: string[],
    signal?: AbortSignal
  ): Promise<YouTubeTranscriptLookup>;
  getTranscript(
    videoId: string,
    preferredLanguages: string[],
    signal?: AbortSignal
  ): Promise<YouTubeTranscript | null>;
}

export interface YouTubeVideoMetadata {
  commentCount?: number;
  likeCount?: number;
  viewCount?: number;
}

export interface YouTubeMetadataProvider {
  getMetadata(videoId: string, signal?: AbortSignal): Promise<YouTubeVideoMetadata>;
}

interface TranscriptCacheEntry {
  expiresAt: number;
  lookup: YouTubeTranscriptLookup;
}

const sharedApifyTranscriptCache = new Map<string, TranscriptCacheEntry>();

export class ApifyProviderError extends APICallError {
  readonly responseHeaders: Record<string, string>;
  readonly status: number;

  constructor(
    readonly code: string,
    status: number,
    headers = new Headers(),
    isRetryable?: boolean
  ) {
    super({
      isRetryable,
      message: `Apify YouTube request failed: ${code} (HTTP ${status}).`,
      requestBodyValues: {},
      statusCode: status,
      url: APIFY_API_URL,
    });
    this.name = 'ApifyProviderError';
    this.status = status;
    this.responseHeaders = Object.fromEntries(
      ['retry-after', 'retry-after-ms'].flatMap(name => {
        const value = headers.get(name)?.trim();
        return value ? [[name, value]] : [];
      })
    );
  }
}

class ApifyCompletedDatasetError extends ApifyProviderError {
  constructor(code: string, status: number) {
    super(code, status, undefined, false);
  }
}

export const isTerminalYouTubeProviderFailure = (error: unknown): error is ApifyProviderError =>
  error instanceof ApifyCompletedDatasetError ||
  (error instanceof ApifyProviderError && error.code === 'youtube_provider_allowance_exhausted');

const failCompletedDatasetRead = (error: unknown): never => {
  // This Actor has completed, so the workflow must not start it again.
  if (error instanceof ApifyProviderError && !(error instanceof ApifyCompletedDatasetError)) {
    throw new ApifyCompletedDatasetError(error.code, error.status);
  }
  throw error;
};

const isTransientDatasetReadFailure = (error: unknown): error is APICallError =>
  APICallError.isInstance(error) &&
  error.isRetryable &&
  !(
    error instanceof ApifyProviderError &&
    ['youtube_provider_allowance_exhausted', 'youtube_provider_invalid_response'].includes(
      error.code
    )
  ) &&
  (error.statusCode === undefined || error.statusCode === 429 || error.statusCode >= 500);

const waitForDatasetRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
  });

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asOptionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const apifyRefusalCode = (status: number, payload: unknown): string => {
  const type = asString(asRecord(asRecord(payload)?.error)?.type);
  if (
    type === 'monthly-usage-hard-limit-reached' ||
    type === 'not-enough-usage-to-run-paid-actor'
  ) {
    return 'youtube_provider_allowance_exhausted';
  }
  // Apify also uses this 402 for requests lacking payment credentials.
  if (status === 402 && type === 'x402-payment-required')
    return 'youtube_provider_payment_required';
  if (status === 401) return 'youtube_provider_authentication_failed';
  if (status === 429) return 'youtube_provider_rate_limited';
  return 'youtube_provider_refused';
};

const isApifyCandidateStatus = (status: unknown): boolean =>
  status === 'ok' || status === 'no_transcript';

// The TubeText output schema lists ok, no_transcript and error. The README also
// documents too_long_for_ai and groups restricted or captionless videos under no_transcript.
const APIFY_ITEM_STATUSES = new Set<unknown>(['ok', 'no_transcript', 'error', 'too_long_for_ai']);

const isApifyDatasetItem = (value: unknown): value is Record<string, unknown> => {
  const item = asRecord(value);
  return Boolean(item && asString(item.videoId) && APIFY_ITEM_STATUSES.has(item.status));
};

const primaryLanguageCode = (language: string): string => language.toLowerCase().split(/[-_]/)[0];

const readApifyTranscript = (
  item: Record<string, unknown>,
  preferredLanguages: string[]
): YouTubeTranscript | null => {
  if (item.status === 'no_transcript') return null;
  const language = asString(item.language);
  const primaryLanguage = primaryLanguageCode(language);
  if (
    language &&
    !preferredLanguages.some(preferred => primaryLanguageCode(preferred) === primaryLanguage)
  ) {
    return null;
  }
  const segments = (Array.isArray(item.segments) ? item.segments : []).flatMap(value => {
    const segment = asRecord(value);
    const start = asOptionalNumber(segment?.start);
    const duration = asOptionalNumber(segment?.duration);
    const text = asString(segment?.text);
    return start !== undefined && start >= 0 && duration !== undefined && duration > 0 && text
      ? [{ startSeconds: start, endSeconds: start + duration, text }]
      : [];
  });
  if (!language || !segments.length) {
    throw new ApifyCompletedDatasetError('youtube_provider_invalid_transcript', 502);
  }
  return {
    kind:
      item.isTranslation === true
        ? 'translated'
        : item.isAutoGenerated === true
          ? 'automatic'
          : 'manual',
    language,
    segments,
  };
};

/** One search run supplies discovery, transcripts and engagement without per-video paid calls. */
export class ApifyYouTubeProvider
  implements YouTubeDiscoveryProvider, YouTubeTranscriptProvider, YouTubeMetadataProvider
{
  private readonly activeLookupCounts = new Map<string, number>();
  private readonly cache: Map<string, TranscriptCacheEntry>;
  private readonly searchLookups = new Map<string, TranscriptCacheEntry>();
  private readonly metadata = new Map<string, YouTubeVideoMetadata>();

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly preferredLanguages: string[] = ['it', 'en']
  ) {
    this.cache = fetcher === fetch ? sharedApifyTranscriptCache : new Map();
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    init.signal?.throwIfAborted();
    try {
      const response = await this.fetcher(`${APIFY_API_URL}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      });
      init.signal?.throwIfAborted();
      const payload: unknown = await response.json().catch(error => {
        if (!response.ok || error instanceof SyntaxError) return null;
        throw error;
      });
      init.signal?.throwIfAborted();
      if (!response.ok)
        throw new ApifyProviderError(
          apifyRefusalCode(response.status, payload),
          response.status,
          response.headers
        );
      if (payload === null) throw new ApifyProviderError('youtube_provider_invalid_response', 502);
      return payload;
    } catch (error) {
      init.signal?.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
      throw new APICallError({
        message: 'Apify transport unavailable.',
        cause: new TypeError('Apify transport failed.'),
        isRetryable: true,
        requestBodyValues: {},
        url: APIFY_API_URL,
      });
    }
  }

  private async run(
    input: Record<string, unknown>,
    languages: string[],
    signal?: AbortSignal
  ): Promise<Record<string, unknown>[]> {
    const deadlineAt = Date.now() + APIFY_RESEARCH_DEADLINE_MS;
    const deadline = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => {
      deadline.abort(new ApifyProviderError('youtube_provider_deadline_exceeded', 504));
    }, APIFY_RESEARCH_DEADLINE_MS);

    try {
      return await this.fetchRunDataset(input, languages, runSignal, deadlineAt);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchRunDataset(
    input: Record<string, unknown>,
    languages: string[],
    signal: AbortSignal,
    deadlineAt: number
  ): Promise<Record<string, unknown>[]> {
    // Get the run ID before long-polling so cancellation can stop the remote work.
    let run = asRecord(
      asRecord(
        await this.request('/acts/tubetext~youtube-transcript-fast/runs', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            ...input,
            maxVideosPerSource: VIDEO_RESULT_LIMIT,
            languages,
            preferManualCaptions: true,
            includeSegments: true,
            includeTimestampedText: false,
            aiFallback: false,
          }),
        })
      )?.data
    );
    const runId = asString(run?.id);
    if (!runId) throw new ApifyProviderError('youtube_provider_invalid_run', 502);
    try {
      while (['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(asString(run?.status))) {
        run = asRecord(
          asRecord(
            await this.request(
              `/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${APIFY_WAIT_FOR_FINISH_SECONDS}`,
              { signal }
            )
          )?.data
        );
      }
    } catch (error) {
      if (signal.aborted) {
        void this.request(`/actor-runs/${encodeURIComponent(runId)}/abort`, {
          method: 'POST',
        }).catch(() => console.warn('[Backend] YouTube provider cancellation unavailable.'));
      }
      throw error;
    }
    if (run?.status !== 'SUCCEEDED')
      throw new ApifyProviderError('youtube_provider_run_failed', 502);
    const datasetId = asString(run.defaultDatasetId);
    if (!datasetId) throw new ApifyCompletedDatasetError('youtube_provider_invalid_dataset', 502);
    const path = `/datasets/${encodeURIComponent(datasetId)}/items?clean=true`;
    const items = await this.readCompletedDataset(path, signal, deadlineAt).catch(
      failCompletedDatasetRead
    );
    if (!Array.isArray(items) || !items.every(isApifyDatasetItem)) {
      throw new ApifyCompletedDatasetError('youtube_provider_invalid_dataset', 502);
    }
    return items;
  }

  private async readCompletedDataset(
    path: string,
    signal: AbortSignal,
    deadlineAt: number
  ): Promise<unknown> {
    let rateLimits = 0;
    for (let retries = 0; ; retries += 1) {
      try {
        return await this.request(path, { signal });
      } catch (error) {
        signal.throwIfAborted();
        if (!isTransientDatasetReadFailure(error)) throw error;
        if (retries === APIFY_DATASET_RETRY_LIMIT) {
          throw new ApifyCompletedDatasetError(
            'youtube_provider_dataset_unavailable',
            error.statusCode ?? 502
          );
        }
        const defaultDelay =
          error.statusCode === 429
            ? Math.floor(APIFY_RATE_LIMIT_BACKOFF_MS * 2 ** rateLimits++ * (1 + Math.random()))
            : APIFY_DATASET_RETRY_DELAY_MS;
        const delay = readRetryAfterMs(error) ?? defaultDelay;
        if (delay >= deadlineAt - Date.now()) {
          throw new ApifyCompletedDatasetError('youtube_provider_deadline_exceeded', 504);
        }
        await waitForDatasetRetry(delay, signal);
      }
    }
  }

  async search(
    query: string,
    signal?: AbortSignal,
    onItemUnavailable?: () => void
  ): Promise<YouTubeCandidate[]> {
    const startedAt = Date.now();
    const items = await this.run(
      { searchQueries: [query], searchSortBy: 'relevance', searchPublishedWithin: 'any' },
      this.preferredLanguages,
      signal
    );
    const candidates = items.filter(item => {
      if (item.status === 'ok' || (item.status === 'no_transcript' && asString(item.title))) {
        return true;
      }
      onItemUnavailable?.();
      return false;
    });
    const results = candidates.map(item => {
      if (!asString(item.title))
        throw new ApifyCompletedDatasetError('youtube_provider_invalid_candidate', 502);
      return { item, transcript: readApifyTranscript(item, this.preferredLanguages) };
    });
    this.searchLookups.clear();
    return results.map(({ item, transcript }) => {
      const id = asString(item.videoId);
      const title = asString(item.title);
      this.storeLookup(
        id,
        this.preferredLanguages,
        this.toLookup(transcript, startedAt, this.preferredLanguages)
      );
      this.metadata.set(id, {
        viewCount: asOptionalNumber(item.viewCount),
        likeCount: asOptionalNumber(item.likeCount),
        commentCount: asOptionalNumber(item.commentCount),
      });
      return {
        id,
        title,
        kind: 'video',
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
        channelTitle: asString(item.channelName),
        channelVerified: false,
        durationSeconds: asOptionalNumber(item.durationSeconds),
        viewCount: asOptionalNumber(item.viewCount),
        availableLanguages: Array.isArray(item.availableLanguages)
          ? item.availableLanguages.filter(
              (language): language is string => typeof language === 'string'
            )
          : [],
      };
    });
  }

  async expandPlaylist(candidate: YouTubeCandidate): Promise<YouTubeCandidate[]> {
    return candidate.kind === 'playlist' ? candidate.playlistVideos || [] : [candidate];
  }

  async getMetadata(videoId: string, signal?: AbortSignal): Promise<YouTubeVideoMetadata> {
    signal?.throwIfAborted();
    return this.metadata.get(videoId) || {};
  }

  private toLookup(
    transcript: YouTubeTranscript | null,
    startedAt: number,
    languages: string[],
    emptyOutcome: 'empty' | 'unavailable' = 'empty'
  ): YouTubeTranscriptLookup {
    return {
      attempts: [
        {
          durationMs: Date.now() - startedAt,
          kind: transcript?.kind || 'automatic',
          language: transcript?.language || languages[0] || 'en',
          outcome: transcript ? 'available' : emptyOutcome,
        },
      ],
      transcript,
    };
  }

  private storeLookup(videoId: string, languages: string[], lookup: YouTubeTranscriptLookup): void {
    const key = `${videoId}:${languages.join(',')}`;
    const now = Date.now();
    const entry = {
      expiresAt:
        now +
        (lookup.transcript ? TRANSCRIPT_CACHE_SUCCESS_TTL_MS : TRANSCRIPT_CACHE_FAILURE_TTL_MS),
      lookup,
    };
    this.searchLookups.set(key, entry);
    const current = this.cache.get(key);
    if (!lookup.transcript && current?.lookup.transcript && current.expiresAt > now) return;
    this.cache.set(key, entry);
    if (this.cache.size > TRANSCRIPT_CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
  }

  private async loadTranscriptDiagnostic(
    videoId: string,
    preferredLanguages: string[],
    signal?: AbortSignal
  ): Promise<YouTubeTranscriptLookup> {
    const startedAt = Date.now();
    const items = await this.run(
      { urls: [`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`] },
      preferredLanguages,
      signal
    );
    const item = items.find(item => item.videoId === videoId);
    return item && isApifyCandidateStatus(item.status)
      ? this.toLookup(readApifyTranscript(item, preferredLanguages), startedAt, preferredLanguages)
      : this.toLookup(null, startedAt, preferredLanguages, 'unavailable');
  }

  async getTranscriptDiagnostic(
    videoId: string,
    preferredLanguages: string[],
    signal?: AbortSignal
  ): Promise<YouTubeTranscriptLookup> {
    signal?.throwIfAborted();
    const cacheKey = `${videoId}:${preferredLanguages.join(',')}`;
    // Evidence from this search takes priority over captions cached by an earlier search.
    const searchLookup = this.searchLookups.get(cacheKey);
    if (searchLookup && searchLookup.expiresAt > Date.now()) {
      return { ...searchLookup.lookup, cached: true };
    }
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.lookup, cached: true };
    }
    if (cached) this.cache.delete(cacheKey);

    const activeLookupCount = (this.activeLookupCounts.get(cacheKey) ?? 0) + 1;
    this.activeLookupCounts.set(cacheKey, activeLookupCount);
    try {
      const lookup = await this.loadTranscriptDiagnostic(videoId, preferredLanguages, signal);
      signal?.throwIfAborted();
      const current = this.cache.get(cacheKey);
      const currentTranscriptIsUsable =
        current?.lookup.transcript && current.expiresAt > Date.now();
      if (
        lookup.transcript ||
        (this.activeLookupCounts.get(cacheKey) === 1 && !currentTranscriptIsUsable)
      ) {
        this.cache.set(cacheKey, {
          expiresAt:
            Date.now() +
            (lookup.transcript ? TRANSCRIPT_CACHE_SUCCESS_TTL_MS : TRANSCRIPT_CACHE_FAILURE_TTL_MS),
          lookup,
        });
      }
      if (this.cache.size > TRANSCRIPT_CACHE_MAX_ENTRIES) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
      return lookup;
    } finally {
      const remainingLookups = (this.activeLookupCounts.get(cacheKey) ?? 1) - 1;
      if (remainingLookups > 0) this.activeLookupCounts.set(cacheKey, remainingLookups);
      else this.activeLookupCounts.delete(cacheKey);
    }
  }

  async getTranscript(
    videoId: string,
    preferredLanguages: string[],
    signal?: AbortSignal
  ): Promise<YouTubeTranscript | null> {
    return (await this.getTranscriptDiagnostic(videoId, preferredLanguages, signal)).transcript;
  }
}

export const isYouTubeResearchConfigured = (): boolean => Boolean(process.env.APIFY_TOKEN?.trim());

const createDefaultYouTubeProvider = (languages: string[]): ApifyYouTubeProvider => {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured.');
  return new ApifyYouTubeProvider(token, fetch, languages);
};

const LANGUAGE_CODES: Record<string, string> = {
  deutsch: 'de',
  english: 'en',
  inglese: 'en',
  italiano: 'it',
  italian: 'it',
  français: 'fr',
  francese: 'fr',
  español: 'es',
  spagnolo: 'es',
};

const getPreferredLanguages = (language: string): string[] => {
  const normalized = language.trim().toLocaleLowerCase();
  const primary = LANGUAGE_CODES[normalized] || primaryLanguageCode(normalized) || 'it';
  return primary === 'en' ? ['en'] : [primary, 'en'];
};

const estimateTokens = (value: string): number =>
  Math.ceil(value.length / ESTIMATED_CHARACTERS_PER_TOKEN);

const fitTranscriptToBudget = (
  transcript: YouTubeTranscript,
  maxTokens: number
): {
  estimatedTokens: number;
  segments: YouTubeTranscriptSegment[];
} => {
  const segments = transcript.segments.flatMap(segment => {
    if (
      segment.startSeconds < 0 ||
      segment.endSeconds <= segment.startSeconds ||
      !segment.text.trim()
    ) {
      return [];
    }
    const startSeconds = Math.floor(segment.startSeconds);
    const endSeconds = Math.ceil(segment.endSeconds);
    return endSeconds > startSeconds
      ? [{ endSeconds, startSeconds, text: segment.text.trim() }]
      : [];
  });
  const text = formatYouTubeTranscript(segments);
  const estimatedTokens = estimateTokens(text);
  const fitsBudget = estimatedTokens <= maxTokens;
  return {
    estimatedTokens,
    segments: fitsBudget ? segments : [],
  };
};

const deduplicateVideos = (videos: YouTubeCandidate[]): YouTubeCandidate[] => [
  ...new Map(videos.map(video => [video.id, video])).values(),
];

const getCandidateOrigins = (
  videoId: string,
  searchVideos: YouTubeCandidate[],
  playlistVideos: YouTubeCandidate[]
): Array<'playlist' | 'search'> => [
  ...(searchVideos.some(video => video.id === videoId) ? (['search'] as const) : []),
  ...(playlistVideos.some(video => video.id === videoId) ? (['playlist'] as const) : []),
];

const getTranscriptLookup = async (
  provider: YouTubeTranscriptProvider,
  videoId: string,
  preferredLanguages: string[],
  signal?: AbortSignal
): Promise<YouTubeTranscriptLookup> =>
  provider.getTranscriptDiagnostic
    ? provider.getTranscriptDiagnostic(videoId, preferredLanguages, signal)
    : {
        attempts: [],
        transcript: await provider.getTranscript(videoId, preferredLanguages, signal),
      };

const readBudgetValue = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;

const calculateTranscriptBudget = (input: YouTubeResearchBudgetInput = {}) => {
  const contextWindowTokens = Math.max(
    1,
    readBudgetValue(input.contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS)
  );
  const reservedOutputTokens = Math.min(
    contextWindowTokens,
    readBudgetValue(input.reservedOutputTokens, DEFAULT_RESERVED_OUTPUT_TOKENS)
  );
  const nonYouTubePromptTokens = Math.min(
    contextWindowTokens - reservedOutputTokens,
    readBudgetValue(input.nonYouTubePromptTokens, DEFAULT_NON_YOUTUBE_PROMPT_TOKENS)
  );
  const residualTokens = Math.max(
    0,
    contextWindowTokens - reservedOutputTokens - nonYouTubePromptTokens
  );
  const transcriptBudgetTokens = residualTokens;
  return {
    contextWindowTokens,
    nonYouTubePromptTokens,
    perTranscriptMaxTokens: Math.floor(residualTokens * 0.5),
    remainingTokens: transcriptBudgetTokens,
    reservedOutputTokens,
    residualTokens,
    transcriptBudgetTokens,
    usedTokens: 0,
  };
};

const sanitizeTranscriptForPrompt = (value: string): string =>
  value.replaceAll(/<\/?youtube_sources>/gi, '[youtube_sources tag removed]');

export const mergeYouTubeResearchOutcomes = (
  outcomes: readonly YouTubeResearchOutcome[]
): YouTubeResearchOutcome => {
  const candidates = [
    ...new Map(
      outcomes
        .flatMap(outcome => outcome.videoCandidates)
        .map(candidate => [candidate.url, candidate])
    ).values(),
  ];
  const budget = calculateTranscriptBudget();
  const context: string[] = [];
  const videoCandidates: YouTubeVideoEvidence[] = [];

  for (const candidate of candidates) {
    const sourcePrefix = `SOURCE ${candidate.title}\nURL: ${candidate.url}\n`;
    const prefixTokens = estimateTokens(sourcePrefix);
    const availableTranscriptTokens = Math.max(
      0,
      Math.min(budget.perTranscriptMaxTokens, budget.remainingTokens - prefixTokens - 1)
    );
    const budgetedTranscript = fitTranscriptToBudget(
      { kind: 'manual', language: '', segments: candidate.segments },
      availableTranscriptTokens
    );
    const safeSegments = budgetedTranscript.segments.map(segment => ({
      ...segment,
      text: sanitizeTranscriptForPrompt(segment.text),
    }));
    const transcript = formatYouTubeTranscript(safeSegments);
    const source = `${sourcePrefix}${transcript}`;
    const sourceTokens = estimateTokens(source);
    if (!transcript || sourceTokens > budget.remainingTokens) continue;

    context.push(source);
    videoCandidates.push({ ...candidate, segments: safeSegments });
    budget.usedTokens += sourceTokens;
    budget.remainingTokens = Math.max(0, budget.transcriptBudgetTokens - budget.usedTokens);
  }

  return {
    context: context.join('\n\n'),
    discoveredVideoCount: outcomes.reduce(
      (total, outcome) => total + outcome.discoveredVideoCount,
      0
    ),
    rationale: [...new Set(outcomes.map(outcome => outcome.rationale.trim()).filter(Boolean))].join(
      ' '
    ),
    videoCandidates,
  };
};

const getDiscoveryLimits = (discovery: YouTubeDiscoveryProvider) => ({
  discoveryVideos: VIDEO_RESULT_LIMIT,
  playlistResults: discovery instanceof ApifyYouTubeProvider ? 0 : PLAYLIST_RESULT_LIMIT,
  transcriptConcurrency: TRANSCRIPT_CONCURRENCY,
});

const buildYouTubeResearch = async (
  query: string,
  language: string,
  options: YouTubeResearchOptions
): Promise<YouTubeResearchDiagnostic> => {
  options.signal?.throwIfAborted();
  const preferredLanguages = getPreferredLanguages(language);
  let provider: ApifyYouTubeProvider | undefined;
  const defaultProvider = () => (provider ??= createDefaultYouTubeProvider(preferredLanguages));
  const discovery = options.discovery || defaultProvider();
  const transcripts = options.transcripts || defaultProvider();
  let metadata = options.metadata;
  if (options.includeEngagementMetadata === false) {
    metadata = undefined;
  } else if (!metadata && !options.discovery && !options.transcripts) {
    metadata = defaultProvider();
  }
  const budget = calculateTranscriptBudget(options.budget);
  const startedAt = Date.now();
  const discoveryStartedAt = Date.now();
  const errors: YouTubeResearchDiagnostic['errors'] = [];
  const candidates = await discovery.search(query, options.signal, () => {
    errors.push('provider-item-unavailable');
  });
  options.signal?.throwIfAborted();
  const discoveryMs = Date.now() - discoveryStartedAt;
  const playlists = candidates
    .filter(candidate => candidate.kind === 'playlist')
    .slice(0, PLAYLIST_RESULT_LIMIT);
  const playlistStartedAt = Date.now();
  const playlistResults = await Promise.allSettled(
    playlists.map(playlist => discovery.expandPlaylist(playlist, options.signal))
  );
  options.signal?.throwIfAborted();
  const playlistExpansionMs = Date.now() - playlistStartedAt;
  const failedPlaylistIds = new Set<string>();
  const playlistVideos = playlistResults.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const playlist = playlists[index];
    if (playlist) failedPlaylistIds.add(playlist.id);
    console.warn('[Backend] YouTube playlist expansion unavailable:', result.reason);
    errors.push('playlist-expansion-failed');
    return [];
  });

  const searchVideos = candidates.filter(candidate => candidate.kind === 'video');
  const playlistVideosById = new Map(
    playlists.map((playlist, index) => [
      playlist.id,
      playlistResults[index]?.status === 'fulfilled' ? playlistResults[index].value : [],
    ])
  );
  const providerOrderedVideos = candidates.flatMap(candidate =>
    candidate.kind === 'video' ? [candidate] : playlistVideosById.get(candidate.id) || []
  );
  const videos = deduplicateVideos(providerOrderedVideos).slice(0, VIDEO_RESULT_LIMIT);
  const transcriptsStartedAt = Date.now();

  let context = '';
  const videoCandidates: YouTubeVideoEvidence[] = [];
  const diagnosticsByVideoId = new Map<string, YouTubeResearchDiagnosticCandidate>();
  for (const video of videos) {
    diagnosticsByVideoId.set(video.id, {
      ...video,
      decision: 'transcript-not-requested',
      origins: getCandidateOrigins(video.id, searchVideos, playlistVideos),
      transcriptAttempts: [],
    });
  }

  let transcriptLookups = 0;
  let transcriptRequests = 0;
  for (
    let index = 0;
    index < videos.length && budget.remainingTokens > 0;
    index += TRANSCRIPT_CONCURRENCY
  ) {
    options.signal?.throwIfAborted();
    const batch = videos.slice(index, index + TRANSCRIPT_CONCURRENCY);
    const enriched = await Promise.all(
      batch.map(async video => {
        const transcriptStartedAt = Date.now();
        const lookup = await getTranscriptLookup(
          transcripts,
          video.id,
          preferredLanguages,
          options.signal
        );
        return { ...lookup, transcriptLookupMs: Date.now() - transcriptStartedAt, video };
      })
    );
    options.signal?.throwIfAborted();
    transcriptLookups += enriched.length;
    transcriptRequests += enriched.reduce(
      (total, result) => total + (result.cached ? 0 : result.attempts.length),
      0
    );
    for (const { attempts, cached, transcript, transcriptLookupMs, video } of enriched) {
      const diagnostic = diagnosticsByVideoId.get(video.id);
      if (!diagnostic) continue;
      diagnostic.transcriptLookupMs = transcriptLookupMs;
      diagnostic.transcriptAttempts = attempts;
      diagnostic.transcriptCached = cached === true;
      if (!transcript) {
        diagnostic.decision = 'no-transcript';
        continue;
      }

      const playlistDetails = video.playlistId
        ? ` | playlist ${video.playlistId}, posizione ${video.playlistPosition}`
        : '';
      const sourcePrefix = `\nSOURCE ${video.title}\nURL: ${video.url}\nCanale: ${video.channelTitle || 'non disponibile'}${playlistDetails}\nTranscript: ${transcript.kind}, lingua ${transcript.language}\n`;
      const prefixTokens = estimateTokens(sourcePrefix);
      const availableTranscriptTokens = Math.max(
        0,
        Math.min(budget.perTranscriptMaxTokens, budget.remainingTokens - prefixTokens - 1)
      );
      const budgetedTranscript = fitTranscriptToBudget(transcript, availableTranscriptTokens);
      const safeSegments = budgetedTranscript.segments.map(segment => ({
        ...segment,
        text: sanitizeTranscriptForPrompt(segment.text),
      }));
      const safeTranscript = formatYouTubeTranscript(safeSegments);
      const source = `${sourcePrefix}${safeTranscript}\n`;
      const sourceTokens = estimateTokens(source);
      diagnostic.estimatedTokens = prefixTokens + budgetedTranscript.estimatedTokens;
      diagnostic.includedTokens = sourceTokens;
      diagnostic.transcript = {
        characterCount: safeTranscript.length,
        kind: transcript.kind,
        language: transcript.language,
        segments: safeSegments,
        segmentCount: transcript.segments.length,
      };
      if (!safeTranscript || sourceTokens > budget.remainingTokens) {
        diagnostic.decision = 'transcript-budget';
        diagnostic.includedTokens = 0;
        continue;
      }

      context += source;
      diagnostic.decision = 'context-included';
      budget.usedTokens += sourceTokens;
      budget.remainingTokens = Math.max(0, budget.transcriptBudgetTokens - budget.usedTokens);
      videoCandidates.push({
        segments: safeSegments,
        title: video.title,
        url: video.url,
      });
    }
  }
  const transcriptsMs = Date.now() - transcriptsStartedAt;
  if (metadata && videoCandidates.length > 0) {
    const metadataResults = await Promise.allSettled(
      videoCandidates.map(candidate => {
        const videoId = new URL(candidate.url).searchParams.get('v');
        return videoId ? metadata.getMetadata(videoId, options.signal) : Promise.resolve({});
      })
    );
    options.signal?.throwIfAborted();
    for (const [index, result] of metadataResults.entries()) {
      if (result.status !== 'fulfilled') {
        console.warn('[Backend] YouTube metadata unavailable:', result.reason);
        continue;
      }
      Object.assign(videoCandidates[index] ?? {}, result.value);
    }
  }

  const playlistDiagnostics = playlists.map(candidate => ({
    ...candidate,
    decision: failedPlaylistIds.has(candidate.id)
      ? ('playlist-expansion-failed' as const)
      : ('playlist-expanded' as const),
    origins: ['search'] as Array<'playlist' | 'search'>,
    transcriptAttempts: [],
  }));

  return {
    budget,
    bundle: { context: context.trim(), videoCandidates },
    candidates: [
      ...videos.flatMap(video => {
        const diagnostic = diagnosticsByVideoId.get(video.id);
        return diagnostic ? [diagnostic] : [];
      }),
      ...playlistDiagnostics,
    ],
    errors,
    limits: getDiscoveryLimits(discovery),
    operations: {
      discoveryRequests: 1,
      playlistPreviewsExpanded: playlists.length,
      transcriptRequests,
      transcriptLookups,
    },
    preferredLanguages,
    query,
    timings: {
      discoveryMs,
      playlistExpansionMs,
      totalMs: Date.now() - startedAt,
      transcriptsMs,
    },
  };
};

const summarizeYouTubeResearch = (diagnostic: YouTubeResearchDiagnostic): string => {
  const videoCandidates = diagnostic.candidates.filter(candidate => candidate.kind === 'video');
  const includedCount = videoCandidates.filter(
    candidate => candidate.decision === 'context-included'
  ).length;
  const noTranscriptCount = videoCandidates.filter(
    candidate => candidate.decision === 'no-transcript'
  ).length;
  const budgetCount = videoCandidates.filter(
    candidate => candidate.decision === 'transcript-budget'
  ).length;

  if (videoCandidates.length === 0) {
    return 'La ricerca non ha restituito video candidati.';
  }
  if (includedCount > 0) {
    return `${includedCount} video con transcript disponibile inclusi su ${videoCandidates.length} candidati valutati.`;
  }
  if (noTranscriptCount === videoCandidates.length) {
    return `Nessuno dei ${videoCandidates.length} video candidati disponeva di un transcript utilizzabile.`;
  }
  if (budgetCount > 0) {
    return `Nessun video incluso: ${budgetCount} transcript non rientravano nel budget contestuale e ${noTranscriptCount} non erano disponibili.`;
  }
  return `Nessuno dei ${videoCandidates.length} video candidati ha prodotto contesto utilizzabile.`;
};

export const buildYouTubeResearchOutcome = async (
  query: string,
  language: string,
  options: YouTubeResearchOptions = {}
): Promise<YouTubeResearchOutcome> => {
  const diagnostic = await buildYouTubeResearch(query, language, options);
  return {
    ...diagnostic.bundle,
    discoveredVideoCount: diagnostic.candidates.filter(candidate => candidate.kind === 'video')
      .length,
    rationale: summarizeYouTubeResearch(diagnostic),
  };
};

export const buildYouTubeResearchDiagnostic = async (
  query: string,
  language: string,
  options: YouTubeResearchOptions = {}
): Promise<YouTubeResearchDiagnostic> => buildYouTubeResearch(query, language, options);
