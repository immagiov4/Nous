import { expect, test, vi } from 'vitest';

const runCodexAppServerTurn = vi.fn();

vi.mock('../../src/services/codexAppServer.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/codexAppServer.js')>();
  return { ...actual, runCodexAppServerTurn };
});

const { imageClient } = await import('../../src/services/imageClient.js');
const { generateEmbeddedLessonVisualImage, generateLessonVisualArtifact, planLessonArtifactDraft } =
  await import('../../src/services/lessonGenerationVisuals.js');

const config = {
  artifact: {
    model: 'unused-artifact-model',
    provider: 'codex' as const,
    reasoningEffort: 'low' as const,
  },
  artifactInteractive: {
    model: 'artifact-model',
    provider: 'codex' as const,
    reasoningEffort: 'low' as const,
  },
  image: { model: 'image-model', provider: 'openrouter' as const },
  review: { enabled: false, maxRounds: 1 },
};
const EXISTING_ASSET_ID = 'a'.repeat(64);

const input = {
  config,
  lessonMarkdown: '## Intreccio\n\nTrama e ordito si incrociano.',
  plan: {
    altText: 'Intreccio del tessuto',
    anchorHeading: 'Intreccio',
    complexity: 'moderate' as const,
    concept: 'Intreccio di trama e ordito',
    coverage: 'complete_synthesis' as const,
    coverageRationale: 'Mostra la struttura.',
    factualRequirements: ['Fili perpendicolari'],
    interactionLevel: 'low' as const,
    pedagogicalGoal: 'Riconoscere l intreccio',
    reason: 'Confronto visivo',
    requiresDepiction: false,
    slotId: 'visual-intreccio',
    title: 'Intreccio',
    visualDirection: 'Macro ordinata',
    visualType: 'interactive_html' as const,
  },
  sectionDescription: 'Riconoscere trama e ordito.',
  sectionTitle: 'Intreccio',
  signal: new AbortController().signal,
};

test('HTML artifact image requests stay separate from the durable HTML payload', async () => {
  runCodexAppServerTurn.mockReset().mockResolvedValue(
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
    bytes: new TextEncoder().encode('immagine'),
    mediaType: 'image/png',
  });
  const result = await generateLessonVisualArtifact(input);

  expect(result).toEqual({
    code: expect.stringContaining('{{GENERATED_IMAGE:tessuto}}'),
    imageRequests: [
      {
        alt: 'Intreccio del tessuto',
        id: 'tessuto',
        prompt: 'Macro fotografia didattica di trama e ordito intrecciati',
      },
    ],
    kind: 'html',
  });
  expect(result?.code).not.toContain('data:image');
  expect(generateImage).not.toHaveBeenCalled();

  if (!result?.imageRequests[0]) throw new TypeError('Expected one embedded-image request.');
  const image = await generateEmbeddedLessonVisualImage({
    ...input,
    request: result.imageRequests[0],
  });

  expect(image).toEqual({
    bytes: new TextEncoder().encode('immagine'),
    mediaType: 'image/png',
  });
  expect(generateImage).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'image-model', provider: 'openrouter' })
  );
});

test('artifact generation leaves invalid-draft correction to the next durable attempt', async () => {
  runCodexAppServerTurn
    .mockReset()
    .mockResolvedValue(JSON.stringify({ code: '<div>Non valido</div>', imageRequests: [] }));

  await expect(generateLessonVisualArtifact(input)).resolves.toBeNull();
  expect(runCodexAppServerTurn).toHaveBeenCalledOnce();

  runCodexAppServerTurn.mockReset().mockResolvedValue(
    JSON.stringify({
      code: '<style></style><div>Corretto</div><script>const ready = true;</script>',
      imageRequests: [],
    })
  );
  await expect(
    generateLessonVisualArtifact({
      ...input,
      retryFeedback: 'Genera una sostituzione completa e valida.',
    })
  ).resolves.toMatchObject({ code: expect.stringContaining('Corretto') });
  expect(runCodexAppServerTurn).toHaveBeenCalledOnce();
  expect(runCodexAppServerTurn.mock.calls[0]?.[0].input).toEqual([
    expect.objectContaining({
      text: expect.stringContaining('Genera una sostituzione completa e valida.'),
    }),
  ]);
});

test('artifact generation treats malformed structured output as an invalid draft only', async () => {
  runCodexAppServerTurn.mockReset().mockResolvedValue('{not-json');

  await expect(generateLessonVisualArtifact(input)).resolves.toBeNull();

  const providerError = new Error('provider unavailable');
  runCodexAppServerTurn.mockReset().mockRejectedValue(providerError);

  await expect(generateLessonVisualArtifact(input)).rejects.toBe(providerError);
});

test('an HTML replacement may retain only its authorized project assets', async () => {
  const code = `<style></style><img src="{{PROJECT_ASSET:${EXISTING_ASSET_ID}}}"><script>const ready = true;</script>`;
  runCodexAppServerTurn.mockReset().mockResolvedValue(JSON.stringify({ code, imageRequests: [] }));

  await expect(
    generateLessonVisualArtifact({
      ...input,
      existingEmbeddedAssets: [
        {
          byteSize: 4,
          hash: EXISTING_ASSET_ID,
          id: EXISTING_ASSET_ID,
          mediaType: 'image/png',
        },
      ],
    })
  ).resolves.toEqual({ code, imageRequests: [], kind: 'html' });

  await expect(generateLessonVisualArtifact(input)).resolves.toBeNull();
});

test('the artifact planner preserves placement metadata and enforces depiction as raster', async () => {
  runCodexAppServerTurn.mockReset().mockResolvedValue(
    JSON.stringify({
      alt_text: 'Trama e ordito intrecciati.',
      anchor_heading: 'Intreccio',
      complexity: 'simple',
      concept: 'Incrocio tra trama e ordito',
      coverage: 'complete_synthesis',
      coverage_rationale: 'Mostra il rapporto spaziale.',
      factual_requirements: ['I fili sono perpendicolari.'],
      interaction_level: 'none',
      pedagogical_goal: 'Riconoscere le due direzioni.',
      reason: 'La disposizione è informativa.',
      requires_depiction: true,
      title: 'Trama e ordito',
      visual_direction: 'Macro ordinata del tessuto.',
      visual_type: 'structural_svg',
    })
  );

  await expect(
    planLessonArtifactDraft({
      config,
      lessonMarkdown: input.lessonMarkdown,
      sectionDescription: input.sectionDescription,
      sectionTitle: input.sectionTitle,
      signal: input.signal,
      slotId: 'artifact-draft',
    })
  ).resolves.toMatchObject({
    altText: 'Trama e ordito intrecciati.',
    anchorHeading: 'Intreccio',
    slotId: 'artifact-draft',
    title: 'Trama e ordito',
    visualType: 'illustrative_image',
  });
});

test('the artifact planner honors the requested render kind and receives retry feedback', async () => {
  runCodexAppServerTurn.mockReset().mockResolvedValue(
    JSON.stringify({
      alt_text: 'Schema dei fili.',
      anchor_heading: 'Intreccio',
      complexity: 'simple',
      concept: 'Incrocio tra trama e ordito',
      coverage: 'complete_synthesis',
      coverage_rationale: 'Mostra il rapporto spaziale.',
      factual_requirements: [],
      interaction_level: 'none',
      pedagogical_goal: 'Riconoscere le due direzioni.',
      reason: 'La disposizione e informativa.',
      requires_depiction: true,
      title: 'Trama e ordito',
      visual_direction: 'Schema essenziale.',
      visual_type: 'illustrative_image',
    })
  );

  await expect(
    planLessonArtifactDraft({
      config,
      lessonMarkdown: input.lessonMarkdown,
      requestedVisualKind: 'svg',
      retryFeedback: 'Mantieni il formato SVG richiesto.',
      sectionDescription: input.sectionDescription,
      sectionTitle: input.sectionTitle,
      signal: input.signal,
      slotId: 'artifact-draft',
    })
  ).resolves.toMatchObject({ visualType: 'structural_svg' });
  expect(runCodexAppServerTurn.mock.calls[0]?.[0].input).toEqual([
    expect.objectContaining({
      text: expect.stringContaining('Mantieni il formato SVG richiesto.'),
    }),
  ]);
});
