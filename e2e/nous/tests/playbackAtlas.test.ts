import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import type { Page } from 'playwright';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLibraryArchiveBlob } from '../../../apps/web/services/projects/libraryArchive';
import {
  createProjectArchiveBlob,
  inspectProjectArchiveData,
} from '../../../apps/web/services/projects/projectArchive';
import { normalizeStoredProject } from '../../../apps/web/services/projects/projectSnapshot';
import { parseMarkdownAnalysis } from '../../../apps/web/utils/markdown/codeRanges';
import { segmentLessonPlayback } from '../../../packages/shared-types/lessonPlayback';
import {
  findLessonSceneProblems,
  LESSON_SCENE_TYPES,
} from '../../../packages/shared-types/lessonScene';
import { captionFindings, outsideBox, visualFindings } from '../atlas/checks';
import { atlasStageReady } from '../atlas/dom';
import { atlasCourses, atlasLessons } from '../atlas/input';
import { pairwiseRows } from '../atlas/pairwise';
import { writeAtlasArtifact } from '../atlas/report';
import { AtlasScenarioSchema, DEFAULT_PLAYBACK_SCENARIO, viewportOptions } from '../atlas/scenario';
import { speechMathFindings, speechPunctuationTokens } from '../atlas/speech';
import { SYNTHETIC_FACTORS, syntheticPairwiseCourse, syntheticScene } from '../atlas/synthetic';
import { resetAtlasRandom } from '../atlas/timing';
import {
  assertWindowsAtlasLocation,
  atlasKatexCss,
  atlasStatus,
  captureTile,
  privateAtlasDirectory,
} from '../playbackAtlas';
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
    // The archive is generated below; exercise the local reader independently of the host CI flag.
    vi.stubEnv('CI', '');
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
  expect(result.tile.speech).toBe(segmentLessonPlayback(lesson.sources)[0].speech);
  expect(result.tile.findings.map(finding => finding.kind)).toContain('render-error');
  expect(atlasStatus([], result.tile.findings, result.tile.incomplete)).toBe('incomplete');
  expect((await readFile(join(directory, result.tile.image))).subarray(1, 4).toString()).toBe(
    'PNG'
  );
  expect(page.screenshot).not.toHaveBeenCalled();
});

function inspectSyntheticSpeech(markdown: string) {
  const sources = [{ type: 'markdown' as const, markdown }];
  const blocks = segmentLessonPlayback(sources);
  const analyzed = [{ sourceBlockIndex: 0, markdown, analysis: parseMarkdownAnalysis(markdown) }];
  return {
    blocks,
    findings: blocks.flatMap(block => speechMathFindings({ block, blocks, sources: analyzed })),
  };
}

test('flags source inline math missing from real speech and retains its exact gap', () => {
  const {
    blocks: [block],
    findings,
  } = inspectSyntheticSpeech('The value $y$ can be $0$ or $1$: for example.');
  expect(block.speech).toBe('The value  can be  or : for example.');
  expect(findings.map(finding => finding.kind)).toEqual([
    'speech-inline-math-omitted',
    'speech-inline-math-omitted',
    'speech-inline-math-omitted',
  ]);
  expect(findings.map(finding => (finding.detail as { markdown: string }).markdown)).toEqual([
    '$y$',
    '$0$',
    '$1$',
  ]);
  const last = findings.at(-1)?.detail as { speechGap: { start: number; end: number } };
  expect(block.speech.slice(last.speechGap.start, last.speechGap.end)).toBe('');
  expect(block.speech[last.speechGap.end]).toBe(':');
});

test('accepts mapped spoken forms and excludes code and display math from the inline check', () => {
  const markdown = '$x$ plus $y$';
  const original = segmentLessonPlayback([{ type: 'markdown', markdown }])[0];
  const block = {
    ...original,
    speech: 'x plus y',
    spans: [
      {
        sourceBlockIndex: 0,
        source: { start: 0, end: markdown.length },
        speech: { start: 0, end: 8 },
      },
    ],
  };
  expect(
    speechMathFindings({
      block,
      blocks: [block],
      sources: [{ sourceBlockIndex: 0, markdown, analysis: parseMarkdownAnalysis(markdown) }],
    })
  ).toEqual([]);
  for (const text of [
    'Photo ![image](https://example.test/$x$).',
    'A [link](https://example.test/$x$).',
    'Text <mark title="$x$">content</mark>.',
    'A literal `$x$` value.',
    'Introduction.\n\n$$x=1$$\n\nContinue.',
  ]) {
    expect(inspectSyntheticSpeech(text).findings).toEqual([]);
  }
});

test('records standalone punctuation as raw tokens without making it a failure', () => {
  expect(speechPunctuationTokens('Value  or : example.')).toEqual([
    { text: ':', start: 10, end: 11 },
  ]);
  expect(speechPunctuationTokens('A sentence.')).toEqual([]);
});

test('finds inline math on unspoken source lines without attributing other blocks math', () => {
  const trailing = inspectSyntheticSpeech('The value is:\n$x$');
  expect(trailing.findings).toHaveLength(1);
  expect(trailing.findings[0].detail).toMatchObject({ markdown: '$x$', adjacentBlockIds: ['0'] });
  const separated = inspectSyntheticSpeech('First $x$.\n\nSecond $y$.');
  expect(separated.findings.map(finding => finding.detail)).toMatchObject([
    { markdown: '$x$', adjacentBlockIds: ['0'] },
    { markdown: '$y$', adjacentBlockIds: ['1'] },
  ]);
  const between = inspectSyntheticSpeech('First.\n\n$x$\n\nSecond.');
  expect(between.findings).toHaveLength(2);
  expect(
    between.findings.every(
      finding =>
        (finding.detail as { adjacentBlockIds: string[] }).adjacentBlockIds.join(',') === '0,1'
    )
  ).toBe(true);
});

test('requires canonical Windows atlas output inside the user profile', () => {
  expect(() =>
    assertWindowsAtlasLocation('C:/Users/owner/nous-atlas/run', 'C:/Users/owner')
  ).not.toThrow();
  for (const path of [
    'D:/shared/run',
    'C:/Users/owner-neighbor/run',
    'C:/Users/owner/../public/run',
  ]) {
    expect(() => assertWindowsAtlasLocation(path, 'C:/Users/owner')).toThrow('user profile');
  }
  expect(() =>
    assertWindowsAtlasLocation(win32.resolve('C:/Users/owner'), 'C:/Users/owner')
  ).not.toThrow();
});

test('resolves KaTeX CSS through the selected source checkout dependencies', async () => {
  const root = await temporaryRoot();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'node_modules/rehype-katex/node_modules/katex/dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'node_modules/rehype-katex/package.json'), '{"main":"index.js"}');
  await writeFile(join(root, 'node_modules/rehype-katex/index.js'), '');
  await writeFile(join(root, 'node_modules/rehype-katex/node_modules/katex/package.json'), '{}');
  const css = join(root, 'node_modules/rehype-katex/node_modules/katex/dist/katex.min.css');
  await writeFile(css, '/* selected checkout */');
  expect(atlasKatexCss(root)).toBe(css);
});

test.each([
  'version',
  'isLearnMode',
  'syllabus',
  'learningPlan',
])('rejects project ZIPs refused by the app when %s is missing', async field => {
  const root = await temporaryRoot();
  const snapshot = normalizeStoredProject(syntheticCourse());
  const archive = await createProjectArchiveBlob(snapshot);
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const entry = zip.file('project.json');
  if (!entry) throw new Error('Synthetic archive manifest missing.');
  const manifest = JSON.parse(await entry.async('string'));
  manifest.archiveVersion = 1;
  delete manifest.attachments;
  delete manifest.project.projectFormatVersion;
  delete manifest.project[field];
  zip.file('project.json', JSON.stringify(manifest));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const path = join(root, 'invalid.nous.zip');
  await writeFile(path, bytes);
  await expect(inspectProjectArchiveData(new Blob([bytes]))).rejects.toThrow();
  await expect(atlasCourses({ kind: 'project', path }).next()).rejects.toThrow();
});

test('waits for archive-backed PDF figures to mount before accepting the stage', () => {
  const dom = new JSDOM(
    '<div class="scene-host"><article><figure data-nous-speech="ignore"><figcaption>Caption</figcaption></figure></article></div>'
  );
  vi.stubGlobal('document', dom.window.document);
  try {
    expect(atlasStageReady()).toBe(false);
    const figure = dom.window.document.querySelector('figure');
    if (!figure) throw new Error('Synthetic PDF figure missing.');
    const image = dom.window.document.createElement('img');
    image.setAttribute('data-pdf-asset-id', 'synthetic-asset');
    Object.defineProperty(image, 'complete', { value: false, configurable: true });
    figure.append(image);
    expect(atlasStageReady()).toBe(false);
    Object.defineProperty(image, 'complete', { value: true });
    expect(atlasStageReady()).toBe(true);
    image.remove();
    figure.innerHTML = '<span role="img" aria-label="Unavailable">Unavailable</span>';
    expect(atlasStageReady()).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    dom.window.close();
  }
});

test.skipIf(process.platform === 'win32')(
  'keeps private run directories and artifacts owner-only on POSIX',
  async () => {
    const root = await temporaryRoot();
    const { directory } = await privateAtlasDirectory(root, process.cwd());
    const path = join(directory, 'private.json');
    await writeAtlasArtifact(path, '{}');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
);

test('restarts the same random sequence before each visual executes', () => {
  const original = Math.random;
  try {
    resetAtlasRandom();
    const first = Array.from({ length: 4 }, () => Math.random());
    resetAtlasRandom();
    const second = Array.from({ length: 4 }, () => Math.random());
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first.every(value => value >= 0 && value < 1)).toBe(true);
  } finally {
    Math.random = original;
  }
});
