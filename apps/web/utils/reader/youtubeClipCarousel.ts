import type {
  LessonYouTubeClip,
  LessonYouTubeClipsBlock,
  ResearchSourceReference,
} from '../../types.ts';
import { isYouTubeClipWithinTranscriptBounds, normalizeYouTubeClipInterval } from '../youtube.ts';

const YOUTUBE_CLIP_CAROUSEL_PLACEHOLDER = '{{YOUTUBE_CLIP_CAROUSEL}}';
const YOUTUBE_CLIP_SOURCE_PLACEHOLDER_REGEX =
  /\{\{YOUTUBE_CLIP_SOURCE:(\d+)(?:\|START:(\d+)\|END:(\d+))?}}/g;

export type YouTubeClipCarouselContentPart =
  | { content: string; key: string; type: 'markdown' }
  | { key: string; type: 'youtube-carousel' };

export interface YouTubeClipCarouselProjection {
  clips: LessonYouTubeClip[];
  content: string;
}

export const resolveTypedYouTubeClips = (
  block: LessonYouTubeClipsBlock,
  sources: ResearchSourceReference[]
): LessonYouTubeClip[] =>
  block.clips.flatMap((clip, clipIndex) => {
    const source = sources[clip.sourceIndex];
    if (!source?.url || !source.youtubeTranscript) {
      return [];
    }

    const interval = normalizeYouTubeClipInterval(source.url, clip.startSeconds, clip.endSeconds);
    if (
      !interval ||
      !isYouTubeClipWithinTranscriptBounds(interval, source.youtubeTranscript.segments)
    ) {
      return [];
    }

    return [
      {
        ...interval,
        id: JSON.stringify({
          blockClipIndex: clipIndex,
          endSeconds: interval.endSeconds,
          sourceIndex: clip.sourceIndex,
          startSeconds: interval.startSeconds,
          url: source.url,
        }),
        sourceIndex: clip.sourceIndex,
        title: clip.title?.trim() || source.title,
        url: source.url,
      },
    ];
  });

const resolveLessonClip = (
  match: RegExpMatchArray,
  sources: ResearchSourceReference[]
): LessonYouTubeClip | null => {
  const sourceIndex = Number.parseInt(match[1] || '', 10);
  const source = sources[sourceIndex];
  if (!source?.url || !source.youtubeTranscript) {
    return null;
  }

  const interval = normalizeYouTubeClipInterval(
    source.url,
    match[2] ? Number.parseInt(match[2], 10) : source.videoClip?.startSeconds,
    match[3] ? Number.parseInt(match[3], 10) : source.videoClip?.endSeconds
  );
  if (
    !interval ||
    !isYouTubeClipWithinTranscriptBounds(interval, source.youtubeTranscript.segments)
  ) {
    return null;
  }

  return {
    ...interval,
    id: JSON.stringify({
      endSeconds: interval.endSeconds,
      markerStart: match.index ?? 0,
      sourceIndex,
      startSeconds: interval.startSeconds,
      url: source.url,
    }),
    note: source.note,
    sourceIndex,
    title: source.title,
    url: source.url,
  };
};

export const projectYouTubeClipCarousel = (
  content: string,
  sources: ResearchSourceReference[]
): YouTubeClipCarouselProjection => {
  const clips: LessonYouTubeClip[] = [];
  let cursor = 0;
  let projectedContent = '';
  let hasPlacedCarousel = false;

  for (const match of content.matchAll(YOUTUBE_CLIP_SOURCE_PLACEHOLDER_REGEX)) {
    const markerStart = match.index ?? 0;
    projectedContent += content.slice(cursor, markerStart);

    const clip = resolveLessonClip(match, sources);
    if (clip) {
      clips.push(clip);
      if (!hasPlacedCarousel) {
        projectedContent += YOUTUBE_CLIP_CAROUSEL_PLACEHOLDER;
        hasPlacedCarousel = true;
      }
    }

    cursor = markerStart + match[0].length;
  }

  projectedContent += content.slice(cursor);
  return { clips, content: projectedContent };
};

export const splitYouTubeClipCarouselContent = (
  content: string
): YouTubeClipCarouselContentPart[] => {
  const placeholderIndex = content.indexOf(YOUTUBE_CLIP_CAROUSEL_PLACEHOLDER);
  if (placeholderIndex < 0) {
    return [{ content, key: 'markdown:all', type: 'markdown' }];
  }

  const parts: YouTubeClipCarouselContentPart[] = [];
  const before = content.slice(0, placeholderIndex);
  const after = content.slice(placeholderIndex + YOUTUBE_CLIP_CAROUSEL_PLACEHOLDER.length);
  if (before) {
    parts.push({ content: before, key: 'markdown:before-carousel', type: 'markdown' });
  }
  parts.push({ key: 'youtube-clip-carousel', type: 'youtube-carousel' });
  if (after) {
    parts.push({ content: after, key: 'markdown:after-carousel', type: 'markdown' });
  }
  return parts;
};
