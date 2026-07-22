import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';

interface YouTubeResearchResponse {
  context?: unknown;
  discoveredVideoCount?: unknown;
  rationale?: unknown;
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
  title: string;
  transcript: string;
  url: string;
}

export interface YouTubeResearchContext {
  context: string;
  discoveredVideoCount?: number;
  failed?: boolean;
  rationale: string;
  videoCandidates: YouTubeVideoEvidence[];
  videoClipsEnabled: boolean;
}

export const mergeYouTubeResearchContexts = (
  contexts: YouTubeResearchContext[]
): YouTubeResearchContext => {
  const videoCandidates = new Map<string, YouTubeVideoEvidence>();
  const discoveredVideoCounts = contexts.flatMap(item =>
    typeof item.discoveredVideoCount === 'number' ? [item.discoveredVideoCount] : []
  );
  for (const context of contexts) {
    for (const candidate of context.videoCandidates) {
      if (!videoCandidates.has(candidate.url)) {
        videoCandidates.set(candidate.url, candidate);
      }
    }
  }

  return {
    context: [...new Set(contexts.map(item => item.context.trim()).filter(Boolean))].join('\n\n'),
    ...(discoveredVideoCounts.length
      ? { discoveredVideoCount: discoveredVideoCounts.reduce((total, count) => total + count, 0) }
      : {}),
    failed: contexts.every(item => item.failed === true),
    rationale: [...new Set(contexts.map(item => item.rationale.trim()).filter(Boolean))].join(' '),
    videoCandidates: [...videoCandidates.values()],
    videoClipsEnabled: contexts.some(item => item.videoClipsEnabled),
  };
};

const EMPTY_YOUTUBE_RESEARCH: YouTubeResearchContext = {
  context: '',
  failed: true,
  rationale: 'La ricerca YouTube non è stata completata.',
  videoCandidates: [],
  videoClipsEnabled: false,
};

const normalizeVideoCandidates = (value: unknown): YouTubeVideoEvidence[] =>
  Array.isArray(value)
    ? value.flatMap(candidate => {
        if (typeof candidate !== 'object' || candidate === null) return [];
        const record = candidate as {
          ranges?: unknown;
          title?: unknown;
          transcript?: unknown;
          url?: unknown;
        };
        if (
          typeof record.url !== 'string' ||
          typeof record.title !== 'string' ||
          !record.title.trim() ||
          typeof record.transcript !== 'string' ||
          !record.transcript.trim() ||
          !Array.isArray(record.ranges)
        ) {
          return [];
        }
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
        return ranges.length
          ? [
              {
                ranges,
                title: record.title.trim(),
                transcript: record.transcript.trim(),
                url: record.url,
              },
            ]
          : [];
      })
    : [];

export const getYouTubeResearchContext = async (
  query: string,
  language: string
): Promise<YouTubeResearchContext> => {
  try {
    const response = await fetchWithSupabaseAuth(
      `${getBackendUrl()}/api/youtube/research-context`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          query,
        }),
      }
    );
    if (!response.ok) {
      console.error('[Nous] Errore tecnico durante la procedura YouTube.');
      return EMPTY_YOUTUBE_RESEARCH;
    }

    const payload = (await response.json()) as YouTubeResearchResponse;
    if (payload.success !== true || typeof payload.context !== 'string') {
      console.error('[Nous] Errore tecnico durante la procedura YouTube.');
      return EMPTY_YOUTUBE_RESEARCH;
    }

    const result = {
      context: payload.context,
      discoveredVideoCount:
        typeof payload.discoveredVideoCount === 'number' &&
        Number.isFinite(payload.discoveredVideoCount)
          ? payload.discoveredVideoCount
          : undefined,
      rationale:
        typeof payload.rationale === 'string' && payload.rationale.trim()
          ? payload.rationale.trim()
          : 'Il backend non ha restituito una motivazione.',
      videoCandidates:
        payload.videoClipsEnabled === true ? normalizeVideoCandidates(payload.videoCandidates) : [],
      videoClipsEnabled: payload.videoClipsEnabled === true,
    };
    return result;
  } catch {
    console.error('[Nous] Errore tecnico durante la procedura YouTube.');
    return EMPTY_YOUTUBE_RESEARCH;
  }
};

export const getYouTubeVideoClipsEnabled = async (): Promise<boolean> => {
  try {
    const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/youtube/config`);
    if (!response.ok) {
      console.error('[Nous] Impossibile leggere la configurazione delle clip YouTube.');
      return false;
    }
    const payload = (await response.json()) as YouTubeResearchResponse;
    return payload.success === true && payload.videoClipsEnabled === true;
  } catch {
    console.error('[Nous] Impossibile leggere la configurazione delle clip YouTube.');
    return false;
  }
};
