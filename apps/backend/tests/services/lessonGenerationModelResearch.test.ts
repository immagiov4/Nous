import { beforeEach, describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { generateResearchSummary } from '../../src/services/lessonGenerationModel.js';

const { runCodexAppServerTurn } = vi.hoisted(() => ({
  runCodexAppServerTurn: vi.fn(),
}));

vi.mock('../../src/services/codexAppServer.js', () => ({ runCodexAppServerTurn }));

const validResearchResponse = {
  avoidOversimplifying: [],
  controversies: [],
  difficultSteps: [],
  factualSummary: 'Sintesi fattuale',
  keyExamples: [],
  recentDevelopments: [],
  sources: [
    {
      note: 'Fonte consultata',
      title: 'Fonte autorevole',
      url: 'https://example.com/reference',
    },
  ],
  youtubeCandidateDecisions: [
    {
      decision: 'selected-source' as const,
      reason: 'Il transcript sostiene la spiegazione.',
      url: 'https://www.youtube.com/watch?v=video-1',
    },
  ],
};

const generationInput = () => ({
  config: { ...getGlobalModelConfig(), aiProvider: 'codex' as const },
  coverageGaps: ['Integrare il contesto disponibile.'],
  description: 'Descrizione',
  imageCandidates: [],
  instructionPacks: [],
  language: 'Italiano',
  pedagogicalContext: '',
  previousLessonTitles: [],
  refreshResearch: false,
  researchContext: '',
  sectionTitle: 'Titolo',
  signal: new AbortController().signal,
  sourceContext: '',
  sources: [],
});

describe('lesson research model response contract', () => {
  beforeEach(() => {
    runCodexAppServerTurn.mockReset();
  });

  test.each([
    {
      expectedPath: 'sources[0].title',
      response: {
        ...validResearchResponse,
        sources: [{ ...validResearchResponse.sources[0], title: '' }],
      },
    },
    {
      expectedPath: 'youtubeCandidateDecisions[0].url',
      response: {
        ...validResearchResponse,
        youtubeCandidateDecisions: [
          { ...validResearchResponse.youtubeCandidateDecisions[0], url: '' },
        ],
      },
    },
  ])('rejects an empty identifier at $expectedPath', async ({ expectedPath, response }) => {
    runCodexAppServerTurn.mockResolvedValue(JSON.stringify(response));

    await expect(generateResearchSummary(generationInput())).rejects.toMatchObject({
      code: 'lesson_research_output_invalid',
      feedback: expect.stringContaining(expectedPath),
    });
    expect(runCodexAppServerTurn.mock.calls[0]?.[0].outputSchema).toMatchObject({
      properties: {
        sources: {
          items: {
            properties: {
              title: { minLength: 1 },
              url: { minLength: 1 },
            },
          },
        },
        youtubeCandidateDecisions: {
          items: { properties: { url: { minLength: 1 } } },
        },
      },
    });
  });
});
