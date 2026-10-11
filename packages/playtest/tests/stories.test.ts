import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { filterStories, loadPersonas, loadStories } from '../src/stories';

const fixtures = fileURLToPath(new URL('./fixtures/stories/valid/', import.meta.url));
const storyDir = join(fixtures, 'stories');
const checkPath = join(storyDir, 'check/z-check.md');
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function loadModifiedCheck(transform: (markdown: string) => string) {
  const dir = await mkdtemp(join(tmpdir(), 'playtest-stories-'));
  temporaryDirs.push(dir);
  const stories = join(dir, 'stories');
  await mkdir(stories);
  await mkdir(join(dir, 'personas'));
  const sourcePath = join(stories, 'invalid.md');
  await writeFile(sourcePath, transform(await readFile(checkPath, 'utf8')));
  return { sourcePath, stories, personas: join(dir, 'personas'), load: () => loadStories(stories) };
}

describe('story and persona loading', () => {
  it('parses check and mission stories recursively and sorts by id', async () => {
    const stories = await loadStories(storyDir);
    expect(stories).toEqual([
      {
        id: 'exam-preparation',
        kind: 'mission',
        title: 'Prepare for an exam',
        persona: 'giulia',
        viewports: ['mobile'],
        requires: {},
        tags: ['study', 'smoke'],
        budget: { steps: 24 },
        body: 'Understand the topic well enough to explain it in your own words.\n',
        sourcePath: join(storyDir, 'missions/a-mission.md'),
      },
      {
        id: 'open-library',
        kind: 'check',
        title: 'Open a course',
        viewports: ['desktop', 'mobile'],
        requires: { course: 'synthetic-short', options: { fresh: true } },
        tags: ['library', 'smoke'],
        budget: { steps: 8 },
        body: 'Find a course and start reading.\n',
        sourcePath: checkPath,
      },
    ]);
  });

  it('loads a persona map with its device, body and source path', async () => {
    expect(await loadPersonas(join(fixtures, 'personas'))).toEqual(
      new Map([
        [
          'giulia',
          {
            id: 'giulia',
            device: 'mobile',
            body: 'You are a student preparing for an exam on your phone.\n',
            sourcePath: join(fixtures, 'personas/giulia.md'),
          },
        ],
      ])
    );
  });

  it('rejects a missing step budget with the source filename', async () => {
    const fixture = await loadModifiedCheck(markdown =>
      markdown.replace('  steps: 8', '  other: 8')
    );
    await expect(fixture.load()).rejects.toThrow(fixture.sourcePath);
    await expect(fixture.load()).rejects.toThrow('budget.steps');
  });

  it.each(['0', '-1', '1.5', '"8"'])('rejects invalid step budget %s', async steps => {
    const fixture = await loadModifiedCheck(markdown =>
      markdown.replace('steps: 8', `steps: ${steps}`)
    );
    await expect(fixture.load()).rejects.toThrow('budget.steps');
  });

  it('rejects a mission referencing a persona absent from the map', async () => {
    const fixture = await loadModifiedCheck(markdown =>
      markdown.replace('kind: check', 'kind: mission\npersona: missing')
    );
    await expect(fixture.load()).rejects.toThrow(fixture.sourcePath);
    await expect(fixture.load()).rejects.toThrow('missing');
  });

  it('requires a persona for a mission', async () => {
    const fixture = await loadModifiedCheck(markdown =>
      markdown.replace('kind: check', 'kind: mission')
    );
    await expect(fixture.load()).rejects.toThrow('persona');
  });

  it('rejects duplicate story ids with the duplicate source filename', async () => {
    const fixture = await loadModifiedCheck(markdown => markdown);
    const duplicatePath = join(fixture.stories, 'z-duplicate.md');
    await writeFile(duplicatePath, await readFile(checkPath, 'utf8'));
    await expect(fixture.load()).rejects.toThrow(
      `Duplicate story id "open-library" in "${duplicatePath}"`
    );
  });

  it('allows personas without a device and rejects duplicate persona ids', async () => {
    const fixture = await loadModifiedCheck(markdown => markdown);
    const personaPath = join(fixture.personas, 'person.md');
    const markdown = '---\nid: person\n---\nPersona body.\n';
    await writeFile(personaPath, markdown);
    expect((await loadPersonas(fixture.personas)).get('person')).toEqual({
      id: 'person',
      body: 'Persona body.\n',
      sourcePath: personaPath,
    });
    const duplicatePath = join(fixture.personas, 'z-duplicate.md');
    await writeFile(duplicatePath, markdown);
    await expect(loadPersonas(fixture.personas)).rejects.toThrow(
      `Duplicate persona id "person" in "${duplicatePath}"`
    );
  });

  it('rejects invalid persona devices with the source filename', async () => {
    const fixture = await loadModifiedCheck(markdown => markdown);
    const personaPath = join(fixture.personas, 'person.md');
    await writeFile(personaPath, '---\nid: person\ndevice: tablet\n---\nPersona body.\n');
    await expect(loadPersonas(fixture.personas)).rejects.toThrow(personaPath);
  });

  it.each([
    (markdown: string) => markdown.replace('kind: check', 'kind: unknown'),
    (markdown: string) => markdown.replace('[desktop, mobile]', '[tablet]'),
    (markdown: string) =>
      markdown.replace(
        'requires:\n  course: synthetic-short\n  options:\n    fresh: true',
        'requires: []'
      ),
    (markdown: string) => markdown.replace('tags: [library, smoke]', 'tags: smoke'),
    (markdown: string) => markdown.replace('id: open-library', 'id: ['),
    (markdown: string) => markdown.replace(/^---\n/, ''),
  ])('rejects malformed front matter with the source filename', async transform => {
    const fixture = await loadModifiedCheck(transform);
    await expect(fixture.load()).rejects.toThrow(fixture.sourcePath);
  });

  it('supports CRLF delimiters and preserves Markdown body content', async () => {
    const fixture = await loadModifiedCheck(markdown => markdown.replaceAll('\n', '\r\n'));
    expect((await fixture.load())[0].body).toBe('Find a course and start reading.\r\n');
  });
});

describe('story filtering', () => {
  it('intersects ids, tags and kinds, with alternatives within each filter', async () => {
    const stories = await loadStories(storyDir);
    expect(
      filterStories(stories, {
        ids: ['exam-preparation', 'open-library'],
        tags: ['smoke', 'unused'],
        kinds: ['mission'],
      })
    ).toEqual([stories[0]]);
    expect(filterStories(stories, { ids: ['exam-preparation'], tags: ['library'] })).toEqual([]);
    expect(filterStories(stories, { kinds: ['check'] })).toEqual([stories[1]]);
  });

  it('returns all stories for absent filters and no matches for empty selections', async () => {
    const stories = await loadStories(storyDir);
    expect(filterStories(stories, {})).toEqual(stories);
    expect(filterStories(stories, { ids: [] })).toEqual([]);
    expect(filterStories(stories, { tags: [] })).toEqual([]);
    expect(filterStories(stories, { kinds: [] })).toEqual([]);
  });
});
