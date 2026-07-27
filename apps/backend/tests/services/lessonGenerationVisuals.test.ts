import { expect, test, vi } from 'vitest';

import type { GlobalModelConfig } from '../../src/config/modelConfig.js';
import { imageClient } from '../../src/services/imageClient.js';
import { renderDraftVisuals } from '../../src/services/lessonGenerationModel.js';
import {
  isSafeGeneratedVisualCode,
  renderLessonVisual,
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

test('a depiction plan is converted to raster before any renderer is called', async () => {
  const renderVisual = vi.fn(async () => ({
    code: 'data:image/png;base64,aGVsbG8=',
    kind: 'image' as const,
    mediaType: 'image/png' as const,
  }));

  await renderDraftVisuals({
    config: {} as GlobalModelConfig,
    draft: {
      contentBlocks: [
        { markdown: '## La struttura del tessuto\n\nTesto.', type: 'markdown' },
        { slotId: visualPlan.slotId, type: 'generated-visual' },
      ],
      generatedVisuals: [visualPlan],
      imageRefs: [],
      learningAids: [],
    },
    renderVisual,
    sectionDescription: 'Come riconoscere trama, ordito e sbieco.',
    sectionTitle: 'La struttura del tessuto',
    signal: new AbortController().signal,
  });

  expect(renderVisual).toHaveBeenCalledWith(
    expect.objectContaining({
      plan: expect.objectContaining({
        requiresDepiction: true,
        visualType: 'illustrative_image',
      }),
    })
  );
});

test('the backend image provider renders illustrative lesson plans as stored raster visuals', async () => {
  const generateImage = vi.spyOn(imageClient, 'generateImage').mockResolvedValue({
    dataUrl: 'data:image/png;base64,aGVsbG8=',
    mediaType: 'image/png',
  });
  const config = {
    aiProvider: 'openrouter',
    aiProviderOverrides: { image: 'openrouter' },
    artifactVisualReviewEnabled: true,
    artifactVisualReviewMaxRounds: 1,
    imageModel: 'image-model',
  } as GlobalModelConfig;

  const rendered = await renderLessonVisual({
    config,
    lessonMarkdown: '## La struttura del tessuto\n\nTrama e ordito si incrociano.',
    plan: { ...visualPlan, visualType: 'illustrative_image' },
    sectionDescription: 'Come riconoscere trama, ordito e sbieco.',
    sectionTitle: 'La struttura del tessuto',
    signal: new AbortController().signal,
  });

  expect(rendered).toEqual({
    code: 'data:image/png;base64,aGVsbG8=',
    kind: 'image',
    mediaType: 'image/png',
  });
  expect(generateImage).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'image-model',
      prompt: expect.stringContaining('questa richiesta e raster'),
      provider: 'openrouter',
    })
  );
  expect(isSafeGeneratedVisualCode('image', rendered?.code || '')).toBe(true);
});
