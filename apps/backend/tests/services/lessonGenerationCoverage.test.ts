import { expect, test } from 'vitest';

import type { GlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  normalizePrerequisiteCoverageDecision,
  selectPrerequisiteSourceCoverage,
} from '../../src/services/lessonGenerationCoverage.js';
import { encodeLessonPrimarySources } from '../../src/services/lessonPrimarySourceContext.js';

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

test('source metadata does not inflate short prerequisite coverage', async () => {
  const sourceContext = encodeLessonPrimarySources([
    {
      source: {
        sourceId: 'source-1',
        title: 'Document title with extensive metadata',
        chunkIds: ['chunk-1'],
      },
      text: 'CHUNK chunk-1\nBrief source text.',
    },
  ]);
  const decision = await selectPrerequisiteSourceCoverage({
    config: {} as GlobalModelConfig,
    description: 'Explain the prerequisite.',
    signal: new AbortController().signal,
    sourceContext,
    title: 'Prerequisite',
  });
  expect(decision).toEqual({ missingTopics: ['Prerequisite'], needsResearch: true });
});
