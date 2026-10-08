import { beforeEach, describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { generateResearchSummary } from '../../src/services/lessonGenerationModel.js';

const { generateStructuredOutput } = vi.hoisted(() => ({ generateStructuredOutput: vi.fn() }));

vi.mock('../../src/services/structuredGeneration.js', () => ({ generateStructuredOutput }));

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

const generationInput = (aiProvider: 'codex' | 'openrouter' = 'codex') => ({
  config: { ...getGlobalModelConfig(), aiProvider },
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
    generateStructuredOutput.mockReset();
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
      expectedPath: 'sources[0].title',
      response: {
        ...validResearchResponse,
        sources: [{ ...validResearchResponse.sources[0], title: ' \t\n ' }],
      },
    },
    {
      expectedPath: 'sources[0].url',
      response: {
        ...validResearchResponse,
        sources: [{ ...validResearchResponse.sources[0], url: '' }],
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
    {
      expectedPath: 'youtubeCandidateDecisions',
      response: { ...validResearchResponse, youtubeCandidateDecisions: undefined },
    },
  ])('rejects an unusable identifier at $expectedPath', async ({ expectedPath, response }) => {
    generateStructuredOutput.mockResolvedValue(response);

    await expect(generateResearchSummary(generationInput())).rejects.toMatchObject({
      code: 'lesson_research_output_invalid',
      feedback: expect.stringContaining(expectedPath),
    });
    expect(generateStructuredOutput.mock.calls[0]?.[0].output.schema).toMatchObject({
      properties: {
        sources: {
          items: {
            properties: {
              title: { minLength: 1, pattern: '\\S' },
              url: { minLength: 1, pattern: '\\S' },
            },
          },
        },
        youtubeCandidateDecisions: {
          items: { properties: { url: { minLength: 1, pattern: '\\S' } } },
        },
      },
      required: expect.arrayContaining(['youtubeCandidateDecisions']),
    });
  });

  test.each([
    { aiProvider: 'codex' as const, slot: 'research' },
    { aiProvider: 'openrouter' as const, slot: 'lesson' },
  ])('fills declared gaps with web research on the $slot slot for $aiProvider', async ({
    aiProvider,
    slot,
  }) => {
    generateStructuredOutput.mockResolvedValue(validResearchResponse);

    await generateResearchSummary({ ...generationInput(aiProvider), sourceContext: 'Materiale.' });

    expect(generateStructuredOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Integrare il contesto disponibile.'),
        slot,
        webSearch: true,
      })
    );
  });

  test('returns a valid research response unchanged', async () => {
    generateStructuredOutput.mockResolvedValue(validResearchResponse);

    await expect(generateResearchSummary(generationInput())).resolves.toEqual(
      validResearchResponse
    );
  });
});
