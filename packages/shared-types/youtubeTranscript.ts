export interface YouTubeTranscriptSegment {
  endSeconds: number;
  startSeconds: number;
  text: string;
}

export interface YouTubeClipInterval {
  endSeconds: number;
  startSeconds: number;
}

export const isYouTubeClipWithinTranscriptBounds = (
  interval: YouTubeClipInterval,
  segments: readonly YouTubeTranscriptSegment[]
): boolean => {
  if (segments.length === 0 || interval.endSeconds <= interval.startSeconds) return false;
  const transcriptStart = Math.min(...segments.map(segment => segment.startSeconds));
  const transcriptEnd = Math.max(...segments.map(segment => segment.endSeconds));
  return interval.startSeconds >= transcriptStart && interval.endSeconds <= transcriptEnd;
};

/** Canonical persisted and exported transcript shape. Timestamped prose is derived when needed. */
export interface YouTubeTranscript {
  segments: YouTubeTranscriptSegment[];
}

const LEGACY_TIMESTAMP_PREFIX = /^\[\d+:\d{2}(?:-\d+:\d{2})?\]\s*/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseSegment = (value: unknown): YouTubeTranscriptSegment | null => {
  if (!isRecord(value)) return null;
  const { endSeconds, startSeconds } = value;
  if (typeof value.text !== 'string') return null;
  const text = value.text.trim();
  return typeof startSeconds === 'number' &&
    Number.isFinite(startSeconds) &&
    startSeconds >= 0 &&
    typeof endSeconds === 'number' &&
    Number.isFinite(endSeconds) &&
    endSeconds > startSeconds
    ? { endSeconds, startSeconds, text }
    : null;
};

const parseCanonicalTranscript = (value: Record<string, unknown>): YouTubeTranscript | null => {
  if (!Array.isArray(value.segments) || value.segments.length === 0) return null;
  const segments = value.segments.map(parseSegment);
  return segments.every((segment): segment is YouTubeTranscriptSegment => segment !== null)
    ? { segments }
    : null;
};

const parseLegacyTranscript = (value: Record<string, unknown>): YouTubeTranscript | null => {
  if (typeof value.text !== 'string' || !value.text.trim() || !Array.isArray(value.ranges)) {
    return null;
  }
  const ranges = value.ranges.map(range =>
    isRecord(range) ? parseSegment({ ...range, text: 'legacy' }) : null
  );
  if (
    !ranges.length ||
    !ranges.every((range): range is YouTubeTranscriptSegment => range !== null)
  ) {
    return null;
  }
  const lines = value.text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const texts = ranges.map((_, index) =>
    (lines[index] ?? '').replace(LEGACY_TIMESTAMP_PREFIX, '').trim()
  );
  if (lines.length > ranges.length) {
    const lastIndex = texts.length - 1;
    texts[lastIndex] = [
      texts[lastIndex],
      ...lines.slice(ranges.length).map(line => line.replace(LEGACY_TIMESTAMP_PREFIX, '').trim()),
    ]
      .filter(Boolean)
      .join('\n');
  }
  return {
    segments: ranges.map((range, index) => ({
      endSeconds: range.endSeconds,
      startSeconds: range.startSeconds,
      text: texts[index] ?? '',
    })),
  };
};

export const parseYouTubeTranscript = (value: unknown): YouTubeTranscript | null => {
  if (!isRecord(value)) return null;
  return parseCanonicalTranscript(value) ?? parseLegacyTranscript(value);
};

const formatTimestamp = (seconds: number): string => {
  const rounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(rounded / 60);
  return `${String(minutes).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
};

export const formatYouTubeTranscript = (segments: readonly YouTubeTranscriptSegment[]): string =>
  segments
    .map(
      segment =>
        `[${formatTimestamp(segment.startSeconds)}-${formatTimestamp(segment.endSeconds)}] ${segment.text}`
    )
    .join('\n');
