import { hasOmittedPlaybackMath } from '@shared/lessonPlayback';
import {
  collectProjectAssetReferences,
  remapProjectAssetReferences,
} from '@shared/projectBackupAssets';
import { canonicalizeLessonNodeContent } from '@shared/projectSnapshotWire';
import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import {
  buildLessonPlaybackKey,
  readLessonPlayback,
  reconcileLessonPlayback,
} from '../../src/projects/lessonPlayback.js';
import { reconcileProjectAssets } from '../../src/projects/projectAssetReconciliation.js';
import {
  buildLessonGenerationSourceFingerprint,
  snapshotLessonGenerationTarget,
} from '../../src/workflows/lessonGenerationAuthority.js';
import {
  playbackAsset,
  playbackProject,
  playbackSection,
  preparedPlayback,
} from '../helpers/lessonPlayback.js';

describe('playback persistence and assets', () => {
  test('literal visual references in table code do not depend on stored visuals', () => {
    const section = playbackSection();
    section.contentBlocks = [
      {
        type: 'markdown',
        markdown: 'Introduction.\n\n| Code |\n| --- |\n| `{{VISUAL_EXAMPLE:old-visual}}` |',
      },
    ];
    const key = buildLessonPlaybackKey(section);
    section.generatedVisuals = [
      { id: 'old-visual', kind: 'svg', code: '<svg />', title: 'Unused', createdAt: 'now' },
    ];
    expect(buildLessonPlaybackKey(section)).toBe(key);
  });
  test.each([
    'Introduction.\n\n{{VISUAL_EXAMPLE:old-visual}}',
    'Introduction.\n\n| Diagram |\n| --- |\n| {{VISUAL_EXAMPLE:old-visual}} |',
  ])('historical Markdown visual references include their stored content in playback identity: %s', markdown => {
    const section = playbackSection();
    section.contentBlocks = [{ type: 'markdown', markdown }];
    section.generatedVisuals = [
      { id: 'old-visual', kind: 'svg', code: '<svg />', title: 'Diagram', createdAt: 'now' },
    ];
    const key = buildLessonPlaybackKey(section);
    const blocks = readLessonPlayback(section).blocks;
    expect(blocks[0].speech).toBe('Introduction.');
    expect(blocks[0].visuals.filter(visual => visual.kind === 'generated-visual')).toEqual([
      { kind: 'generated-visual', visualId: 'old-visual' },
    ]);
    section.generatedVisuals = [
      { ...section.generatedVisuals[0], code: '<svg><title>Updated</title></svg>' },
    ];
    expect(buildLessonPlaybackKey(section)).not.toBe(key);
  });
  test('ordinary saves preserve server playback and their concurrent annotations', () => {
    const original = playbackSection();
    original.playback = preparedPlayback(original);
    const saved = playbackProject({ ...playbackSection(), annotations: [{ id: 'new-note' }] });
    reconcileLessonPlayback(saved, playbackProject(original));
    expect(saved.learningPlan?.sections?.[0]).toMatchObject({
      playback: original.playback,
      annotations: [{ id: 'new-note' }],
    });
  });
  test.each([
    null,
    'without the section',
  ])('ordinary writes drop client playback on a new project or section (%s)', previousCase => {
    const section = playbackSection();
    section.playback = preparedPlayback(section);
    const created = playbackProject(section);
    const previous =
      previousCase === null ? null : playbackProject({ ...playbackSection(), id: 'other' });
    reconcileLessonPlayback(created, previous);
    expect(created.learningPlan?.sections?.[0]).not.toHaveProperty('playback');
  });
  test.each([
    { contentBlocks: [{ type: 'markdown', markdown: 'Nuova lezione.' }] },
    { lastGenerationRunId: 'generation-2' },
  ])('content replacement invalidates playback and queues its audio: %j', async replacement => {
    const original = playbackSection();
    original.playback = preparedPlayback(original);
    const before = playbackProject(original);
    const after = playbackProject({ ...original, ...replacement });
    reconcileLessonPlayback(after, before);
    expect(after.learningPlan?.sections?.[0]).not.toHaveProperty('playback');
    const queued: unknown[] = [];
    const transaction = vi.fn((strings, ...values) => {
      if (
        Array.isArray(strings) &&
        typeof strings[0] === 'string' &&
        strings[0].includes('update public.project_assets')
      ) {
        queued.push(...values.at(-1));
        return Promise.resolve([{ id: playbackAsset.id }]);
      }
      return strings;
    }) as unknown as TransactionSql;
    expect(
      await reconcileProjectAssets(transaction, {
        previousSnapshot: before,
        snapshot: after,
        projectId: after.id,
        userId: 'local-user',
      })
    ).toBe(1);
    expect(queued).toEqual([playbackAsset.id]);
  });
  test('same-content saves discard stale client playback in favor of server data', () => {
    const original = playbackSection();
    original.playback = preparedPlayback(original);
    const candidate = playbackProject({
      ...original,
      playback: { ...original.playback, blocks: [] },
    });
    reconcileLessonPlayback(candidate, playbackProject(original));
    expect(candidate.learningPlan?.sections?.[0]?.playback).toEqual(original.playback);
  });
  test('keys ignore notes and unused visuals but include referenced visual changes', () => {
    const section = playbackSection();
    const key = buildLessonPlaybackKey(section);
    expect(
      buildLessonPlaybackKey({
        ...section,
        annotations: [{ id: 'note' }],
        generatedVisuals: [{ id: 'unused' }],
      })
    ).toBe(key);
    const visual = {
      id: 'visual-1',
      slotId: 'slot',
      createdAt: 'now',
      render: { kind: 'image', asset: { ...playbackAsset, mediaType: 'image/png' } },
    };
    section.contentBlocks = [
      ...(section.contentBlocks as unknown[]),
      { type: 'generated-visual', slotId: 'slot', visualId: visual.id },
    ];
    section.generatedVisuals = [visual];
    const referencedKey = buildLessonPlaybackKey(section);
    section.generatedVisuals = [
      {
        ...visual,
        render: { ...visual.render, asset: { ...visual.render.asset, hash: 'c'.repeat(64) } },
      },
    ];
    expect(buildLessonPlaybackKey(section)).not.toBe(referencedKey);
  });
  test.each([
    'html',
    'image',
    'mermaid',
    'svg',
  ])('reads preserved historical %s visuals and hashes their content', kind => {
    const section = playbackSection();
    const visual = {
      id: 'historical-visual',
      title: 'Visuale storica',
      createdAt: '2026-08-28T12:00:00Z',
      kind,
      code: 'Contenuto storico',
    };
    section.generatedVisuals = [visual];
    section.contentBlocks = [
      { type: 'markdown', markdown: 'Introduzione.' },
      { type: 'generated-visual', slotId: 'historical-slot', visualId: visual.id },
    ];
    const canonical = canonicalizeLessonNodeContent(section);
    const key = buildLessonPlaybackKey(canonical);
    expect(readLessonPlayback(canonical)).toMatchObject({
      lessonKey: key,
      blocks: [
        { speech: 'Introduzione.', visuals: [{ kind: 'generated-visual', visualId: visual.id }] },
      ],
    });
    expect(canonical.generatedVisuals).toEqual([visual]);
    expect(
      buildLessonPlaybackKey({
        ...canonical,
        generatedVisuals: [{ ...visual, code: 'Modificato' }],
      })
    ).not.toBe(key);
  });
  test.each([
    true,
    false,
  ])('backup collection and import remap audio without requiring visuals (modules: %s)', modules => {
    const section = playbackSection();
    section.playback = preparedPlayback(section);
    const project = playbackProject(section);
    if (modules) project.learningPlan = { modules: [{ id: 'module', children: [section] }] };
    expect(collectProjectAssetReferences(project)).toEqual([playbackAsset]);
    const imported = remapProjectAssetReferences(
      project,
      new Map([[playbackAsset.id, 'd'.repeat(64)]]),
      'imported'
    );
    expect(collectProjectAssetReferences(imported)).toEqual([
      { ...playbackAsset, id: 'd'.repeat(64) },
    ]);
    expect(collectProjectAssetReferences(project)).toEqual([playbackAsset]);
  });

  test('remapping preserves newer playback metadata at every nesting level', () => {
    const section = playbackSection();
    const saved = preparedPlayback(section);
    const playback = {
      ...saved,
      futurePlayback: 'retain',
      blocks: saved.blocks.map(block => ({
        ...block,
        futureBlock: 'retain',
        prepared: { ...block.prepared, futureScene: 'retain' },
        audio: block.audio.map(audio => ({ ...audio, futureAudio: 'retain' })),
      })),
    };
    section.playback = playback;
    const imported = remapProjectAssetReferences(
      playbackProject(section),
      new Map([[playbackAsset.id, 'd'.repeat(64)]])
    );
    expect(imported.learningPlan?.sections?.[0]?.playback).toEqual({
      ...playback,
      blocks: playback.blocks.map(block => ({
        ...block,
        audio: block.audio.map(audio => ({
          ...audio,
          asset: { ...audio.asset, id: 'd'.repeat(64) },
        })),
      })),
    });
    expect(section.playback).toBe(playback);
  });

  test.each([
    { title: 'Titolo corretto' },
    { description: 'Contesto corretto' },
  ])('invalidates preparation when lesson context changes: %j', change => {
    const original = playbackSection();
    original.playback = preparedPlayback(original);
    const changed = { ...original, ...change };
    const after = playbackProject(changed);
    expect(buildLessonPlaybackKey(changed)).not.toBe(original.playback.lessonKey);
    reconcileLessonPlayback(after, playbackProject(original));
    expect(after.learningPlan?.sections?.[0]).not.toHaveProperty('playback');
  });
  test('imported images retain the lesson key while audio and image IDs are remapped', () => {
    const section = playbackSection();
    const image = { ...playbackAsset, id: 'e'.repeat(64), mediaType: 'image/png' };
    section.generatedVisuals = [
      { id: 'visual', slotId: 'slot', createdAt: 'now', render: { kind: 'image', asset: image } },
    ];
    section.contentBlocks = [
      ...(section.contentBlocks as unknown[]),
      { type: 'generated-visual', slotId: 'slot', visualId: 'visual' },
    ];
    section.playback = preparedPlayback(section);
    const imported = remapProjectAssetReferences(
      playbackProject(section),
      new Map([
        [playbackAsset.id, 'd'.repeat(64)],
        [image.id, 'f'.repeat(64)],
      ])
    );
    const importedSection = imported.learningPlan?.sections?.[0];
    if (!importedSection) throw new Error('Missing imported lesson');
    expect(readLessonPlayback(importedSection).blocks[0]?.audio[0]?.asset.id).toBe('d'.repeat(64));
  });
  test('playback changes neither generation inputs nor rollback snapshots', () => {
    const section = playbackSection();
    const before = playbackProject(section);
    const after = playbackProject({ ...section, playback: preparedPlayback(section) });
    expect(buildLessonGenerationSourceFingerprint(after, 'section-1')).toBe(
      buildLessonGenerationSourceFingerprint(before, 'section-1')
    );
    expect(snapshotLessonGenerationTarget(after, 'section-1')).toEqual(
      snapshotLessonGenerationTarget(before, 'section-1')
    );
  });
  test('wire validation accepts playback and rejects malformed audio even on legacy content', () => {
    const section = playbackSection();
    section.playback = preparedPlayback(section);
    expect(canonicalizeLessonNodeContent(section).playback).toEqual(section.playback);
    expect(() =>
      canonicalizeLessonNodeContent({
        ...section,
        contentBlocks: undefined,
        playback: {
          ...section.playback,
          blocks: [{ ...section.playback.blocks[0], audio: [{ asset: {} }] }],
        },
      })
    ).toThrow();
  });

  test.each([
    'image/png',
    'audio/wav',
    'audio/ogg',
    'audio/mp3',
  ])('rejects imported playback assets outside canonical MP3: %s', mediaType => {
    const section = playbackSection();
    const playback = preparedPlayback(section);
    playback.blocks[0].audio[0].asset = { ...playbackAsset, mediaType };
    section.playback = playback;
    expect(() => canonicalizeLessonNodeContent(section)).toThrow();
    expect(() => collectProjectAssetReferences(playbackProject(section))).toThrow();
    expect(() => remapProjectAssetReferences(playbackProject(section), new Map())).toThrow();
  });

  test.each([
    (saved: ReturnType<typeof preparedPlayback>) => {
      Object.assign(saved.blocks[0], {
        spans: [{ ...saved.blocks[0].spans[0], speech: { start: 10, end: 2 } }],
      });
    },
    (saved: ReturnType<typeof preparedPlayback>) => {
      Object.assign(saved.blocks[0], {
        spans: [{ ...saved.blocks[0].spans[0], source: { start: 10, end: 2 } }],
      });
    },
    (saved: ReturnType<typeof preparedPlayback>) => {
      saved.blocks[0].audio[0].asset = { ...playbackAsset, id: 'z'.repeat(64) };
    },
    (saved: ReturnType<typeof preparedPlayback>) => {
      saved.blocks[0].audio[0].asset = { ...playbackAsset, hash: 'z'.repeat(64) };
    },
    (saved: ReturnType<typeof preparedPlayback>) => {
      saved.blocks[0].audio[0].asset = { ...playbackAsset, byteSize: Number.MAX_SAFE_INTEGER + 1 };
    },
    (saved: ReturnType<typeof preparedPlayback>) => {
      saved.blocks[0].audio[0].asset = { ...playbackAsset, mediaType: ' ; charset=utf8' };
    },
    (saved: ReturnType<typeof preparedPlayback>) => {
      Object.assign(saved.blocks[0].prepared, {
        scene: {
          type: 'comparison',
          title: 'Esempio',
          body: '',
          note: '',
          quote: '',
          items: [],
          groups: [
            { label: 'A', items: [' '], icons: [''] },
            { label: 'B', items: ['Due'], icons: [''] },
          ],
        },
      });
    },
    (saved: ReturnType<typeof preparedPlayback>) => {
      Object.assign(saved.blocks[0], {
        visuals: [
          {
            kind: 'scene',
            scene: {
              type: 'comparison',
              title: 'Esempio',
              body: '',
              note: '',
              quote: '',
              items: [],
              groups: [
                { label: 'A', items: [''], icons: [''] },
                { label: 'B', items: ['Due'], icons: [''] },
              ],
            },
          },
        ],
      });
    },
  ])('project and backup boundaries reject malformed playback invariants', corrupt => {
    const section = playbackSection();
    section.playback = preparedPlayback(section);
    corrupt(section.playback as ReturnType<typeof preparedPlayback>);
    expect(() => canonicalizeLessonNodeContent(section)).toThrow();
    expect(() => collectProjectAssetReferences(playbackProject(section))).toThrow();
  });
});

test('does not reuse saved scene or audio when spoken projection has changed', () => {
  const markdown =
    'A system has <mark data-nous-annotation-id="note">boundaries</mark> and interactions.';
  const section = {
    ...playbackSection(),
    content: markdown,
    contentBlocks: [{ type: 'markdown' as const, markdown }],
  };
  const saved = preparedPlayback(section);
  const legacy = { ...saved, blocks: saved.blocks.map(block => ({ ...block, speech: markdown })) };
  const current = readLessonPlayback({ ...section, playback: legacy });
  expect(current.blocks[0].speech).toBe('A system has boundaries and interactions.');
  expect(current.blocks[0].audio).toEqual([]);
  expect(current.blocks[0]).not.toHaveProperty('prepared');
  expect(section.content).toBe(markdown);
});

// Captured from origin/main 3724874 before the annotation projection identity change.
const LEGACY_UNANNOTATED_KEY = '8f8e203c1724abd815a2b5ae308df626f57a0b18d32f43fd1288335471424bab';
const annotatedSection = (markdown: string) => ({
  ...playbackSection(),
  content: markdown,
  contentBlocks: [{ type: 'markdown' as const, markdown }],
});

test('keeps the main-branch key for unannotated lessons', () => {
  expect(buildLessonPlaybackKey(playbackSection())).toBe(LEGACY_UNANNOTATED_KEY);
});

test('annotation edits preserve the projected speech identity rather than annotation ids or ranges', () => {
  const first = annotatedSection(
    'A system has <mark data-nous-annotation-id="note">boundaries</mark> and interactions.'
  );
  const edited = annotatedSection(
    '<mark data-nous-annotation-id="other">A system</mark> has boundaries and <mark title="updated">interactions</mark>.'
  );
  const legacyKey = 'e8489e83fbb9ff282833c647795465b5ee95f5a75253ea899ae6d5667958652f';
  expect(buildLessonPlaybackKey(first)).not.toBe(legacyKey);
  expect(buildLessonPlaybackKey(edited)).toBe(buildLessonPlaybackKey(first));
  first.playback = preparedPlayback(first);
  expect(readLessonPlayback({ ...edited, playback: first.playback }).blocks[0].audio).toEqual(
    first.playback.blocks[0].audio
  );
});

test('removing the final wrapper returns to the valid unannotated key and cache', () => {
  const plain = playbackSection();
  const legacy = preparedPlayback(plain);
  const annotated = {
    ...plain,
    contentBlocks: [
      { type: 'markdown' as const, markdown: '<mark>Prima frase.</mark>\n\nSeconda frase.' },
    ],
  };
  expect(buildLessonPlaybackKey(annotated)).not.toBe(LEGACY_UNANNOTATED_KEY);
  expect(buildLessonPlaybackKey({ ...plain, playback: legacy })).toBe(LEGACY_UNANNOTATED_KEY);
  expect(readLessonPlayback({ ...plain, playback: legacy }).blocks[0].audio).toEqual(
    legacy.blocks[0].audio
  );
});

test('annotated identity distinguishes speech when wrapper placement changes Markdown parsing', () => {
  const first = annotatedSection('a_<mark>b</mark>_');
  const second = annotatedSection('a<mark>_b_</mark>');
  expect(readLessonPlayback(first).blocks[0].speech).toBe('a_b_');
  expect(readLessonPlayback(second).blocks[0].speech).toBe('ab');
  expect(buildLessonPlaybackKey(first)).not.toBe(buildLessonPlaybackKey(second));
});

test('multiline annotations gain a stable visible speech identity', () => {
  const first = annotatedSection(
    '<mark data-nous-annotation-id="first">\nPassage visible.\n</mark>'
  );
  const edited = annotatedSection(
    '<mark title="updated" data-nous-annotation-id="second">\nPassage visible.\n</mark>'
  );
  expect(readLessonPlayback(first).blocks[0].speech).toBe('\nPassage visible.\n');
  expect(buildLessonPlaybackKey(first)).toBe(buildLessonPlaybackKey(edited));
  expect(buildLessonPlaybackKey(first)).not.toBe(
    buildLessonPlaybackKey(annotatedSection('\nPassage visible.\n'))
  );
});

test('refreshes contextual math visuals while reusing matching stored speech and audio', () => {
  const section = {
    ...playbackSection(),
    contentBlocks: [{ type: 'markdown', markdown: 'Read $x$ as the input; $y$ as the output.' }],
  };
  const current = readLessonPlayback(section);
  const audio = [{ model: 'tts', voice: 'Kore', asset: playbackAsset, durationSeconds: 12 }];
  const saved = {
    ...section,
    playback: {
      ...current,
      blocks: current.blocks.map(block => ({
        ...block,
        visuals: [
          { kind: 'markdown' as const, markdown: '$x$' },
          { kind: 'markdown' as const, markdown: '$y$' },
        ],
        prepared: { motion: [] },
        audio,
      })),
    },
  };
  const restored = readLessonPlayback(saved);
  expect(restored.lessonKey).toBe(current.lessonKey);
  expect(restored.blocks[0].visuals).toEqual([
    { kind: 'markdown', markdown: section.contentBlocks[0].markdown },
  ]);
  expect(restored.blocks[0].speech).toBe(current.blocks[0].speech);
  expect(restored.blocks[0].audio).toEqual(audio);
  expect(restored.blocks[0].prepared).toEqual({ motion: [] });
});

test('quiz learner state preserves prepared playback for annotated lessons', () => {
  const section = annotatedSection(
    'A <mark data-nous-annotation-id="note">system</mark> has boundaries.'
  );
  const playback = preparedPlayback(section);
  const answered = { ...section, playback, quizState: { answers: [1], isSubmitted: true } };
  expect(buildLessonPlaybackKey(answered)).toBe(buildLessonPlaybackKey(section));
  expect(readLessonPlayback(answered).blocks[0].audio).toEqual(playback.blocks[0].audio);
});

test('reading source math identifies legacy silent audio while preserving its saved preparation', () => {
  const section = playbackSection();
  section.contentBlocks = [{ type: 'markdown', markdown: 'Consideriamo $x^2$. Poi proseguiamo.' }];
  const saved = preparedPlayback(section);
  // The old writer had no inline-math markers; source projection must recover them on read.
  section.playback = {
    ...saved,
    blocks: saved.blocks.map(block => ({
      ...block,
      spans: block.spans.filter(span => !span.math),
    })),
  };
  const actual = readLessonPlayback(section).blocks[0];
  expect(hasOmittedPlaybackMath(actual)).toBe(true);
  expect(actual.audio).toEqual(saved.blocks[0].audio);
  expect(actual.prepared).toBe(saved.blocks[0].prepared);
  expect(readLessonPlayback(section).lessonKey).toBe(saved.lessonKey);
});

test('reprepares ambiguous historical fences once and then reuses the classified recording', () => {
  const section = annotatedSection(
    'Introduction.\n\n```text\nAn ordered pair has two components.\n```'
  );
  const saved = preparedPlayback(section);
  const historical = readLessonPlayback({ ...section, playback: saved });
  expect(historical.blocks[0].audio).toEqual([]);
  expect(historical.blocks[0].prepared).toBeUndefined();
  const classified = {
    ...saved,
    blocks: saved.blocks.map(block => ({
      ...block,
      prepared: {
        motion: [],
        spokenMath: [],
        fencedCode: [
          { visualIndex: 0, kind: 'prose' as const, spoken: 'An ordered pair has two components.' },
        ],
      },
    })),
  };
  const restored = readLessonPlayback({ ...section, playback: classified });
  expect(restored.blocks[0].audio).toEqual(classified.blocks[0].audio);
  expect(restored.blocks[0].prepared).toEqual(classified.blocks[0].prepared);
  expect(section.content).toBe(
    'Introduction.\n\n```text\nAn ordered pair has two components.\n```'
  );
});

test('keeps recorded inline pronunciations and audio when display math gains a source marker', () => {
  const section = playbackSection();
  section.contentBlocks = [
    {
      type: 'markdown',
      markdown: 'Consideriamo $x$.\n\n$$x = 2$$\n\nPoi proseguiamo.'.replaceAll('\\n', '\n'),
    },
  ];
  const saved = preparedPlayback(section);
  const first = saved.blocks[0];
  const prepared = { ...first.prepared, motion: [], spokenMath: [{ formula: '$x$', spoken: 'ics' }] };
  section.playback = {
    ...saved,
    blocks: [
      { ...first, spans: first.spans.filter(span => !span.math?.startsWith('$$')), prepared },
      ...saved.blocks.slice(1),
    ],
  };
  const restored = readLessonPlayback(section).blocks[0];
  expect(restored.audio).toEqual(first.audio);
  expect(restored.prepared).toBe(prepared);
  expect(restored.spans.flatMap(span => (span.math ? [span.math] : []))).toEqual(['$x$']);
});
