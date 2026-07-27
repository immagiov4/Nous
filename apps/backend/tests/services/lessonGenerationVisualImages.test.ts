import { expect, test, vi } from 'vitest';

import type { GlobalModelConfig } from '../../src/config/modelConfig.js';

const runCodexAppServerTurn = vi.fn();

vi.mock('../../src/services/codexAppServer.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/codexAppServer.js')>();
  return { ...actual, runCodexAppServerTurn };
});

const { imageClient } = await import('../../src/services/imageClient.js');
const { renderLessonVisual } = await import('../../src/services/lessonGenerationVisuals.js');

test('HTML artifact image requests are generated and replaced before persistence', async () => {
  runCodexAppServerTurn.mockResolvedValue(
    JSON.stringify({
      code: '<style>.figure{width:100%}</style><div><img class="figure" src="{{GENERATED_IMAGE:tessuto}}" alt="Intreccio del tessuto"></div><script>const ready = true;</script>',
      imageRequests: [
        {
          alt: 'Intreccio del tessuto',
          id: 'tessuto',
          prompt: 'Macro fotografia didattica di trama e ordito intrecciati',
        },
      ],
    })
  );
  const generateImage = vi.spyOn(imageClient, 'generateImage').mockResolvedValue({
    dataUrl: 'data:image/png;base64,aW1tYWdpbmU=',
    mediaType: 'image/png',
  });
  const config = {
    aiProvider: 'codex',
    aiProviderOverrides: { artifactInteractive: 'codex', image: 'openrouter' },
    artifactInteractiveReasoningEffort: 'low',
    artifactVisualReviewEnabled: false,
    artifactVisualReviewMaxRounds: 1,
    codexArtifactInteractiveModel: 'artifact-model',
    codexFastModelSlots: [],
    imageModel: 'image-model',
  } as GlobalModelConfig;

  const result = await renderLessonVisual({
    config,
    lessonMarkdown: '## Intreccio\n\nTrama e ordito si incrociano.',
    plan: {
      altText: 'Intreccio del tessuto',
      anchorHeading: 'Intreccio',
      complexity: 'moderate',
      concept: 'Intreccio di trama e ordito',
      coverage: 'complete_synthesis',
      coverageRationale: 'Mostra la struttura.',
      factualRequirements: ['Fili perpendicolari'],
      interactionLevel: 'low',
      pedagogicalGoal: 'Riconoscere l intreccio',
      reason: 'Confronto visivo',
      requiresDepiction: false,
      slotId: 'visual-intreccio',
      title: 'Intreccio',
      visualDirection: 'Macro ordinata',
      visualType: 'interactive_html',
    },
    sectionDescription: 'Riconoscere trama e ordito.',
    sectionTitle: 'Intreccio',
    signal: new AbortController().signal,
  });

  expect(result?.kind).toBe('html');
  expect(result?.code).toContain('data:image/png;base64,aW1tYWdpbmU=');
  expect(result?.code).not.toContain('{{GENERATED_IMAGE:');
  expect(generateImage).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'image-model', provider: 'openrouter' })
  );
});
