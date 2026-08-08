import { formatYouTubeTranscript, type YouTubeTranscriptSegment } from '@shared/youtubeTranscript';

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
const DECODO_SCRAPE_URL = 'https://scraper-api.decodo.com/v2/scrape';

type YouTubeCandidateKind = 'playlist' | 'video';
type YouTubeTranscriptKind = 'automatic' | 'manual' | 'translated';

export interface YouTubeCandidate {
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
  errors: Array<'playlist-expansion-failed'>;
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
  metadata?: YouTubeMetadataProvider;
  signal?: AbortSignal;
  transcripts?: YouTubeTranscriptProvider;
}

export interface YouTubeDiscoveryProvider {
  expandPlaylist(candidate: YouTubeCandidate, signal?: AbortSignal): Promise<YouTubeCandidate[]>;
  search(query: string, signal?: AbortSignal): Promise<YouTubeCandidate[]>;
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

const sharedDecodoTranscriptCache = new Map<string, TranscriptCacheEntry>();

class DecodoProviderError extends Error {
  readonly responseHeaders: Record<string, string>;
  readonly status: number;

  constructor(operation: string, response: Response) {
    super(`Decodo ${operation} failed with status ${response.status}.`);
    this.name = 'DecodoProviderError';
    this.status = response.status;
    this.responseHeaders = Object.fromEntries(
      ['retry-after', 'retry-after-ms'].flatMap(name => {
        const value = response.headers.get(name)?.trim();
        return value ? [[name, value]] : [];
      })
    );
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asOptionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const readRunsText = (value: unknown): string => {
  const record = asRecord(value);
  if (typeof record?.simpleText === 'string') return record.simpleText.trim();
  const runs = Array.isArray(record?.runs) ? record.runs : [];
  return runs
    .map(run => asString(asRecord(run)?.text))
    .filter(Boolean)
    .join(' ')
    .trim();
};

const parseDurationSeconds = (value: string): number | undefined => {
  const parts = value.split(':').map(part => Number.parseInt(part, 10));
  if (!parts.length || parts.some(part => !Number.isFinite(part) || part < 0)) return undefined;
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
};

const parseCompactNumber = (value: string): number | undefined => {
  const match = value.replaceAll(',', '').match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]);
  const multiplier = { B: 1_000_000_000, K: 1_000, M: 1_000_000 }[(match[2] || '').toUpperCase()];
  return Number.isFinite(amount) ? Math.round(amount * (multiplier || 1)) : undefined;
};

const candidateFromDecodoResult = (
  value: unknown,
  playlist?: { id: string; position: number }
): YouTubeCandidate | null => {
  const entry = asRecord(value);
  if (!entry) return null;
  const videoId = asString(entry.videoId);
  const playlistId = asString(entry.playlistId);
  const kind: YouTubeCandidateKind = videoId ? 'video' : playlistId ? 'playlist' : 'video';
  const id = videoId || playlistId;
  const title = readRunsText(entry.title);
  if (!id || !title) return null;
  const channelTitle =
    readRunsText(entry.longBylineText) ||
    readRunsText(entry.shortBylineText) ||
    readRunsText(entry.ownerText);
  const playlistVideos = Array.isArray(entry.videos)
    ? entry.videos
        .map((video, index) =>
          candidateFromDecodoResult(video, { id: playlistId, position: index + 1 })
        )
        .filter((video): video is YouTubeCandidate => Boolean(video))
    : undefined;
  return {
    channelTitle,
    channelVerified: Array.isArray(entry.ownerBadges) && entry.ownerBadges.length > 0,
    durationSeconds: parseDurationSeconds(readRunsText(entry.lengthText)),
    id,
    kind,
    playlistId: playlist?.id,
    playlistPosition: playlist?.position,
    playlistVideos,
    title,
    url:
      kind === 'playlist'
        ? `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`
        : `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
    viewCount: parseCompactNumber(readRunsText(entry.viewCountText)),
  };
};

const readDecodoSearchResults = (payload: unknown): YouTubeCandidate[] => {
  const root = asRecord(payload);
  const results = Array.isArray(root?.results) ? root.results : [];
  const rawContent = asRecord(results[0])?.content;
  const content =
    typeof rawContent === 'string' ? JSON.parse(rawContent.replace(/^\uFEFF/, '')) : rawContent;
  return (Array.isArray(content) ? content : [])
    .map(candidate => candidateFromDecodoResult(candidate))
    .filter((candidate): candidate is YouTubeCandidate => Boolean(candidate));
};

export class DecodoDiscoveryProvider implements YouTubeDiscoveryProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<YouTubeCandidate[]> {
    const response = await this.fetcher(DECODO_SCRAPE_URL, {
      body: JSON.stringify({ query, target: 'youtube_search' }),
      headers: {
        Authorization: `Basic ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal,
    });
    if (!response.ok) {
      throw new DecodoProviderError('YouTube search', response);
    }
    const candidates = readDecodoSearchResults(await response.json());
    let playlistCount = 0;
    return candidates.filter(candidate => {
      if (candidate.kind === 'video') return true;
      playlistCount += 1;
      return playlistCount <= PLAYLIST_RESULT_LIMIT;
    });
  }

  async expandPlaylist(
    candidate: YouTubeCandidate,
    _signal?: AbortSignal
  ): Promise<YouTubeCandidate[]> {
    return candidate.kind === 'playlist' ? candidate.playlistVideos || [] : [candidate];
  }
}

export class DecodoMetadataProvider implements YouTubeMetadataProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async getMetadata(videoId: string, signal?: AbortSignal): Promise<YouTubeVideoMetadata> {
    const response = await this.fetcher(DECODO_SCRAPE_URL, {
      body: JSON.stringify({ query: videoId, target: 'youtube_metadata' }),
      headers: {
        Authorization: `Basic ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal,
    });
    if (!response.ok) {
      throw new DecodoProviderError('YouTube metadata', response);
    }

    const root = asRecord(await response.json());
    const result = Array.isArray(root?.results) ? asRecord(root.results[0]) : null;
    const content = asRecord(result?.content);
    const metadata = asRecord(content?.results);
    return {
      commentCount: asOptionalNumber(metadata?.comment_count),
      likeCount: asOptionalNumber(metadata?.like_count),
      viewCount: asOptionalNumber(metadata?.view_count),
    };
  }
}

const getDecodoSubtitleEvents = (
  content: Record<string, unknown>,
  origin: 'auto_generated' | 'uploader_provided',
  language: string
): unknown[] => {
  const origins = asRecord(content[origin]);
  const transcript = asRecord(origins?.[language]);
  return Array.isArray(transcript?.events) ? transcript.events : [];
};

const parseDecodoManualSegments = (events: unknown[]): YouTubeTranscriptSegment[] =>
  events
    .map(value => {
      const event = asRecord(value);
      const startMs = asOptionalNumber(event?.tStartMs);
      const durationMs = asOptionalNumber(event?.dDurationMs);
      const segmentValues = Array.isArray(event?.segs) ? event.segs : [];
      const text = segmentValues
        .map(segment => asString(asRecord(segment)?.utf8))
        .join(' ')
        .replaceAll(/\s+/g, ' ')
        .trim();
      return text && startMs !== undefined && startMs >= 0 && durationMs && durationMs > 0
        ? {
            endSeconds: (startMs + durationMs) / 1_000,
            startSeconds: startMs / 1_000,
            text,
          }
        : null;
    })
    .filter((segment): segment is YouTubeTranscriptSegment => Boolean(segment));

const readDecodoTranscript = (
  payload: unknown,
  preferredLanguages: string[]
): YouTubeTranscript | null => {
  const root = asRecord(payload);
  const results = Array.isArray(root?.results) ? root.results : [];
  const content = asRecord(asRecord(results[0])?.content);
  if (!content) return null;

  for (const language of preferredLanguages) {
    const manual = parseDecodoManualSegments(
      getDecodoSubtitleEvents(content, 'uploader_provided', language)
    );
    if (manual.length) return { kind: 'manual', language, segments: manual };

    const automatic = parseDecodoManualSegments(
      getDecodoSubtitleEvents(content, 'auto_generated', language)
    );
    if (automatic.length) return { kind: 'automatic', language, segments: automatic };
  }
  return null;
};

export class DecodoTranscriptProvider implements YouTubeTranscriptProvider {
  private readonly activeLookupCounts = new Map<string, number>();
  private readonly cache: Map<string, TranscriptCacheEntry>;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.cache = fetcher === fetch ? sharedDecodoTranscriptCache : new Map();
  }

  private async loadTranscriptDiagnostic(
    videoId: string,
    preferredLanguages: string[],
    signal?: AbortSignal
  ): Promise<YouTubeTranscriptLookup> {
    const startedAt = Date.now();
    try {
      signal?.throwIfAborted();
      const response = await this.fetcher(DECODO_SCRAPE_URL, {
        body: JSON.stringify({ query: videoId, target: 'youtube_subtitles' }),
        headers: {
          Authorization: `Basic ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal,
      });
      signal?.throwIfAborted();
      if (!response.ok) {
        throw new DecodoProviderError('YouTube subtitles', response);
      }
      const transcript = readDecodoTranscript(await response.json(), preferredLanguages);
      signal?.throwIfAborted();
      return {
        attempts: [
          {
            durationMs: Date.now() - startedAt,
            kind: transcript?.kind || 'automatic',
            language: transcript?.language || preferredLanguages[0] || 'en',
            outcome: transcript ? 'available' : 'empty',
          },
        ],
        transcript,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DecodoProviderError) throw error;
      return {
        attempts: [
          {
            durationMs: Date.now() - startedAt,
            kind: 'automatic',
            language: preferredLanguages[0] || 'en',
            outcome: 'unavailable',
          },
        ],
        transcript: null,
      };
    }
  }

  async getTranscriptDiagnostic(
    videoId: string,
    preferredLanguages: string[],
    signal?: AbortSignal
  ): Promise<YouTubeTranscriptLookup> {
    signal?.throwIfAborted();
    const cacheKey = `${videoId}:${preferredLanguages.join(',')}`;
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

const createDefaultTranscriptProvider = (): YouTubeTranscriptProvider => {
  const decodoApiKey = process.env.DECODO_SCRAPING_API_KEY?.trim();
  if (!decodoApiKey) {
    throw new Error('DECODO_SCRAPING_API_KEY is not configured.');
  }
  return new DecodoTranscriptProvider(decodoApiKey);
};

const createDefaultDiscoveryProvider = (): YouTubeDiscoveryProvider => {
  const decodoApiKey = process.env.DECODO_SCRAPING_API_KEY?.trim();
  if (!decodoApiKey) {
    throw new Error('DECODO_SCRAPING_API_KEY is not configured.');
  }
  return new DecodoDiscoveryProvider(decodoApiKey);
};

const createDefaultMetadataProvider = (): YouTubeMetadataProvider => {
  const decodoApiKey = process.env.DECODO_SCRAPING_API_KEY?.trim();
  if (!decodoApiKey) {
    throw new Error('DECODO_SCRAPING_API_KEY is not configured.');
  }
  return new DecodoMetadataProvider(decodoApiKey);
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
  const primary = LANGUAGE_CODES[normalized] || normalized.split(/[-_]/)[0] || 'it';
  return primary === 'en' ? ['en'] : [primary, 'en'];
};

const estimateTokens = (value: string): number =>
  Math.ceil(value.length / ESTIMATED_CHARACTERS_PER_TOKEN);

const formatTranscript = (
  transcript: YouTubeTranscript,
  maxTokens: number
): {
  estimatedTokens: number;
  segments: YouTubeTranscriptSegment[];
  text: string;
  tokens: number;
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
    text: fitsBudget ? text : '',
    tokens: fitsBudget ? estimatedTokens : 0,
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
    const formatted = formatTranscript(
      { kind: 'manual', language: '', segments: candidate.segments },
      availableTranscriptTokens
    );
    const safeSegments = formatted.segments.map(segment => ({
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

const buildYouTubeResearch = async (
  query: string,
  language: string,
  options: YouTubeResearchOptions
): Promise<YouTubeResearchDiagnostic> => {
  options.signal?.throwIfAborted();
  const discovery = options.discovery || createDefaultDiscoveryProvider();
  const transcripts = options.transcripts || createDefaultTranscriptProvider();
  const metadata =
    options.metadata ||
    (options.discovery || options.transcripts ? undefined : createDefaultMetadataProvider());
  const budget = calculateTranscriptBudget(options.budget);
  const startedAt = Date.now();
  const discoveryStartedAt = Date.now();
  const candidates = await discovery.search(query, options.signal);
  options.signal?.throwIfAborted();
  const discoveryMs = Date.now() - discoveryStartedAt;
  const errors: YouTubeResearchDiagnostic['errors'] = [];
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
  const preferredLanguages = getPreferredLanguages(language);
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
      const formattedTranscript = formatTranscript(transcript, availableTranscriptTokens);
      const safeSegments = formattedTranscript.segments.map(segment => ({
        ...segment,
        text: sanitizeTranscriptForPrompt(segment.text),
      }));
      const safeTranscript = formatYouTubeTranscript(safeSegments);
      const source = `${sourcePrefix}${safeTranscript}\n`;
      const sourceTokens = estimateTokens(source);
      diagnostic.estimatedTokens = prefixTokens + formattedTranscript.estimatedTokens;
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
    limits: {
      discoveryVideos: VIDEO_RESULT_LIMIT,
      playlistResults: PLAYLIST_RESULT_LIMIT,
      transcriptConcurrency: TRANSCRIPT_CONCURRENCY,
    },
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
