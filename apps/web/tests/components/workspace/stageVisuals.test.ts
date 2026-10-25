import { getFormulaSpotlightLatex } from '@shared/formulaSpotlight';
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { expect, test } from 'vitest';
import { dictatedFormulaSpotlight } from '../../../../backend/tests/helpers/formulaSpotlight';
import { projectStageFormulaVisuals } from '../../../components/workspace/playback/stageVisuals';

test.each([
  1, 2,
])('projects %s authored formula occurrence without adding its prepared copy', count => {
  const unlinked = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchor: '' })),
  };
  const visuals = Array.from({ length: count }, () => ({
    kind: 'scene' as const,
    scene: unlinked,
  }));
  const scenes = Array.from({ length: count }, (_, index) => ({
    ...dictatedFormulaSpotlight,
    title: `Occorrenza ${index + 1}`,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({
      ...symbol,
      anchorOccurrence: index,
    })),
  }));
  const sources = [{ type: 'markdown' as const, markdown: 'ics più ipsilon poi ics più ipsilon' }];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    visuals,
    prepared: {
      motion: [],
      ...(count === 1 ? { scene: structuredClone(unlinked) } : {}),
      formulaSpotlights: scenes.map(scene => ({
        formula: `$$${getFormulaSpotlightLatex(unlinked)}$$`,
        sourceFormula: unlinked.formula,
        scene,
      })),
    },
  };
  const projected = projectStageFormulaVisuals({ block, sources, visuals, storedById: undefined });
  expect(projected).toHaveLength(count);
  expect(projected.map(visual => visual.kind === 'scene' && visual.scene.title)).toEqual(
    scenes.map(scene => scene.title)
  );
  expect(projected.map(visual => visual.voiceRange)).toEqual(
    scenes.map((_, index) => ({ start: index === 0 ? 0 : 20, end: index === 0 ? 15 : 35 }))
  );
});
