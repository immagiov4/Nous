import { describe, expect, test } from 'vitest';
import { buildYouTubeClipEmbedUrl, extractYouTubeVideoId } from '../../utils/youtube.ts';

describe('YouTube URLs', () => {
  test('builds a privacy-enhanced embed for one bounded clip', () => {
    expect(buildYouTubeClipEmbedUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE', 65, 92)).toBe(
      'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?autoplay=0&controls=1&end=92&playsinline=1&rel=0&start=65'
    );
  });

  test('rejects non-YouTube URLs and invalid intervals', () => {
    expect(extractYouTubeVideoId('https://example.com/watch?v=M7lc1UVf-VE')).toBeNull();
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=M7lc1UVf%2FVE')).toBeNull();
    expect(
      buildYouTubeClipEmbedUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE', 92, 65)
    ).toBeNull();
    expect(
      buildYouTubeClipEmbedUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE', 0, 181)
    ).toBeNull();
    expect(
      buildYouTubeClipEmbedUrl('https://www.youtube.com/watch?v=M7lc1UVf-VE', Number.NaN, 10)
    ).toBeNull();
  });
});
