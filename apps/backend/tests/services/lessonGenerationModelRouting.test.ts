import { describe, expect, test } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { resolveLessonResearchRequest } from '../../src/services/lessonGenerationModel.js';

const config = getGlobalModelConfig();

describe('lesson research model routing', () => {
  test('uses the lesson model without web search when only source material must be structured', () => {
    expect(
      resolveLessonResearchRequest({
        config: { ...config, aiProvider: 'openrouter' },
        coverageGaps: undefined,
        refreshResearch: false,
        sourceContext: 'Materiale originale',
      })
    ).toEqual({ mode: 'source-sufficient', slot: 'lesson', webSearch: false });
  });

  test('uses the OpenRouter lesson model with web search for a source-backed gap', () => {
    expect(
      resolveLessonResearchRequest({
        config: { ...config, aiProvider: 'openrouter' },
        coverageGaps: ['Concetto mancante'],
        refreshResearch: false,
        sourceContext: 'Materiale originale',
      })
    ).toEqual({ mode: 'source-backed-gaps', slot: 'lesson', webSearch: true });
  });

  test('keeps non-OpenRouter supplemental research on the dedicated research slot', () => {
    expect(
      resolveLessonResearchRequest({
        config: { ...config, aiProvider: 'openai' },
        coverageGaps: ['Concetto mancante'],
        refreshResearch: false,
        sourceContext: 'Materiale originale',
      })
    ).toEqual({ mode: 'source-backed-gaps', slot: 'research', webSearch: true });
  });

  test('uses the dedicated research model for source-free lessons', () => {
    expect(
      resolveLessonResearchRequest({
        config: { ...config, aiProvider: 'openrouter' },
        coverageGaps: ['Dato di copertura non applicabile senza una fonte'],
        refreshResearch: false,
        sourceContext: '',
      })
    ).toEqual({ mode: 'source-free', slot: 'research', webSearch: true });
  });

  test('uses the dedicated research model and web search for full regeneration', () => {
    expect(
      resolveLessonResearchRequest({
        config: { ...config, aiProvider: 'openrouter' },
        coverageGaps: undefined,
        refreshResearch: true,
        sourceContext: 'Materiale originale',
      })
    ).toEqual({ mode: 'source-backed-refresh', slot: 'research', webSearch: true });
  });
});
