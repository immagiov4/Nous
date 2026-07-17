import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DISCOVERY_RESULT_LIMIT = 12;
const PLAYLIST_RESULT_LIMIT = 4;
const PLAYLIST_VIDEO_LIMIT = 4;
const TRANSCRIPT_CONCURRENCY = 2;
const TRANSCRIPT_CHUNK_SEGMENTS = 16;
const ESTIMATED_CHARACTERS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 32_000;
const DEFAULT_NON_YOUTUBE_PROMPT_TOKENS = 8_000;
const COMMAND_TIMEOUT_MS = 30_000;
const BROWSER_TRANSCRIPT_TIMEOUT_MS = 60_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_CACHE_MAX_ENTRIES = 200;
const TRANSCRIPT_CACHE_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const TRANSCRIPT_CACHE_FAILURE_TTL_MS = 15 * 60 * 1000;

type YouTubeCandidateKind = 'playlist' | 'video';
type YouTubeTranscriptKind = 'automatic' | 'manual' | 'translated';

export interface YouTubeCandidate {
  channelTitle: string;
  channelVerified: boolean;
  durationSeconds?: number;
  id: string;
  kind: YouTubeCandidateKind;
  playlistId?: string;
  playlistPosition?: number;
  title: string;
  url: string;
  viewCount?: number;
}

export interface YouTubeTranscriptSegment {
  durationSeconds: number;
  startSeconds: number;
  text: string;
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
  outcome: 'available' | 'empty' | 'ip-blocked' | 'unavailable';
}

export interface YouTubeTranscriptLookup {
  attempts: YouTubeTranscriptAttempt[];
  cached?: boolean;
  circuitOpened?: boolean;
  circuitReason?: 'ip-blocked';
  transcript: YouTubeTranscript | null;
}

export interface YouTubeTranscriptRange {
  endSeconds: number;
  startSeconds: number;
}

export interface YouTubeVideoEvidence {
  ranges: YouTubeTranscriptRange[];
  url: string;
}

export interface YouTubeResearchBundle {
  context: string;
  videoCandidates: YouTubeVideoEvidence[];
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
  rankScore: number;
  estimatedTokens?: number;
  includedTokens?: number;
  transcript?: {
    characterCount: number;
    kind: YouTubeTranscriptKind;
    language: string;
    ranges: YouTubeTranscriptRange[];
    segmentCount: number;
    text: string;
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
  circuitOpened: boolean;
  circuitReason: 'ip-blocked' | null;
  errors: Array<'playlist-expansion-failed'>;
  limits: {
    discoveryVideos: number;
    playlistResults: number;
    playlistVideos: number;
    transcriptConcurrency: number;
  };
  operations: {
    discoveryCommands: number;
    playlistExpansionCommands: number;
    transcriptCommandAttempts: number;
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
  transcripts?: YouTubeTranscriptProvider;
}

export interface CommandRunner {
  run(command: string, args: string[]): Promise<string>;
}

export interface YouTubeDiscoveryProvider {
  expandPlaylist(candidate: YouTubeCandidate): Promise<YouTubeCandidate[]>;
  search(query: string): Promise<YouTubeCandidate[]>;
}

export interface YouTubeTranscriptProvider {
  getTranscriptDiagnostic?(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscriptLookup>;
  getTranscript(videoId: string, preferredLanguages: string[]): Promise<YouTubeTranscript | null>;
}

export interface YouTubeTranscriptOverride {
  language: string;
  segments: YouTubeTranscriptSegment[];
  videoId: string;
}

export class YouTubeTranscriptOverrideProvider implements YouTubeTranscriptProvider {
  private readonly overrides: Map<string, YouTubeTranscript>;

  constructor(
    overrides: YouTubeTranscriptOverride[],
    private readonly fallback: YouTubeTranscriptProvider = new YoutubeTranscriptCliProvider()
  ) {
    this.overrides = new Map(
      overrides.map(({ language, segments, videoId }) => [
        videoId,
        { kind: 'automatic' as const, language, segments },
      ])
    );
  }

  async getTranscriptDiagnostic(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscriptLookup> {
    const transcript = this.overrides.get(videoId);
    if (transcript) {
      return {
        attempts: [
          {
            durationMs: 0,
            kind: transcript.kind,
            language: transcript.language,
            outcome: 'available',
          },
        ],
        transcript,
      };
    }

    return getTranscriptLookup(this.fallback, videoId, preferredLanguages);
  }

  async getTranscript(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscript | null> {
    return (
      this.overrides.get(videoId) ||
      (await this.fallback.getTranscript(videoId, preferredLanguages))
    );
  }
}

const defaultCommandRunner: CommandRunner = {
  async run(command, args) {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  },
};

const browserCommandRunner: CommandRunner = {
  async run(command, args) {
    const configuredTimeout = Number.parseInt(
      process.env.YOUTUBE_BROWSER_TRANSCRIPT_TIMEOUT_MS || '',
      10
    );
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
      timeout:
        Number.isFinite(configuredTimeout) && configuredTimeout > 0
          ? configuredTimeout
          : BROWSER_TRANSCRIPT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  },
};

interface TranscriptCacheEntry {
  expiresAt: number;
  lookup: Promise<YouTubeTranscriptLookup>;
}

const sharedTranscriptCache = new Map<string, TranscriptCacheEntry>();
const IP_BLOCK_DIAGNOSTIC_MARKERS = [
  'youtube is blocking requests from your ip',
  'requestblocked',
  'ipblocked',
] as const;
const NO_TRANSCRIPT_DIAGNOSTIC_MARKER =
  'no transcripts were found for any of the requested language codes';

const isIpBlockDiagnostic = (value: string): boolean =>
  IP_BLOCK_DIAGNOSTIC_MARKERS.some(marker => value.includes(marker));

const parseJson = (value: string): unknown => JSON.parse(value.replace(/^\uFEFF/, ''));

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asOptionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const candidateFromEntry = (
  value: unknown,
  kind: YouTubeCandidateKind,
  playlist?: { id: string; position: number }
): YouTubeCandidate | null => {
  const entry = asRecord(value);
  if (!entry) {
    return null;
  }

  const id = asString(entry.id);
  const title = asString(entry.title);
  if (!id || !title) {
    return null;
  }

  const url =
    asString(entry.url) ||
    (kind === 'playlist'
      ? `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`
      : `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`);
  return {
    channelTitle: asString(entry.channel) || asString(entry.uploader),
    channelVerified: entry.channel_is_verified === true,
    durationSeconds: asOptionalNumber(entry.duration),
    id,
    kind,
    playlistId: playlist?.id,
    playlistPosition: playlist?.position,
    title,
    url,
    viewCount: asOptionalNumber(entry.view_count),
  };
};

const parseEntries = (stdout: string, kind: YouTubeCandidateKind): YouTubeCandidate[] => {
  const result = asRecord(parseJson(stdout));
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  return entries
    .map(entry => candidateFromEntry(entry, kind))
    .filter((candidate): candidate is YouTubeCandidate => Boolean(candidate));
};

const SEARCH_STOP_WORDS = new Set([
  'a',
  'al',
  'alla',
  'con',
  'corso',
  'course',
  'da',
  'del',
  'della',
  'di',
  'e',
  'for',
  'in',
  'lezione',
  'lesson',
  'of',
  'the',
]);

const tokenizeSearchText = (value: string): Set<string> =>
  new Set(
    value
      .toLocaleLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(token => token.length > 1 && !SEARCH_STOP_WORDS.has(token))
  );

const rankCandidate = (candidate: YouTubeCandidate, queryTokens: Set<string>): number => {
  const titleTokens = tokenizeSearchText(candidate.title);
  const matchingTitleTokens = [...queryTokens].filter(token => titleTokens.has(token)).length;
  const popularity = Math.log10((candidate.viewCount || 0) + 1);
  const substantialDuration = (candidate.durationSeconds || 0) >= 20 * 60 ? 2 : 0;
  return (
    matchingTitleTokens * 3 + popularity + substantialDuration + (candidate.channelVerified ? 2 : 0)
  );
};

export class YtDlpDiscoveryProvider implements YouTubeDiscoveryProvider {
  constructor(private readonly runner: CommandRunner = defaultCommandRunner) {}

  async search(query: string): Promise<YouTubeCandidate[]> {
    const playlistSearchUrl = new URL('https://www.youtube.com/results');
    playlistSearchUrl.searchParams.set('search_query', query);
    playlistSearchUrl.searchParams.set('sp', 'EgIQAw==');

    const [videosResult, playlistsResult] = await Promise.allSettled([
      this.runner.run('yt-dlp', [
        '--flat-playlist',
        '--dump-single-json',
        '--playlist-end',
        String(DISCOVERY_RESULT_LIMIT),
        `ytsearch${DISCOVERY_RESULT_LIMIT}:${query}`,
      ]),
      this.runner.run('yt-dlp', [
        '--flat-playlist',
        '--dump-single-json',
        '--playlist-end',
        String(PLAYLIST_RESULT_LIMIT),
        playlistSearchUrl.toString(),
      ]),
    ]);

    if (videosResult.status === 'rejected') {
      throw videosResult.reason;
    }

    const queryTokens = tokenizeSearchText(query);
    const videos = parseEntries(videosResult.value, 'video').sort(
      (left, right) => rankCandidate(right, queryTokens) - rankCandidate(left, queryTokens)
    );
    const playlists =
      playlistsResult.status === 'fulfilled' ? parseEntries(playlistsResult.value, 'playlist') : [];
    return [...videos, ...playlists];
  }

  async expandPlaylist(candidate: YouTubeCandidate): Promise<YouTubeCandidate[]> {
    if (candidate.kind !== 'playlist') {
      return [candidate];
    }

    const output = await this.runner.run('yt-dlp', [
      '--flat-playlist',
      '--dump-single-json',
      '--playlist-end',
      String(PLAYLIST_VIDEO_LIMIT),
      candidate.url,
    ]);
    const result = asRecord(parseJson(output));
    const entries = Array.isArray(result?.entries) ? result.entries : [];
    return entries
      .map((entry, index) =>
        candidateFromEntry(entry, 'video', { id: candidate.id, position: index + 1 })
      )
      .filter((video): video is YouTubeCandidate => Boolean(video));
  }
}

const parseTranscriptSegments = (stdout: string): YouTubeTranscriptSegment[] => {
  const payload = parseJson(stdout);
  const transcript = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : [];
  return transcript
    .map(value => {
      const segment = asRecord(value);
      const text = asString(segment?.text).replace(/\s+/g, ' ');
      const startSeconds = asOptionalNumber(segment?.start);
      const durationSeconds = asOptionalNumber(segment?.duration);
      return text &&
        startSeconds !== undefined &&
        startSeconds >= 0 &&
        durationSeconds !== undefined &&
        durationSeconds > 0
        ? { durationSeconds, startSeconds, text }
        : null;
    })
    .filter((segment): segment is YouTubeTranscriptSegment => Boolean(segment));
};

export class YoutubeTranscriptCliProvider implements YouTubeTranscriptProvider {
  private readonly cache: Map<string, TranscriptCacheEntry>;
  private ipBlockCircuitOpened = false;

  constructor(private readonly runner: CommandRunner = defaultCommandRunner) {
    this.cache = runner === defaultCommandRunner ? sharedTranscriptCache : new Map();
  }

  private async fetch(
    videoId: string,
    language: string,
    kind: YouTubeTranscriptKind
  ): Promise<{ attempt: YouTubeTranscriptAttempt; transcript: YouTubeTranscript | null }> {
    const args = [videoId, '--languages', kind === 'translated' ? 'en' : language];
    if (kind === 'manual') {
      args.push('--exclude-generated');
    } else if (kind === 'automatic') {
      args.push('--exclude-manually-created');
    } else {
      args.push('--translate', language);
    }
    args.push('--format', 'json');

    const startedAt = Date.now();
    let stdout = '';
    try {
      stdout = await this.runner.run('youtube_transcript_api', args);
      const normalizedOutput = stdout.toLocaleLowerCase();
      if (isIpBlockDiagnostic(normalizedOutput)) {
        return {
          attempt: {
            durationMs: Date.now() - startedAt,
            kind,
            language,
            outcome: 'ip-blocked',
          },
          transcript: null,
        };
      }
      if (normalizedOutput.includes(NO_TRANSCRIPT_DIAGNOSTIC_MARKER)) {
        return {
          attempt: {
            durationMs: Date.now() - startedAt,
            kind,
            language,
            outcome: 'empty',
          },
          transcript: null,
        };
      }

      const segments = parseTranscriptSegments(stdout);
      const transcript = segments.length ? { kind, language, segments } : null;
      return {
        attempt: {
          durationMs: Date.now() - startedAt,
          kind,
          language,
          outcome: transcript ? 'available' : 'empty',
        },
        transcript,
      };
    } catch (error) {
      const errorRecord =
        error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
      const diagnosticText = [
        stdout,
        error instanceof Error ? error.message : '',
        typeof errorRecord.stderr === 'string' ? errorRecord.stderr : '',
        typeof errorRecord.stdout === 'string' ? errorRecord.stdout : '',
      ]
        .join(' ')
        .toLocaleLowerCase();
      return {
        attempt: {
          durationMs: Date.now() - startedAt,
          kind,
          language,
          outcome: isIpBlockDiagnostic(diagnosticText) ? 'ip-blocked' : 'unavailable',
        },
        transcript: null,
      };
    }
  }

  private async loadTranscriptDiagnostic(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscriptLookup> {
    const attempts: YouTubeTranscriptAttempt[] = [];
    for (const language of preferredLanguages) {
      for (const kind of ['manual', 'automatic'] as const) {
        if (this.ipBlockCircuitOpened) {
          return { attempts, circuitOpened: true, circuitReason: 'ip-blocked', transcript: null };
        }
        const result = await this.fetch(videoId, language, kind);
        attempts.push(result.attempt);
        if (result.transcript) {
          return { attempts, transcript: result.transcript };
        }
        if (result.attempt.outcome === 'ip-blocked') {
          this.ipBlockCircuitOpened = true;
          return { attempts, circuitOpened: true, circuitReason: 'ip-blocked', transcript: null };
        }
      }
    }

    const targetLanguage = preferredLanguages.find(language => language !== 'en');
    if (targetLanguage) {
      if (this.ipBlockCircuitOpened) {
        return { attempts, circuitOpened: true, circuitReason: 'ip-blocked', transcript: null };
      }
      const result = await this.fetch(videoId, targetLanguage, 'translated');
      attempts.push(result.attempt);
      if (result.attempt.outcome === 'ip-blocked') {
        this.ipBlockCircuitOpened = true;
        return { attempts, circuitOpened: true, circuitReason: 'ip-blocked', transcript: null };
      }
      return { attempts, transcript: result.transcript };
    }
    return { attempts, transcript: null };
  }

  async getTranscriptDiagnostic(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscriptLookup> {
    const cacheKey = `${videoId}:${preferredLanguages.join(',')}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const lookup = await cached.lookup;
      if (
        lookup.circuitOpened ||
        lookup.attempts.some(attempt => attempt.outcome === 'ip-blocked')
      ) {
        this.ipBlockCircuitOpened = true;
      }
      return { ...lookup, cached: true };
    }
    if (cached) this.cache.delete(cacheKey);
    if (this.ipBlockCircuitOpened) {
      return { attempts: [], circuitOpened: true, circuitReason: 'ip-blocked', transcript: null };
    }

    const entry: TranscriptCacheEntry = {
      expiresAt: Date.now() + TRANSCRIPT_CACHE_FAILURE_TTL_MS,
      lookup: this.loadTranscriptDiagnostic(videoId, preferredLanguages),
    };
    this.cache.set(cacheKey, entry);
    if (this.cache.size > TRANSCRIPT_CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const lookup = await entry.lookup;
    entry.expiresAt =
      Date.now() +
      (lookup.transcript ? TRANSCRIPT_CACHE_SUCCESS_TTL_MS : TRANSCRIPT_CACHE_FAILURE_TTL_MS);
    return lookup;
  }

  async getTranscript(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscript | null> {
    return (await this.getTranscriptDiagnostic(videoId, preferredLanguages)).transcript;
  }
}

export class YoutubeBrowserTranscriptProvider implements YouTubeTranscriptProvider {
  constructor(
    private readonly runner: CommandRunner = browserCommandRunner,
    private readonly scriptPath = process.env.YOUTUBE_BROWSER_TRANSCRIPT_SCRIPT ||
      'scripts/fetch-youtube-browser-transcript.mjs',
    private readonly authStatePath = process.env.YOUTUBE_BROWSER_AUTH_STATE_PATH
  ) {}

  async getTranscriptDiagnostic(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscriptLookup> {
    const attempts: YouTubeTranscriptAttempt[] = [];
    for (const language of preferredLanguages) {
      const startedAt = Date.now();
      try {
        const stdout = await this.runner.run('node', [
          this.scriptPath,
          '--video-id',
          videoId,
          '--language',
          language,
          ...(this.authStatePath ? ['--auth-state', this.authStatePath] : []),
        ]);
        const segments = parseTranscriptSegments(stdout);
        attempts.push({
          durationMs: Date.now() - startedAt,
          kind: 'automatic',
          language,
          outcome: segments.length ? 'available' : 'empty',
        });
        if (segments.length) {
          return { attempts, transcript: { kind: 'automatic', language, segments } };
        }
      } catch {
        attempts.push({
          durationMs: Date.now() - startedAt,
          kind: 'automatic',
          language,
          outcome: 'unavailable',
        });
      }
    }
    return { attempts, transcript: null };
  }

  async getTranscript(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscript | null> {
    return (await this.getTranscriptDiagnostic(videoId, preferredLanguages)).transcript;
  }
}

export class YouTubeTranscriptFallbackProvider implements YouTubeTranscriptProvider {
  constructor(
    private readonly primary: YouTubeTranscriptProvider,
    private readonly fallback: YouTubeTranscriptProvider
  ) {}

  async getTranscriptDiagnostic(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscriptLookup> {
    const primary = await getTranscriptLookup(this.primary, videoId, preferredLanguages);
    if (primary.transcript) return primary;

    const fallback = await getTranscriptLookup(this.fallback, videoId, preferredLanguages);
    return {
      ...fallback,
      attempts: [...primary.attempts, ...fallback.attempts],
      ...(fallback.transcript ? {} : { circuitOpened: primary.circuitOpened }),
      ...(fallback.transcript || !primary.circuitReason
        ? {}
        : { circuitReason: primary.circuitReason }),
    };
  }

  async getTranscript(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscript | null> {
    return (
      (await this.primary.getTranscript(videoId, preferredLanguages)) ||
      (await this.fallback.getTranscript(videoId, preferredLanguages))
    );
  }
}

const createDefaultTranscriptProvider = (): YouTubeTranscriptProvider => {
  const cli = new YoutubeTranscriptCliProvider();
  return process.env.YOUTUBE_BROWSER_TRANSCRIPTS_ENABLED === 'true'
    ? new YouTubeTranscriptFallbackProvider(cli, new YoutubeBrowserTranscriptProvider())
    : cli;
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

const formatTimestamp = (seconds: number): string => {
  const rounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(rounded / 60);
  return `${String(minutes).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
};

const estimateTokens = (value: string): number =>
  Math.ceil(value.length / ESTIMATED_CHARACTERS_PER_TOKEN);

const formatTranscript = (
  transcript: YouTubeTranscript,
  queryTokens: Set<string>,
  maxTokens: number
): {
  estimatedTokens: number;
  ranges: YouTubeTranscriptRange[];
  text: string;
  tokens: number;
} => {
  const lines = transcript.segments.flatMap(segment => {
    if (segment.startSeconds < 0 || segment.durationSeconds <= 0 || !segment.text.trim()) {
      return [];
    }
    const startSeconds = Math.floor(segment.startSeconds);
    const endSeconds = Math.ceil(segment.startSeconds + segment.durationSeconds);
    return [
      {
        endSeconds,
        line: `[${formatTimestamp(startSeconds)}-${formatTimestamp(endSeconds)}] ${segment.text}`,
        startSeconds,
      },
    ];
  });
  const estimatedTokens = estimateTokens(lines.map(line => line.line).join('\n'));
  if (estimatedTokens <= maxTokens) {
    return {
      estimatedTokens,
      ranges: lines.map(({ endSeconds, startSeconds }) => ({ endSeconds, startSeconds })),
      text: lines.map(line => line.line).join('\n'),
      tokens: estimatedTokens,
    };
  }

  const chunks = Array.from(
    { length: Math.ceil(lines.length / TRANSCRIPT_CHUNK_SEGMENTS) },
    (_, index) => {
      const start = index * TRANSCRIPT_CHUNK_SEGMENTS;
      const chunkLines = lines.slice(start, start + TRANSCRIPT_CHUNK_SEGMENTS);
      const chunkTokens = tokenizeSearchText(chunkLines.map(line => line.line).join(' '));
      return {
        indexes: chunkLines.map((_, offset) => start + offset),
        index,
        score: [...queryTokens].filter(token => chunkTokens.has(token)).length,
      };
    }
  ).sort((left, right) => right.score - left.score || left.index - right.index);

  const selectedIndexes = new Set<number>();
  let usedTokens = 0;
  for (const chunk of chunks) {
    for (const index of chunk.indexes) {
      const lineTokens = estimateTokens(lines[index]?.line || '');
      if (usedTokens + lineTokens > maxTokens) continue;
      selectedIndexes.add(index);
      usedTokens += lineTokens;
    }
  }

  const selectedLines = lines.filter((_, index) => selectedIndexes.has(index));
  const text = selectedLines.map(line => line.line).join('\n');
  return {
    estimatedTokens,
    ranges: selectedLines.map(({ endSeconds, startSeconds }) => ({ endSeconds, startSeconds })),
    text,
    tokens: estimateTokens(text),
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
  preferredLanguages: string[]
): Promise<YouTubeTranscriptLookup> =>
  provider.getTranscriptDiagnostic
    ? provider.getTranscriptDiagnostic(videoId, preferredLanguages)
    : {
        attempts: [],
        transcript: await provider.getTranscript(videoId, preferredLanguages),
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
  const transcriptBudgetTokens = Math.floor(
    Math.min(contextWindowTokens * 0.4, residualTokens * 0.6)
  );
  return {
    contextWindowTokens,
    nonYouTubePromptTokens,
    perTranscriptMaxTokens: Math.floor(
      Math.min(contextWindowTokens * 0.2, transcriptBudgetTokens * 0.5)
    ),
    remainingTokens: transcriptBudgetTokens,
    reservedOutputTokens,
    residualTokens,
    transcriptBudgetTokens,
    usedTokens: 0,
  };
};

const sanitizeTranscriptForPrompt = (value: string): string =>
  value.replace(/<\/?youtube_sources>/gi, '[youtube_sources tag removed]');

const buildYouTubeResearch = async (
  query: string,
  language: string,
  options: YouTubeResearchOptions
): Promise<YouTubeResearchDiagnostic> => {
  const discovery = options.discovery || new YtDlpDiscoveryProvider();
  const transcripts = options.transcripts || createDefaultTranscriptProvider();
  const budget = calculateTranscriptBudget(options.budget);
  const startedAt = Date.now();
  const discoveryStartedAt = Date.now();
  const candidates = await discovery.search(query);
  const discoveryMs = Date.now() - discoveryStartedAt;
  const errors: YouTubeResearchDiagnostic['errors'] = [];
  const playlists = candidates.filter(candidate => candidate.kind === 'playlist');
  const playlistStartedAt = Date.now();
  const playlistResults = await Promise.allSettled(
    playlists.map(playlist => discovery.expandPlaylist(playlist))
  );
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
  const queryTokens = tokenizeSearchText(query);
  const videos = deduplicateVideos([...searchVideos, ...playlistVideos]).sort(
    (left, right) => rankCandidate(right, queryTokens) - rankCandidate(left, queryTokens)
  );
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
      rankScore: rankCandidate(video, queryTokens),
      transcriptAttempts: [],
    });
  }

  let transcriptLookups = 0;
  let transcriptCommandAttempts = 0;
  let circuitOpened = false;
  let circuitReason: YouTubeResearchDiagnostic['circuitReason'] = null;
  for (
    let index = 0;
    index < videos.length && budget.remainingTokens > 0;
    index += TRANSCRIPT_CONCURRENCY
  ) {
    const batch = videos.slice(index, index + TRANSCRIPT_CONCURRENCY);
    const enriched = await Promise.all(
      batch.map(async video => {
        const transcriptStartedAt = Date.now();
        const lookup = await getTranscriptLookup(transcripts, video.id, preferredLanguages);
        return { ...lookup, transcriptLookupMs: Date.now() - transcriptStartedAt, video };
      })
    );
    transcriptLookups += enriched.length;
    transcriptCommandAttempts += enriched.reduce(
      (total, result) => total + (result.cached ? 0 : result.attempts.length),
      0
    );
    if (
      enriched.some(
        result =>
          result.circuitOpened || result.attempts.some(attempt => attempt.outcome === 'ip-blocked')
      )
    ) {
      circuitOpened = true;
      circuitReason = 'ip-blocked';
    }

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
      const formattedTranscript = formatTranscript(
        transcript,
        queryTokens,
        availableTranscriptTokens
      );
      const safeTranscript = sanitizeTranscriptForPrompt(formattedTranscript.text);
      const source = `${sourcePrefix}${safeTranscript}\n`;
      const sourceTokens = estimateTokens(source);
      diagnostic.estimatedTokens = prefixTokens + formattedTranscript.estimatedTokens;
      diagnostic.includedTokens = sourceTokens;
      diagnostic.transcript = {
        characterCount: safeTranscript.length,
        kind: transcript.kind,
        language: transcript.language,
        ranges: formattedTranscript.ranges,
        segmentCount: transcript.segments.length,
        text: safeTranscript,
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
      videoCandidates.push({ ranges: formattedTranscript.ranges, url: video.url });
    }

    if (circuitOpened) break;
  }
  const transcriptsMs = Date.now() - transcriptsStartedAt;

  const playlistDiagnostics = playlists.map(candidate => ({
    ...candidate,
    decision: failedPlaylistIds.has(candidate.id)
      ? ('playlist-expansion-failed' as const)
      : ('playlist-expanded' as const),
    origins: ['search'] as Array<'playlist' | 'search'>,
    rankScore: rankCandidate(candidate, queryTokens),
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
    circuitOpened,
    circuitReason,
    errors,
    limits: {
      discoveryVideos: DISCOVERY_RESULT_LIMIT,
      playlistResults: PLAYLIST_RESULT_LIMIT,
      playlistVideos: PLAYLIST_VIDEO_LIMIT,
      transcriptConcurrency: TRANSCRIPT_CONCURRENCY,
    },
    operations: {
      discoveryCommands: 2,
      playlistExpansionCommands: playlists.length,
      transcriptCommandAttempts,
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

export const buildYouTubeResearchBundle = async (
  query: string,
  language: string,
  options: YouTubeResearchOptions = {}
): Promise<YouTubeResearchBundle> => (await buildYouTubeResearch(query, language, options)).bundle;

export const buildYouTubeResearchDiagnostic = async (
  query: string,
  language: string,
  options: YouTubeResearchOptions = {}
): Promise<YouTubeResearchDiagnostic> => buildYouTubeResearch(query, language, options);

export const buildYouTubeResearchContext = async (
  query: string,
  language: string,
  options: YouTubeResearchOptions = {}
): Promise<string> => (await buildYouTubeResearchBundle(query, language, options)).context;
