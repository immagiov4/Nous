import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLibraryArchiveBlob } from '../../../apps/web/services/projects/libraryArchive';
import { createProjectArchiveBlob } from '../../../apps/web/services/projects/projectArchive';
import { normalizeStoredProject } from '../../../apps/web/services/projects/projectSnapshot';
import {
  findLessonSceneProblems,
  LESSON_SCENE_TYPES,
} from '../../../packages/shared-types/lessonScene';
import { captionFindings, outsideBox, visualFindings } from '../atlas/checks';
import { atlasCourses, atlasLessons } from '../atlas/input';
import { pairwiseRows } from '../atlas/pairwise';
import { AtlasScenarioSchema, DEFAULT_PLAYBACK_SCENARIO, viewportOptions } from '../atlas/scenario';
import { SYNTHETIC_FACTORS, syntheticPairwiseCourse, syntheticScene } from '../atlas/synthetic';
import { syntheticCourse } from '../syntheticCourse';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'nous-atlas-test-'));
  roots.push(root);
  return root;
}
describe('playback atlas structural contracts', () => {
  test('distinguishes empty, symbolic and textual visuals while speech is active', () => {
    const empty = { text: '', prose: '', mathCount: 0, mediaCount: 0 };
    expect(visualFindings(empty, 'An explanation.', true).map(finding => finding.kind)).toEqual([
      'visual-empty',
    ]);
    expect(visualFindings({ ...empty, text: ' + → ' }, 'Speech.', true)[0].kind).toBe(
      'visual-symbol-only'
    );
    expect(visualFindings({ ...empty, text: 'σ', mathCount: 1 }, 'Speech.', true)[0].kind).toBe(
      'visual-symbol-only'
    );
    expect(
      visualFindings({ ...empty, text: 'Quantity σ', prose: 'Quantity' }, 'Speech.', true)
    ).toEqual([]);
    expect(visualFindings({ ...empty, mediaCount: 1 }, 'Speech.', true)).toEqual([]);
    expect(visualFindings(empty, '', true)).toEqual([]);
    expect(visualFindings(empty, 'Speech.', false)).toEqual([]);
  });
  test('flags split words even when the same fragments occur elsewhere in the speech', () => {
    const speech = 'let ter letter';
    expect(
      captionFindings(speech, [
        { text: 'let', range: { start: 8, end: 11 } },
        { text: 'ter', range: { start: 11, end: 14 } },
      ]).map(finding => finding.kind)
    ).toEqual(['caption-word-mismatch', 'caption-word-mismatch']);
    expect(captionFindings(speech, [{ text: 'letter', range: { start: 8, end: 14 } }])).toEqual([]);
    expect(
      captionFindings('Hello, world.', [
        { text: 'Hello,', range: { start: 0, end: 6 } },
        { text: 'world.', range: { start: 7, end: 13 } },
      ])
    ).toEqual([]);
    expect(
      captionFindings('The quantity.', [{ text: 'unspoken', range: { start: 4, end: 12 } }])
    ).toHaveLength(1);
  });
  test('records exact clipping amounts without a tolerance', () => {
    const boundary = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(outsideBox({ left: -1, top: 0, right: 101, bottom: 120 }, boundary)).toEqual({
      left: 1,
      top: 0,
      right: 1,
      bottom: 20,
    });
    expect(outsideBox(boundary, boundary)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});
describe('declarative playback scenarios', () => {
  test('declares real desktop, mobile and tablet device settings', () => {
    const scenario = AtlasScenarioSchema.parse(DEFAULT_PLAYBACK_SCENARIO);
    expect(scenario.viewports.map(viewport => viewport.id)).toEqual([
      'desktop',
      'mobile',
      'tablet',
    ]);
    expect(viewportOptions(scenario.viewports[1])).toMatchObject({
      isMobile: true,
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    expect(viewportOptions(scenario.viewports[2]).viewport?.width).toBeGreaterThan(0);
  });
  test('rejects unknown devices, duplicate IDs and unsupported checks', () => {
    expect(() =>
      AtlasScenarioSchema.parse({
        ...DEFAULT_PLAYBACK_SCENARIO,
        viewports: [{ id: 'unknown', device: 'Not a device' }],
      })
    ).toThrow();
    expect(() =>
      AtlasScenarioSchema.parse({
        ...DEFAULT_PLAYBACK_SCENARIO,
        viewports: [{ id: 'duplicate' }, { id: 'duplicate' }],
      })
    ).toThrow();
    expect(() =>
      AtlasScenarioSchema.parse({
        ...DEFAULT_PLAYBACK_SCENARIO,
        checks: ['heuristic-score'],
      })
    ).toThrow();
  });
});
describe('deterministic pairwise synthetic lessons', () => {
  test('covers every declared factor pair with fewer rows than full permutations', () => {
    const factors = { a: ['a0', 'a1'], b: ['b0', 'b1', 'b2'], c: ['c0', 'c1'] };
    const first = pairwiseRows(factors);
    expect(pairwiseRows(factors)).toEqual(first);
    const names = Object.keys(factors) as (keyof typeof factors)[];
    names.forEach((a, index) => {
      for (const b of names.slice(index + 1))
        for (const av of factors[a])
          for (const bv of factors[b])
            expect(first.rows.some(row => row[a] === av && row[b] === bv)).toBe(true);
    });
    expect(first.rows.length).toBeLessThan(2 * 3 * 2);
  });
  test('produces valid scenes for the entire current catalog', () => {
    for (const type of LESSON_SCENE_TYPES)
      expect(findLessonSceneProblems(syntheticScene(type)), type).toEqual([]);
  });
  test('generates stable lessons with observable block, visual and syntax coverage', () => {
    const first = syntheticPairwiseCourse('data:image/png;base64,synthetic');
    expect(syntheticPairwiseCourse('data:image/png;base64,synthetic')).toEqual(first);
    const lessons = atlasLessons(normalizeStoredProject(first));
    const serialized = JSON.stringify(lessons);
    expect(lessons.length).toBeGreaterThan(0);
    for (const kind of SYNTHETIC_FACTORS.contentKind) expect(serialized).toContain(kind);
    for (const kind of SYNTHETIC_FACTORS.visualKind.filter(kind => kind !== 'markdown'))
      expect(serialized).toContain(kind);
    for (const type of LESSON_SCENE_TYPES)
      expect(
        lessons.some(lesson =>
          lesson.visuals.some(
            visual =>
              'render' in visual &&
              visual.render.kind === 'scene' &&
              visual.render.scene.type === type
          )
        ),
        type
      ).toBe(true);
    expect(serialized).toContain(String.raw`\sigma`);
    expect(serialized).toContain('data-nous-annotation-id');
    expect(serialized).toContain('const result');
  });
});
describe('read-only product archive input', () => {
  test('loads normalized real-format library courses without changing the archive', async () => {
    const root = await temporaryRoot();
    const snapshot = normalizeStoredProject(syntheticCourse());
    const project = await createProjectArchiveBlob(snapshot);
    const library = await createLibraryArchiveBlob(
      [snapshot],
      {
        folders: [],
        placements: [
          { projectId: snapshot.id, folderId: null, order: 0, updatedAt: snapshot.updatedAt },
        ],
      },
      {
        createProjectArchive: async () => project,
      }
    );
    const path = join(root, 'library.nous-library.zip');
    const bytes = new Uint8Array(await library.arrayBuffer());
    await writeFile(path, bytes);
    const courses = [];
    for await (const course of atlasCourses({ kind: 'library', path })) courses.push(course);
    expect(courses).toHaveLength(1);
    expect(atlasLessons(courses[0].snapshot)[0].sources[0]).toMatchObject({ type: 'markdown' });
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
  });
  test('refuses private libraries in CI before opening the file', async () => {
    vi.stubEnv('CI', '1');
    const iterator = atlasCourses({ kind: 'library', path: 'private-path-must-not-be-read.zip' });
    await expect(iterator.next()).rejects.toThrow('local-only');
  });
});

import type { Page } from 'playwright';
import { segmentLessonPlayback } from '../../../packages/shared-types/lessonPlayback';
import { atlasStatus, captureTile } from '../playbackAtlas';

test('keeps a failed capture incomplete even when render-error is not an enabled check', async () => {
  const directory = await temporaryRoot();
  const png = await readFile(
    new URL('../../../packages/playtest/tests/fixtures/images/first.png', import.meta.url)
  );
  const lesson = atlasLessons(normalizeStoredProject(syntheticCourse()))[0];
  const page = {
    evaluate: vi.fn().mockRejectedValue(new Error('Synthetic renderer failure.')),
    screenshot: vi.fn().mockResolvedValue(png),
    viewportSize: () => ({ width: 1440, height: 900 }),
  } as unknown as Page;
  const result = await captureTile({
    page,
    directory,
    lesson,
    block: segmentLessonPlayback(lesson.sources)[0],
    position: 'middle',
    visualIndex: null,
    viewport: DEFAULT_PLAYBACK_SCENARIO.viewports[0],
    checks: ['visual-empty'],
    basename: 'failed-capture',
  });
  expect(result.tile.incomplete).toBe(true);
  expect(result.tile.findings.map(finding => finding.kind)).toContain('render-error');
  expect(atlasStatus([], result.tile.findings, result.tile.incomplete)).toBe('incomplete');
  expect(await readFile(join(directory, result.tile.image))).toEqual(png);
});
