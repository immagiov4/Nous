import { expect, test, vi } from 'vitest';

import { type GlobalModelConfig, getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  normalizeLessonCoverageDecision,
  selectLessonSourceCoverage,
} from '../../src/services/lessonGenerationCoverage.js';
import { encodeLessonPrimarySources } from '../../src/services/lessonPrimarySourceContext.js';

const { generateStructuredOutput } = vi.hoisted(() => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../src/services/structuredGeneration.js', () => ({ generateStructuredOutput }));

test('coverage decisions preserve complete material and normalize factual gaps', () => {
  expect(normalizeLessonCoverageDecision({ missingTopics: [], sufficient: true }, 'Basi')).toEqual({
    missingTopics: [],
    needsResearch: false,
  });

  expect(
    normalizeLessonCoverageDecision(
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

  expect(
    normalizeLessonCoverageDecision(
      { missingTopics: ['Contratto API attuale'], sufficient: true },
      'Basi'
    )
  ).toEqual({
    missingTopics: ['Contratto API attuale'],
    needsResearch: true,
  });
});

test('missing source evidence requests research without invoking a model', async () => {
  const decision = await selectLessonSourceCoverage({
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

test('concise source evidence is assessed by the model', async () => {
  generateStructuredOutput.mockResolvedValue({ missingTopics: [], sufficient: true });
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
  const decision = await selectLessonSourceCoverage({
    config: getGlobalModelConfig(),
    description: 'Explain the prerequisite.',
    signal: new AbortController().signal,
    sourceContext,
    title: 'Prerequisite',
  });
  expect(decision).toEqual({ missingTopics: [], needsResearch: false });
  expect(generateStructuredOutput).toHaveBeenCalledOnce();
  expect(generateStructuredOutput).toHaveBeenCalledWith(
    expect.objectContaining({
      output: expect.objectContaining({ name: 'lesson_source_coverage' }),
      prompt: expect.stringContaining('Brief source text.'),
      slot: 'research',
    })
  );
});
