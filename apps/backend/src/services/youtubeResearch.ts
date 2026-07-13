import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DISCOVERY_RESULT_LIMIT = 3;
const PLAYLIST_RESULT_LIMIT = 2;
const PLAYLIST_VIDEO_LIMIT = 2;
const TRANSCRIPT_SOURCE_LIMIT = 4;
const MAX_TRANSCRIPT_CHARS_PER_VIDEO = 10_000;
const MAX_CONTEXT_CHARS = 32_000;
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

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

export interface CommandRunner {
  run(command: string, args: string[]): Promise<string>;
}

export interface YouTubeDiscoveryProvider {
  expandPlaylist(candidate: YouTubeCandidate): Promise<YouTubeCandidate[]>;
  search(query: string): Promise<YouTubeCandidate[]>;
}

export interface YouTubeTranscriptProvider {
  getTranscript(videoId: string, preferredLanguages: string[]): Promise<YouTubeTranscript | null>;
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
    playlistSearchUrl.searchParams.set('sp', 'EgIQAw%3D%3D');

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
      return text && startSeconds !== undefined && durationSeconds !== undefined
        ? { durationSeconds, startSeconds, text }
        : null;
    })
    .filter((segment): segment is YouTubeTranscriptSegment => Boolean(segment));
};

export class YoutubeTranscriptCliProvider implements YouTubeTranscriptProvider {
  constructor(private readonly runner: CommandRunner = defaultCommandRunner) {}

  private async fetch(
    videoId: string,
    language: string,
    kind: YouTubeTranscriptKind
  ): Promise<YouTubeTranscript | null> {
    const args = [videoId, '--languages', kind === 'translated' ? 'en' : language];
    if (kind === 'manual') {
      args.push('--exclude-generated');
    } else if (kind === 'automatic') {
      args.push('--exclude-manually-created');
    } else {
      args.push('--translate', language);
    }
    args.push('--format', 'json');

    try {
      const segments = parseTranscriptSegments(
        await this.runner.run('youtube_transcript_api', args)
      );
      return segments.length ? { kind, language, segments } : null;
    } catch {
      return null;
    }
  }

  async getTranscript(
    videoId: string,
    preferredLanguages: string[]
  ): Promise<YouTubeTranscript | null> {
    for (const language of preferredLanguages) {
      for (const kind of ['manual', 'automatic'] as const) {
        const transcript = await this.fetch(videoId, language, kind);
        if (transcript) {
          return transcript;
        }
      }
    }

    const targetLanguage = preferredLanguages.find(language => language !== 'en');
    return targetLanguage ? this.fetch(videoId, targetLanguage, 'translated') : null;
  }
}

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

const formatTranscript = (transcript: YouTubeTranscript): string => {
  let result = '';
  for (const segment of transcript.segments) {
    const line = `[${formatTimestamp(segment.startSeconds)}] ${segment.text}\n`;
    if (result.length + line.length > MAX_TRANSCRIPT_CHARS_PER_VIDEO) {
      break;
    }
    result += line;
  }
  return result.trim();
};

const deduplicateVideos = (videos: YouTubeCandidate[]): YouTubeCandidate[] => [
  ...new Map(videos.map(video => [video.id, video])).values(),
];

export const buildYouTubeResearchContext = async (
  query: string,
  language: string,
  discovery: YouTubeDiscoveryProvider = new YtDlpDiscoveryProvider(),
  transcripts: YouTubeTranscriptProvider = new YoutubeTranscriptCliProvider()
): Promise<string> => {
  const candidates = await discovery.search(query);
  const playlist = candidates.find(candidate => candidate.kind === 'playlist');
  let playlistVideos: YouTubeCandidate[] = [];
  if (playlist) {
    try {
      playlistVideos = await discovery.expandPlaylist(playlist);
    } catch {
      playlistVideos = [];
    }
  }
  const videos = deduplicateVideos([
    ...candidates.filter(candidate => candidate.kind === 'video'),
    ...playlistVideos,
  ]).slice(0, TRANSCRIPT_SOURCE_LIMIT);
  const preferredLanguages = getPreferredLanguages(language);

  const enriched = await Promise.all(
    videos.map(async video => ({
      transcript: await transcripts.getTranscript(video.id, preferredLanguages),
      video,
    }))
  );

  let context = '';
  for (const { transcript, video } of enriched) {
    if (!transcript) {
      continue;
    }
    const playlistDetails = video.playlistId
      ? ` | playlist ${video.playlistId}, posizione ${video.playlistPosition}`
      : '';
    const source = `\nSOURCE ${video.title}\nURL: ${video.url}\nCanale: ${video.channelTitle || 'non disponibile'}${playlistDetails}\nTranscript: ${transcript.kind}, lingua ${transcript.language}\n${formatTranscript(transcript)}\n`;
    if (context.length + source.length > MAX_CONTEXT_CHARS) {
      break;
    }
    context += source;
  }

  return context.trim();
};
