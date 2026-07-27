import { expect, test } from 'vitest';

import type { GlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  normalizePrerequisiteCoverageDecision,
  selectPrerequisiteSourceCoverage,
} from '../../src/services/lessonGenerationCoverage.js';

test('coverage decisions preserve complete material and normalize factual gaps', () => {
  expect(
    normalizePrerequisiteCoverageDecision({ missingTopics: [], sufficient: true }, 'Basi')
  ).toEqual({ missingTopics: [], needsResearch: false });

  expect(
    normalizePrerequisiteCoverageDecision(
      {
        missingTopics: ['Ipotesi matematiche', ' Limiti del metodo ', 'Ipotesi matematiche'],
        sufficient: false,
      },
      'Basi'
    )
  ).toEqual({
    missingTopics: ['Ipotesi matematiche', 'Limiti del metodo'],
    needsResearch: true,
  });
});

test('missing source evidence requests research without invoking a model', async () => {
  const decision = await selectPrerequisiteSourceCoverage({
    config: {} as GlobalModelConfig,
    description: 'Comprendere il prerequisito.',
    signal: new AbortController().signal,
    sourceContext: '',
    title: 'Prerequisito assente',
  });

  expect(decision).toEqual({
    missingTopics: ['Prerequisito assente'],
    needsResearch: true,
  });
});
