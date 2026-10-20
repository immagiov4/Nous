import { readFile } from 'node:fs/promises';
import { type BrowserContextOptions, devices } from 'playwright';
import * as z from 'zod';
import { VIEWPORTS } from '../../../packages/playtest/src/operator/viewports';

const ATLAS_CHECKS = [
  'visual-empty',
  'visual-symbol-only',
  'caption-word-mismatch',
  'speech-inline-math-omitted',
  'visual-clipped',
  'console-error',
  'render-error',
  'scene-invalid',
] as const;
const fixture = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library'), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('project'), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('synthetic'),
      generator: z.enum(['pairwise', 'synthetic-short', 'synthetic-law-short']),
    })
    .strict(),
]);
export const AtlasScenarioSchema = z
  .object({
    id: z.string().min(1),
    surface: z.literal('playback'),
    tags: z.array(z.string()),
    fixture,
    viewports: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
            device: z.string().optional(),
            viewport: z
              .object({ width: z.number().int().positive(), height: z.number().int().positive() })
              .optional(),
          })
          .strict()
      )
      .nonempty(),
    checks: z.array(z.enum(ATLAS_CHECKS)).nonempty(),
  })
  .strict()
  .superRefine((scenario, context) => {
    const ids = scenario.viewports.map(viewport => viewport.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Viewport IDs must be unique.' });
    for (const viewport of scenario.viewports) {
      if (!viewport.device && !viewport.viewport)
        context.addIssue({
          code: 'custom',
          message: 'A viewport size or named Playwright device is required.',
        });
      if (viewport.device && !devices[viewport.device])
        context.addIssue({ code: 'custom', message: 'Unknown Playwright device.' });
    }
  });
export type AtlasScenario = z.infer<typeof AtlasScenarioSchema>;
export type AtlasViewport = AtlasScenario['viewports'][number];

export function viewportOptions(viewport: AtlasViewport): BrowserContextOptions {
  return {
    ...(viewport.device ? devices[viewport.device] : {}),
    ...(viewport.viewport ? { viewport: viewport.viewport } : {}),
  };
}

/** Playback is the first scenario adapter; definitions already own inputs, devices, and checks. */
export const DEFAULT_PLAYBACK_SCENARIO: AtlasScenario = {
  id: 'playback-visual-atlas',
  surface: 'playback',
  tags: ['playback', 'deterministic'],
  fixture: { kind: 'synthetic', generator: 'pairwise' },
  viewports: [
    { id: 'desktop', viewport: VIEWPORTS.desktop },
    { id: 'mobile', device: 'Pixel 7', viewport: VIEWPORTS.mobile },
    { id: 'tablet', device: 'iPad (gen 7)' },
  ],
  checks: [...ATLAS_CHECKS],
};
export async function readAtlasScenario(path?: string): Promise<AtlasScenario> {
  return AtlasScenarioSchema.parse(
    path ? JSON.parse(await readFile(path, 'utf8')) : DEFAULT_PLAYBACK_SCENARIO
  );
}
