const YOUTUBE_VIDEO_ID_LENGTH = 11;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTNAMES = new Set(['m.youtube.com', 'www.youtube.com', 'youtube.com', 'youtu.be']);

export interface YouTubeClipInterval {
  endSeconds: number;
  startSeconds: number;
}

export interface YouTubeTranscriptRange {
  endSeconds: number;
  startSeconds: number;
}

const normalizeVideoId = (value: string | null | undefined): string | null =>
  value?.length === YOUTUBE_VIDEO_ID_LENGTH && YOUTUBE_VIDEO_ID_PATTERN.test(value) ? value : null;

export const extractYouTubeVideoId = (rawUrl: string): string | null => {
  if (!rawUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(rawUrl);
    const hostname = parsedUrl.hostname.toLowerCase();
    if (!YOUTUBE_HOSTNAMES.has(hostname)) {
      return null;
    }

    if (hostname === 'youtu.be') {
      return normalizeVideoId(parsedUrl.pathname.split('/').find(Boolean));
    }

    const searchVideoId = parsedUrl.searchParams.get('v');
    if (searchVideoId) {
      return normalizeVideoId(searchVideoId);
    }

    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    const videoSegmentIndex = pathSegments.findIndex(segment =>
      ['embed', 'shorts', 'u', 'v'].includes(segment)
    );
    return videoSegmentIndex >= 0 ? normalizeVideoId(pathSegments[videoSegmentIndex + 1]) : null;
  } catch {
    return null;
  }
};

export const buildYouTubeClipEmbedUrl = (
  sourceUrl: string,
  startSeconds: number,
  endSeconds: number,
  autoplay = false
): string | null => {
  const videoId = extractYouTubeVideoId(sourceUrl);
  const interval = normalizeYouTubeClipInterval(sourceUrl, startSeconds, endSeconds);
  if (!videoId || !interval) {
    return null;
  }

  const params = new URLSearchParams({
    autoplay: autoplay ? '1' : '0',
    controls: '1',
    end: String(interval.endSeconds),
    enablejsapi: '1',
    playsinline: '1',
    rel: '0',
    start: String(interval.startSeconds),
  });
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
};

export const normalizeYouTubeClipInterval = (
  sourceUrl: string,
  startSeconds: unknown,
  endSeconds: unknown
): YouTubeClipInterval | null => {
  if (
    !extractYouTubeVideoId(sourceUrl) ||
    typeof startSeconds !== 'number' ||
    typeof endSeconds !== 'number' ||
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  ) {
    return null;
  }

  const normalizedStart = Math.floor(startSeconds);
  const normalizedEnd = Math.floor(endSeconds);
  return normalizedEnd > normalizedStart
    ? { endSeconds: normalizedEnd, startSeconds: normalizedStart }
    : null;
};

export const isYouTubeClipWithinTranscriptBounds = (
  interval: YouTubeClipInterval,
  ranges: readonly YouTubeTranscriptRange[]
): boolean => {
  if (ranges.length === 0) return false;
  const transcriptStart = Math.min(...ranges.map(range => range.startSeconds));
  const transcriptEnd = Math.max(...ranges.map(range => range.endSeconds));
  return interval.startSeconds >= transcriptStart && interval.endSeconds <= transcriptEnd;
};
