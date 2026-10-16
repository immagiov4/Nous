import { PRODUCT_SURFACES, type Story } from './types';

/** Declared story scope, independent of browser observations and local fixture overrides. */
export function formatCoverageMap(stories: Story[]): string {
  const sorted = [...stories].sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
  return [
    'Declared product surface coverage (story metadata)',
    ...PRODUCT_SURFACES.map(surface => {
      const covering = sorted.filter(story => story.surfaces.includes(surface));
      if (covering.length === 0) return `${surface}: UNCOVERED`;
      return [
        `${surface}:`,
        ...covering.map(
          story =>
            `  - ${story.id} (course: ${JSON.stringify(story.requires.course ?? 'none')}; freshness: ${JSON.stringify(story.requires.freshness ?? 'any')})`
        ),
      ].join('\n');
    }),
  ].join('\n');
}
