import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { runCommand } from '../src/cli';
import { formatCoverageMap } from '../src/coverage';
import { loadStories } from '../src/stories';

const fixtures = fileURLToPath(new URL('./fixtures/stories/valid/', import.meta.url));
const temporaryDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('maps every surface in stable order with explicit course and default or current freshness', async () => {
  const stories = await loadStories(join(fixtures, 'stories'));
  const current = {
    ...stories[0],
    surfaces: ['lesson-reader', 'lesson-visuals', 'library'] as const,
    requires: { course: 'fixture:course-one', freshness: 'current', lesson: 'lesson-one' },
  };
  const input = [stories[1], { ...current, surfaces: [...current.surfaces] }];
  expect(formatCoverageMap(input)).toBe(
    [
      'Declared product surface coverage (story metadata)',
      'contextual-chat: UNCOVERED',
      'course-outline: UNCOVERED',
      'generation: UNCOVERED',
      'home-chat: UNCOVERED',
      'lesson-reader:',
      '  - exam-preparation (course: "fixture:course-one"; freshness: "current")',
      'lesson-visuals:',
      '  - exam-preparation (course: "fixture:course-one"; freshness: "current")',
      'library:',
      '  - exam-preparation (course: "fixture:course-one"; freshness: "current")',
      '  - open-library (course: "synthetic-short"; freshness: "any")',
      'settings: UNCOVERED',
    ].join('\n')
  );
  expect(formatCoverageMap([...input].reverse())).toBe(formatCoverageMap(input));
  expect(input.map(story => story.id)).toEqual(['open-library', 'exam-preparation']);
});

it('prints a filtered map without importing the adapter or creating run artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'playtest-coverage-'));
  temporaryDirs.push(dir);
  await mkdir(join(dir, 'stories'));
  await writeFile(join(dir, 'adapter.ts'), "throw new Error('Adapter must not load');");
  await writeFile(
    join(dir, 'stories', 'story.md'),
    [
      '---',
      'id: metadata',
      'kind: check',
      'title: Metadata',
      'viewports: [desktop]',
      'requires: {}',
      'surfaces: [home-chat]',
      'tags: [smoke]',
      'budget: { steps: 1 }',
      '---',
      'Ask a question.',
    ].join('\n')
  );
  vi.stubEnv('NOUS_E2E_DATA', '');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const args = ['--coverage-map', '--adapter', join(dir, 'adapter.ts')];
  const map = await runCommand(args);
  expect(map).toContain('  - metadata (course: "none"; freshness: "any")');
  expect(log).toHaveBeenLastCalledWith(map);
  expect(await runCommand([...args, '--tag', 'other'])).toBe(formatCoverageMap([]));
  expect(await runCommand([...args, '--id', 'missing'])).toBe(formatCoverageMap([]));
  expect(await runCommand([...args, '--kind', 'mission'])).toBe(formatCoverageMap([]));
  await expect(runCommand([...args, '--kind', 'unknown'])).rejects.toThrow();
  expect(await readdir(dir)).toEqual(['adapter.ts', 'stories']);
  await expect(runCommand([])).rejects.toThrow('NOUS_E2E_DATA is unset');
});
