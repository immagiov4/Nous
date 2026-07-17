import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';

interface YouTubeResearchResponse {
  context?: unknown;
  success?: unknown;
  videoCandidates?: unknown;
  videoClipsEnabled?: unknown;
}

export interface YouTubeTranscriptRange {
  endSeconds: number;
  startSeconds: number;
}

export interface YouTubeVideoEvidence {
  ranges: YouTubeTranscriptRange[];
  url: string;
}

export interface YouTubeResearchContext {
  context: string;
  videoCandidates: YouTubeVideoEvidence[];
  videoClipsEnabled: boolean;
}

export interface YouTubeTranscriptOverride {
  language?: string;
  segments: Array<{
    durationSeconds?: number;
    startSeconds: number;
    text: string;
  }>;
  videoId: string;
}

const EMPTY_YOUTUBE_RESEARCH: YouTubeResearchContext = {
  context: '',
  videoCandidates: [],
  videoClipsEnabled: false,
};

const MAX_YOUTUBE_RESEARCH_QUERY_CHARS = 500;
const TRANSCRIPT_OVERRIDES_STORAGE_KEY = 'nous:youtube-transcript-overrides';

export const readYouTubeTranscriptOverrides = (): YouTubeTranscriptOverride[] => {
  try {
    const value = localStorage.getItem(TRANSCRIPT_OVERRIDES_STORAGE_KEY);
    return value ? (JSON.parse(value) as YouTubeTranscriptOverride[]) : [];
  } catch {
    return [];
  }
};

export const saveYouTubeTranscriptOverrides = (overrides: YouTubeTranscriptOverride[]): void => {
  localStorage.setItem(TRANSCRIPT_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
};

export const buildLessonYouTubeResearchQuery = (input: {
  contextPrompt?: string;
  courseTitle: string;
  guidingQuestions?: string[];
  keyConcepts?: string[];
  lessonDescription?: string;
  lessonTitle: string;
  miniLab?: string;
  sourceHints?: string[];
}): string => {
  const parts = [
    input.lessonTitle,
    input.courseTitle,
    input.lessonDescription,
    input.contextPrompt,
    ...(input.keyConcepts || []),
    ...(input.guidingQuestions || []),
    input.miniLab,
    ...(input.sourceHints || []),
  ]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(parts)].join(' ').slice(0, MAX_YOUTUBE_RESEARCH_QUERY_CHARS).trim();
};

const normalizeVideoCandidates = (value: unknown): YouTubeVideoEvidence[] =>
  Array.isArray(value)
    ? value.flatMap(candidate => {
        if (typeof candidate !== 'object' || candidate === null) return [];
        const record = candidate as { ranges?: unknown; url?: unknown };
        if (typeof record.url !== 'string' || !Array.isArray(record.ranges)) return [];
        const ranges = record.ranges.flatMap(range => {
          if (typeof range !== 'object' || range === null) return [];
          const values = range as { endSeconds?: unknown; startSeconds?: unknown };
          return typeof values.startSeconds === 'number' &&
            typeof values.endSeconds === 'number' &&
            Number.isFinite(values.startSeconds) &&
            Number.isFinite(values.endSeconds) &&
            values.startSeconds >= 0 &&
            values.endSeconds > values.startSeconds
            ? [{ endSeconds: values.endSeconds, startSeconds: values.startSeconds }]
            : [];
        });
        return ranges.length ? [{ ranges, url: record.url }] : [];
      })
    : [];

export const getYouTubeResearchContext = async (
  query: string,
  language: string
): Promise<YouTubeResearchContext> => {
  try {
    const transcriptOverrides = readYouTubeTranscriptOverrides();
    const response = await fetchWithSupabaseAuth(
      `${getBackendUrl()}/api/youtube/research-context`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          query,
          ...(transcriptOverrides.length ? { transcriptOverrides } : {}),
        }),
      }
    );
    if (!response.ok) {
      return EMPTY_YOUTUBE_RESEARCH;
    }

    const payload = (await response.json()) as YouTubeResearchResponse;
    return payload.success === true && typeof payload.context === 'string'
      ? {
          context: payload.context,
          videoCandidates:
            payload.videoClipsEnabled === true
              ? normalizeVideoCandidates(payload.videoCandidates)
              : [],
          videoClipsEnabled: payload.videoClipsEnabled === true,
        }
      : EMPTY_YOUTUBE_RESEARCH;
  } catch (error) {
    console.warn('[Nous] YouTube research unavailable:', error);
    return EMPTY_YOUTUBE_RESEARCH;
  }
};

export const getYouTubeVideoClipsEnabled = async (): Promise<boolean> => {
  try {
    const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/youtube/config`);
    if (!response.ok) return false;
    const payload = (await response.json()) as YouTubeResearchResponse;
    return payload.success === true && payload.videoClipsEnabled === true;
  } catch {
    return false;
  }
};
