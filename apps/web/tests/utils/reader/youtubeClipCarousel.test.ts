import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ResearchSourceReference } from '../../../types.ts';
import {
  projectYouTubeClipCarousel,
  splitYouTubeClipCarouselContent,
} from '../../../utils/reader/youtubeClipCarousel.ts';

const sources: ResearchSourceReference[] = [
  {
    title: 'Tecnica completa',
    url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
    youtubeTranscript: {
      ranges: [{ startSeconds: 0, endSeconds: 180 }],
      text: 'Transcript timestampato.',
    },
  },
  {
    title: 'Dettaglio complementare',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    youtubeTranscript: {
      ranges: [{ startSeconds: 0, endSeconds: 90 }],
      text: 'Transcript complementare.',
    },
  },
];

test('projects same-video and complementary clips into one carousel at the first valid marker', () => {
  const content = [
    'Introduzione.',
    '',
    '{{YOUTUBE_CLIP_SOURCE:0|START:10|END:30}}',
    '',
    'Secondo passaggio.',
    '',
    '{{YOUTUBE_CLIP_SOURCE:0|START:40|END:70}}',
    '',
    'Dettaglio complementare.',
    '',
    '{{YOUTUBE_CLIP_SOURCE:1|START:5|END:20}}',
    '',
    'Conclusione.',
  ].join('\n');

  const projection = projectYouTubeClipCarousel(content, sources);
  const parts = splitYouTubeClipCarouselContent(projection.content);

  assert.deepEqual(
    projection.clips.map(clip => ({
      endSeconds: clip.endSeconds,
      sourceIndex: clip.sourceIndex,
      startSeconds: clip.startSeconds,
    })),
    [
      { endSeconds: 30, sourceIndex: 0, startSeconds: 10 },
      { endSeconds: 70, sourceIndex: 0, startSeconds: 40 },
      { endSeconds: 20, sourceIndex: 1, startSeconds: 5 },
    ]
  );
  assert.deepEqual(JSON.parse(projection.clips[0]?.id || '{}'), {
    endSeconds: 30,
    markerStart: content.indexOf('{{YOUTUBE_CLIP_SOURCE:0|START:10|END:30}}'),
    sourceIndex: 0,
    startSeconds: 10,
    url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
  });
  assert.equal(parts.filter(part => part.type === 'youtube-carousel').length, 1);
  assert.doesNotMatch(projection.content, /YOUTUBE_CLIP_SOURCE/);
  assert.ok(
    projection.content.indexOf('Introduzione.') <
      projection.content.indexOf('YOUTUBE_CLIP_CAROUSEL')
  );
  assert.ok(
    projection.content.indexOf('YOUTUBE_CLIP_CAROUSEL') <
      projection.content.indexOf('Secondo passaggio.')
  );
});

test('drops invalid markers without moving the carousel ahead of the first validated clip', () => {
  const projection = projectYouTubeClipCarousel(
    [
      'Prima.',
      '',
      '{{YOUTUBE_CLIP_SOURCE:1|START:100|END:120}}',
      '',
      'Seconda.',
      '',
      '{{YOUTUBE_CLIP_SOURCE:0|START:20|END:40}}',
    ].join('\n'),
    sources
  );

  assert.equal(projection.clips.length, 1);
  assert.ok(
    projection.content.indexOf('Seconda.') < projection.content.indexOf('YOUTUBE_CLIP_CAROUSEL')
  );
  assert.doesNotMatch(projection.content, /YOUTUBE_CLIP_SOURCE/);
});
