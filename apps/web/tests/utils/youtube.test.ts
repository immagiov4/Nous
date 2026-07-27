import { describe, expect, test } from 'vitest';
import {
  buildYouTubeClipEmbedUrl,
  extractYouTubeVideoId,
  isYouTubeClipWithinTranscriptBounds,
} from '../../utils/youtube.ts';

describe('YouTube URLs', () => {
  test('builds a privacy-enhanced embed for one bounded clip', () => {
    expect(buildYouTubeClipEmbedUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE', 65, 92)).toBe(
      'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?autoplay=0&controls=1&end=92&enablejsapi=1&playsinline=1&rel=0&start=65'
    );
  });

  test('rejects non-YouTube URLs and invalid intervals', () => {
    expect(extractYouTubeVideoId('https://example.com/watch?v=M7lc1UVf-VE')).toBeNull();
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=M7lc1UVf%2FVE')).toBeNull();
    expect(
      buildYouTubeClipEmbedUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE', 92, 65)
    ).toBeNull();
    expect(
      buildYouTubeClipEmbedUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE', Number.NaN, 10)
    ).toBeNull();
  });

  test('does not impose an arbitrary maximum duration on a transcript-backed interval', () => {
    expect(
      buildYouTubeClipEmbedUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE', 0, 600)
    ).toContain('end=600');
  });

  test('accepts a clip inside transcript bounds even when captions contain long silent gaps', () => {
    expect(
      isYouTubeClipWithinTranscriptBounds({ startSeconds: 65, endSeconds: 92 }, [
        { startSeconds: 65, endSeconds: 68 },
        { startSeconds: 82, endSeconds: 93 },
      ])
    ).toBe(true);
  });
});
