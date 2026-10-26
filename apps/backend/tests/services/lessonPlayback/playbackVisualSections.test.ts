import { resolvePlaybackNarration, segmentLessonPlayback } from '@shared/lessonPlayback';
import { isValidLessonPlayback, LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
import { hasPreparedVisualSections, playbackVisualSections } from '@shared/playbackVisualSections';
import { expect, test } from 'vitest';

test.each([
  '\n',
  '\r\n',
])('maps rendering controls, annotations and emoji with %j line endings', newline => {
  const ansiEscape = String.fromCharCode(27);
  const sources = [
    {
      type: 'markdown' as const,
      markdown: `${ansiEscape}[31m1. Primo 🧭 punto.${ansiEscape}[0m${newline}2. Secondo <mark data-nous-annotation-id="note">punto</mark>.`,
    },
  ];
  const block = segmentLessonPlayback(sources)[0];
  expect(
    playbackVisualSections(block, sources)[0].items?.map(range =>
      block.speech.slice(range.start, range.end)
    )
  ).toEqual(['Primo 🧭 punto.', 'Secondo punto.']);
});

test('introduces a list under its spoken heading and keeps authored code literal', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: '## Piano\n1. Primo punto.\n2. Secondo punto.\n\n```js\n1. Not a spoken list\n```',
    },
  ];
  const block = segmentLessonPlayback(sources)[0];
  const sections = playbackVisualSections(block, sources);
  expect(sections).toHaveLength(1);
  expect(block.speech.slice(sections[0].range.start, sections[0].range.end)).toBe(
    'Piano\nPrimo punto.\nSecondo punto.'
  );
  expect(sections[0].items?.map(range => block.speech.slice(range.start, range.end))).toEqual([
    'Primo punto.',
    'Secondo punto.',
  ]);
  expect(block.visuals).toEqual([
    { kind: 'markdown', markdown: '```js\n1. Not a spoken list\n```' },
  ]);
});

test('retains passage preparation for individually recorded loose-list items', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '1. Prima decisione. Una spiegazione.\n\n2. Seconda decisione. Un’altra spiegazione.',
    },
  ];
  const blocks = segmentLessonPlayback(sources);
  expect(blocks).toHaveLength(2);
  expect(blocks.map(block => playbackVisualSections(block, sources))).toEqual([[], []]);
});

test('preserves recording blocks while mapping every list item and catalog-sized successor', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        'Riepilogo.\n1. Primo punto.\n2. Secondo punto.\n3. Terzo punto.\n4. Quarto punto.\n5. Quinto punto.\n6. Sesto punto.\n7. Settimo punto.\n\nDopo la lista.',
    },
  ];
  const blocks = segmentLessonPlayback(sources);
  expect(blocks.map(block => block.id)).toEqual(['0', '1', '2']);
  const sections = playbackVisualSections(blocks[1], sources);
  expect(
    sections.map(section =>
      section.items?.map(range => blocks[1].speech.slice(range.start, range.end))
    )
  ).toEqual([
    ['Primo punto.', 'Secondo punto.', 'Terzo punto.', 'Quarto punto.', 'Quinto punto.'],
    ['Sesto punto.', 'Settimo punto.'],
  ]);
  expect(sections[1].range).toEqual({
    start: blocks[1].speech.indexOf('Sesto'),
    end: blocks[1].speech.length,
  });
  expect(playbackVisualSections(blocks[2], sources)).toEqual([]);
});

test('uses canonical spoken math and exact repeated-item ranges without invalidating a completed preparation', () => {
  const sources = [{ type: 'markdown' as const, markdown: '- Valore $x$.\n- Valore $x$.' }];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: {
      spokenMath: [
        { formula: '$x$', spoken: 'ics' },
        { formula: '$x$', spoken: 'ics' },
      ],
      motion: [],
    },
  };
  const spoken = resolvePlaybackNarration(block);
  const sections = playbackVisualSections(block, sources);
  expect(sections[0].items?.map(range => spoken.speech.slice(range.start, range.end))).toEqual([
    'Valore ics.',
    'Valore ics.',
  ]);
  const scene = {
    type: 'parts' as const,
    title: 'Valori',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [
      { label: 'Primo', detail: '', icon: '' },
      { label: 'Secondo', detail: '', icon: '' },
    ],
  };
  expect(
    hasPreparedVisualSections(
      {
        ...block,
        prepared: { ...block.prepared, sections: sections.map(section => ({ ...section, scene })) },
      },
      sources
    )
  ).toBe(true);
  expect(hasPreparedVisualSections(block, sources)).toBe(false);
  const prepared = {
    ...block.prepared,
    sections: sections.map(section => ({ ...section, scene })),
  };
  expect(
    hasPreparedVisualSections(LessonPlaybackBlockSchema.parse({ ...block, prepared }), sources)
  ).toBe(true);
  const playback = { version: 1, lessonKey: 'a'.repeat(64), blocks: [{ ...block, prepared }] };
  expect(isValidLessonPlayback(playback)).toBe(true);
  expect(
    isValidLessonPlayback({
      ...playback,
      blocks: [
        {
          ...block,
          prepared: {
            ...prepared,
            sections: [
              { ...prepared.sections[0], range: { start: 0, end: spoken.speech.length + 1 } },
            ],
          },
        },
      ],
    })
  ).toBe(false);
});
