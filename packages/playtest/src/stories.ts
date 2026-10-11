import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import * as z from 'zod';
import { recordDiagnostic } from './diagnostics';
import type { Persona, Story, StoryFilter } from './types';

const identifier = z.string().trim().min(1);
const viewport = z.enum(['desktop', 'mobile']);
const storySchema = z
  .object({
    id: identifier,
    kind: z.enum(['check', 'mission']),
    title: identifier,
    persona: identifier.optional(),
    viewports: z.array(viewport).nonempty(),
    requires: z.record(z.string(), z.unknown()),
    tags: z.array(identifier),
    budget: z.object({ steps: z.number().int().positive() }),
  })
  .superRefine((story, context) => {
    if (new Set(story.viewports).size !== story.viewports.length) {
      context.addIssue({ code: 'custom', path: ['viewports'], message: 'Duplicate viewports' });
    }
    if (story.kind === 'mission' && !story.persona) {
      context.addIssue({
        code: 'custom',
        path: ['persona'],
        message: 'A mission requires a persona',
      });
    }
  });
const personaSchema = z.object({
  id: identifier,
  device: viewport.optional(),
  affects: z.array(identifier).nonempty().optional(),
});

async function markdownPaths(dir: string): Promise<string[]> {
  const paths = await Promise.all(
    (await readdir(dir, { withFileTypes: true })).map(entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return markdownPaths(path);
      return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
    })
  );
  return paths.flat().sort();
}

async function loadMarkdown<T>(sourcePath: string, schema: z.ZodType<T>) {
  try {
    const markdown = await readFile(sourcePath, 'utf8');
    const sections =
      /^\uFEFF?---\r?\n(?<frontMatter>[\s\S]*?)\r?\n---(?:\r?\n|$)(?<body>[\s\S]*)$/.exec(
        markdown
      )?.groups;
    if (!sections) throw new Error('Expected YAML front matter between --- lines');
    const result = schema.safeParse(parse(sections.frontMatter));
    if (!result.success) {
      throw new Error(
        result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      );
    }
    return { ...result.data, body: sections.body, sourcePath };
  } catch (cause) {
    recordDiagnostic('story-loading', cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid Markdown file "${sourcePath}": ${detail}`, { cause });
  }
}

/** Loads persona Markdown files recursively; duplicate IDs are rejected. */
export async function loadPersonas(dir: string): Promise<Map<string, Persona>> {
  const personas = new Map<string, Persona>();
  for (const sourcePath of await markdownPaths(resolve(dir))) {
    const persona = await loadMarkdown(sourcePath, personaSchema);
    if (personas.has(persona.id)) {
      throw new Error(`Duplicate persona id "${persona.id}" in "${sourcePath}"`);
    }
    personas.set(persona.id, persona);
  }
  return personas;
}

/** Loads stories recursively, validating persona references against the sibling personas directory. */
export async function loadStories(dir: string): Promise<Story[]> {
  const stories: Story[] = [];
  const ids = new Set<string>();
  for (const sourcePath of await markdownPaths(resolve(dir))) {
    const story = await loadMarkdown(sourcePath, storySchema);
    if (ids.has(story.id)) throw new Error(`Duplicate story id "${story.id}" in "${sourcePath}"`);
    ids.add(story.id);
    stories.push(story);
  }
  const referencedStory = stories.find(story => story.persona);
  if (referencedStory) {
    const personaDir = join(dirname(resolve(dir)), 'personas');
    let personas: Map<string, Persona>;
    try {
      personas = await loadPersonas(personaDir);
    } catch (cause) {
      recordDiagnostic('persona-loading', cause);
      throw new Error(
        `Cannot load personas for "${referencedStory.sourcePath}" from "${personaDir}"`,
        { cause }
      );
    }
    for (const story of stories) {
      if (story.persona && !personas.has(story.persona)) {
        throw new Error(`Unknown persona "${story.persona}" in "${story.sourcePath}"`);
      }
    }
  }
  return stories.sort((a, b) => {
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/** Combines filter categories with AND, and alternatives within each category with OR. */
export function filterStories(stories: Story[], filter: StoryFilter): Story[] {
  return stories.filter(
    story =>
      (filter.ids === undefined || filter.ids.includes(story.id)) &&
      (filter.tags === undefined || filter.tags.some(tag => story.tags.includes(tag))) &&
      (filter.kinds === undefined || filter.kinds.includes(story.kind))
  );
}
