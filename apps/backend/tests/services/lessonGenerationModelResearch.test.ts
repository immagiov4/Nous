import { beforeEach, describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { generateResearchSummary } from '../../src/services/lessonGenerationModel.js';

const { createConfiguredTextModel, generateText, runCodexAppServerTurn } = vi.hoisted(() => ({
  createConfiguredTextModel: vi.fn(),
  generateText: vi.fn(),
  runCodexAppServerTurn: vi.fn(),
}));

vi.mock('ai', async importOriginal => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText,
}));

vi.mock('../../src/services/aiSdkTextModel.js', () => ({ createConfiguredTextModel }));

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
    createConfiguredTextModel.mockReset();
    createConfiguredTextModel.mockReturnValue({ model: 'model', providerOptions: {} });
    generateText.mockReset();
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

  test('validates configured text-model output at the same boundary', async () => {
    generateText.mockResolvedValue({
      output: {
        ...validResearchResponse,
        sources: [{ ...validResearchResponse.sources[0], title: '   ' }],
      },
    });

    await expect(generateResearchSummary(generationInput('openrouter'))).rejects.toMatchObject({
      code: 'lesson_research_output_invalid',
      feedback: expect.stringContaining('sources[0].title'),
    });
    expect(createConfiguredTextModel).toHaveBeenCalledOnce();
  });

  test('returns a valid research response unchanged', async () => {
    runCodexAppServerTurn.mockResolvedValue(JSON.stringify(validResearchResponse));

    await expect(generateResearchSummary(generationInput())).resolves.toEqual(
      validResearchResponse
    );
  });
});
