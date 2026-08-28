import { APICallError } from 'ai';
import { expect, test, vi } from 'vitest';

const { createConfiguredTextModelMock, generateTextMock, openRouterModelSupportsImagesMock } =
  vi.hoisted(() => ({
    createConfiguredTextModelMock: vi.fn(() => ({ model: 'model', providerOptions: {} })),
    generateTextMock: vi.fn(),
    openRouterModelSupportsImagesMock: vi.fn(),
  }));

vi.mock('ai', async importOriginal => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generateTextMock,
}));

vi.mock('../../src/services/aiSdkTextModel.js', () => ({
  createConfiguredTextModelFromResolution: createConfiguredTextModelMock,
}));

vi.mock('../../src/services/openRouterModelCapabilities.js', () => ({
  openRouterModelSupportsImages: openRouterModelSupportsImagesMock,
}));

import { getLessonRasterImageSubject } from '@shared/lessonVisualContracts';
import { imageClient } from '../../src/services/imageClient.js';
import {
  generateLessonVisualRaster,
  isSafeGeneratedVisualCode,
  reviseLessonVisualArtifact,
} from '../../src/services/lessonGenerationVisuals.js';

const visualPlan = {
  altText: 'Direzione della trama e dell ordito.',
  anchorHeading: 'La struttura del tessuto',
  complexity: 'moderate' as const,
  concept: 'Aspetto concreto di trama, ordito e sbieco su un tessuto',
  coverage: 'complete_synthesis' as const,
  coverageRationale: 'Mostra insieme le tre direzioni sul materiale.',
  factualRequirements: ['Trama e ordito sono perpendicolari.', 'Lo sbieco e diagonale.'],
  interactionLevel: 'none' as const,
  pedagogicalGoal: 'Riconoscere visivamente le direzioni del tessuto.',
  reason: 'La forma e la texture concrete sono parte dell informazione.',
  requiresDepiction: true,
  slotId: 'visual-tessuto',
  title: 'Trama, ordito e sbieco',
  visualDirection: 'Tessuto reale visto dall alto con frecce e poche etichette.',
  visualType: 'structural_svg' as const,
};

const reviewInput = {
  config: {
    artifact: {
      model: 'text-only-artifact',
      provider: 'openrouter' as const,
      reasoningEffort: 'low' as const,
    },
    artifactInteractive: {
      model: 'interactive',
      provider: 'openrouter' as const,
      reasoningEffort: 'low' as const,
    },
    image: { model: 'image-model', provider: 'openrouter' as const },
    review: { enabled: true, maxRounds: 1 },
  },
  issues: ['Possibile sovrapposizione tra due etichette.'],
  lessonMarkdown: '## Struttura',
  plan: visualPlan,
  preview: 'data:image/png;base64,cHJldmlldw==',
  sectionDescription: 'Una struttura da correggere.',
  sectionTitle: 'Struttura',
  signal: new AbortController().signal,
  visual: {
    code: '<svg viewBox="0 0 680 200"><text x="100" y="100">Prima</text><text x="100" y="100">Seconda</text></svg>',
    imageRequests: [],
    kind: 'svg' as const,
  },
};

test.each([
  'Request:',
  'Richiesta:',
])('strips the internal %s suffix from raster concepts', marker => {
  expect(
    getLessonRasterImageSubject({
      concept: `${visualPlan.concept}\n${marker} internal rendering direction`,
      factualRequirements: visualPlan.factualRequirements,
      lessonMarkdown: '## La struttura del tessuto',
      pedagogicalGoal: visualPlan.pedagogicalGoal,
      sectionDescription: 'Come riconoscere trama, ordito e sbieco.',
      sectionTitle: 'La struttura del tessuto',
      visualDirection: visualPlan.visualDirection,
    })
  ).toBe(visualPlan.concept);
});

test('the backend image provider returns raster bytes for the workflow staging boundary', async () => {
  const generateImage = vi.spyOn(imageClient, 'generateImage').mockResolvedValue({
    bytes: new TextEncoder().encode('hello'),
    mediaType: 'image/png',
  });
  const config = {
    artifact: {
      model: 'artifact',
      provider: 'openrouter' as const,
      reasoningEffort: 'low' as const,
    },
    artifactInteractive: {
      model: 'interactive',
      provider: 'openrouter' as const,
      reasoningEffort: 'low' as const,
    },
    image: { model: 'image-model', provider: 'openrouter' as const },
    review: { enabled: true, maxRounds: 1 },
  };

  const rendered = await generateLessonVisualRaster({
    config,
    lessonMarkdown: '## La struttura del tessuto\n\nTrama e ordito si incrociano.',
    plan: {
      ...visualPlan,
      concept: `${visualPlan.concept}\nRichiesta: genera un soggetto differente`,
      visualType: 'illustrative_image',
    },
    sectionDescription: 'Come riconoscere trama, ordito e sbieco.',
    sectionTitle: 'La struttura del tessuto',
    signal: new AbortController().signal,
  });

  expect(rendered).toEqual({
    bytes: new TextEncoder().encode('hello'),
    mediaType: 'image/png',
  });
  expect(generateImage).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'image-model',
      prompt: expect.stringContaining('This request is raster'),
      provider: 'openrouter',
    })
  );
  expect(generateImage.mock.calls[0]?.[0].prompt).not.toContain('genera un soggetto differente');
  expect(isSafeGeneratedVisualCode('image', 'data:image/png;base64,aGVsbG8=')).toBe(true);
});

test('visual review retries without the preview when OpenRouter has no image-capable endpoint', async () => {
  generateTextMock.mockClear();
  openRouterModelSupportsImagesMock.mockResolvedValueOnce(true);
  generateTextMock
    .mockRejectedValueOnce(
      new APICallError({
        data: {
          error: {
            code: 404,
            message: 'No endpoints found that support image input',
          },
        },
        message: 'No endpoints found that support image input',
        requestBodyValues: {},
        responseBody:
          '{"error":{"message":"No endpoints found that support image input","code":404}}',
        statusCode: 404,
        url: 'https://openrouter.ai/api/v1/chat/completions',
      })
    )
    .mockResolvedValueOnce({
      output: {
        code: '<svg viewBox="0 0 680 200"><text x="100" y="100">Corretto</text></svg>',
        imageRequests: [],
      },
    });

  const revised = await reviseLessonVisualArtifact(reviewInput);

  expect(revised?.code).toContain('Corretto');
  expect(generateTextMock).toHaveBeenCalledTimes(2);
  expect(generateTextMock.mock.calls[0]?.[0]).toHaveProperty('messages');
  expect(generateTextMock.mock.calls[1]?.[0]).toHaveProperty('prompt');
});

test('visual review preserves unrelated provider failures', async () => {
  generateTextMock.mockClear();
  openRouterModelSupportsImagesMock.mockResolvedValueOnce(true);
  const providerError = new APICallError({
    data: { error: { code: 404, message: 'Unknown model' } },
    message: 'Unknown model',
    requestBodyValues: {},
    responseBody: '{"error":{"message":"Unknown model","code":404}}',
    statusCode: 404,
    url: 'https://openrouter.ai/api/v1/chat/completions',
  });
  generateTextMock.mockRejectedValueOnce(providerError);

  await expect(reviseLessonVisualArtifact(reviewInput)).rejects.toBe(providerError);
  expect(generateTextMock).toHaveBeenCalledOnce();
});

test('visual review omits the preview before calling a text-only OpenRouter model', async () => {
  generateTextMock.mockClear().mockResolvedValueOnce({
    output: {
      code: '<svg viewBox="0 0 680 200"><text x="100" y="100">Corretto</text></svg>',
      imageRequests: [],
    },
  });
  openRouterModelSupportsImagesMock.mockResolvedValueOnce(false);

  await expect(reviseLessonVisualArtifact(reviewInput)).resolves.toMatchObject({
    code: expect.stringContaining('Corretto'),
  });

  expect(openRouterModelSupportsImagesMock).toHaveBeenCalledWith('text-only-artifact');
  expect(generateTextMock).toHaveBeenCalledOnce();
  expect(generateTextMock.mock.calls[0]?.[0]).toHaveProperty('prompt');
  expect(generateTextMock.mock.calls[0]?.[0]).not.toHaveProperty('messages');
});
