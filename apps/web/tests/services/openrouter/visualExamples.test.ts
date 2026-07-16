import { beforeEach, describe, expect, test, vi } from 'vitest';

const {
  callOpenRouterMock,
  getArtifactVisualReviewSettingsMock,
  lintSvgMock,
  requestGeneratedImageMock,
} = vi.hoisted(() => ({
  callOpenRouterMock: vi.fn(),
  getArtifactVisualReviewSettingsMock: vi.fn(),
  lintSvgMock: vi.fn(),
  requestGeneratedImageMock: vi.fn(),
}));

vi.mock('../../../services/openrouter/svgReview.ts', () => ({
  lintSvg: lintSvgMock,
  renderSvgPreview: () => Promise.resolve('data:image/png;base64,UFJFVklFVw=='),
}));

vi.mock('../../../services/openrouter/imageClient.ts', () => ({
  requestGeneratedImage: requestGeneratedImageMock,
}));
vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();

  return {
    ...actual,
    callOpenRouter: callOpenRouterMock,
    getArtifactVisualReviewSettings: getArtifactVisualReviewSettingsMock,
    MODEL_VISUAL_PLANNER: 'planner-model',
    MODEL_VISUAL_RENDERER: 'renderer-model',
  };
});

import { generateLessonArtifactDraft } from '../../../services/openrouter/artifactDrafts.ts';
import { appendGeneratedVisualExample } from '../../../services/openrouter/lessonImages.ts';
import { generateLessonVisualExample } from '../../../services/openrouter/visualExamples.ts';

const BASE_VISUAL_INPUT = {
  hasPdfImages: false,
  lessonMarkdown: '## Confronto\n\nI valori sono 20, 40 e 60.',
  sectionDescription: 'Confronta tre valori quantitativi.',
  sectionTitle: 'Confronto dei valori',
};

const VALID_CHART_RESPONSE = JSON.stringify({
  title: 'confronto_valori',
  loading_messages: ['Preparo il grafico'],
  widget_code:
    '<style>.chart{display:block}</style><div class="chart">20 · 40 · 60</div><script>window.__chartReady=true;</script>',
});

const CHART_PLAN_RESPONSE = JSON.stringify({
  visual_type: 'chart_html',
  concept: 'Confronto dei valori',
  pedagogical_goal: 'show_data',
});

const IMAGE_PLAN_RESPONSE = JSON.stringify({
  visual_type: 'illustrative_image',
  concept: 'Struttura concreta di una cellula vegetale.',
  pedagogical_goal: 'build_intuition',
});

const DIAGRAM_PLAN_RESPONSE = JSON.stringify({
  visual_type: 'flowchart_svg',
  concept: 'Trasformazione dell energia durante la fotosintesi.',
  pedagogical_goal: 'show_process',
});

const DIAGRAM_RENDER_RESPONSE = JSON.stringify({
  title: 'processo_fotosintesi',
  svg_code:
    '<svg viewBox="0 0 680 160"><rect x="40" y="40" width="180" height="80"/><text x="70" y="85">Luce</text><path d="M220 80 H400"/><rect x="400" y="40" width="220" height="80"/><text x="430" y="85">Energia chimica</text></svg>',
});

describe('artifact generation', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset();
    requestGeneratedImageMock.mockReset();
    getArtifactVisualReviewSettingsMock.mockResolvedValue({ enabled: true, maxRounds: 1 });
  });

  test('rejects an unsafe widget and returns the repaired draft', async () => {
    callOpenRouterMock
      .mockResolvedValueOnce(CHART_PLAN_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'bozza_non_sicura',
          widget_code:
            '<style>.chart{display:block}</style><div id="chart"></div><script>document.getElementById("missing-output").textContent = "40";</script>',
        })
      )
      .mockResolvedValueOnce(VALID_CHART_RESPONSE);

    const draft = await generateLessonArtifactDraft({
      lesson: {
        id: 'lesson-1',
        title: 'Confronto',
        description: 'Confronta tre valori.',
        type: 'core',
        isCompleted: false,
        content: BASE_VISUAL_INPUT.lessonMarkdown,
      },
      projectId: 'project-1',
      projectTitle: 'Corso test',
      prompt: 'Crea un grafico a barre con questi dati: 20, 40 e 60.',
    });

    expect(callOpenRouterMock).toHaveBeenCalledTimes(3);
    expect(draft?.visual).toMatchObject({ kind: 'html', title: 'confronto_valori' });
  });

  test('rejects malformed widget JavaScript and returns the repaired draft', async () => {
    callOpenRouterMock
      .mockResolvedValueOnce(CHART_PLAN_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'bozza_sintassi_errata',
          widget_code:
            '<style>.chart{display:block}</style><div class="chart"></div><script>const values = [20, 40, );</script>',
        })
      )
      .mockResolvedValueOnce(VALID_CHART_RESPONSE);

    const draft = await generateLessonArtifactDraft({
      lesson: {
        id: 'lesson-1',
        title: 'Confronto',
        description: 'Confronta tre valori.',
        type: 'core',
        isCompleted: false,
        content: BASE_VISUAL_INPUT.lessonMarkdown,
      },
      projectId: 'project-1',
      projectTitle: 'Corso test',
      prompt: 'Crea un grafico a barre con questi dati: 20, 40 e 60.',
    });

    expect(callOpenRouterMock).toHaveBeenCalledTimes(3);
    expect(draft?.visual).toMatchObject({ kind: 'html', title: 'confronto_valori' });
  });

  test('generates an explicit image draft without an extra LLM renderer call', async () => {
    callOpenRouterMock.mockResolvedValueOnce(IMAGE_PLAN_RESPONSE);
    requestGeneratedImageMock.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      mediaType: 'image/png',
    });

    const draft = await generateLessonArtifactDraft({
      lesson: {
        id: 'lesson-1',
        title: 'La cellula',
        description: 'Struttura concreta di una cellula vegetale.',
        type: 'core',
        isCompleted: false,
        content: '## Struttura\n\nParete, membrana, citoplasma e nucleo.',
      },
      projectId: 'project-1',
      projectTitle: 'Biologia',
      prompt: 'Crea un’illustrazione realistica di una cellula vegetale.',
    });

    expect(callOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(requestGeneratedImageMock).toHaveBeenCalledTimes(1);
    expect(requestGeneratedImageMock.mock.calls[0]?.[0]).toContain(
      'Struttura concreta di una cellula vegetale'
    );
    expect(draft?.visual).toMatchObject({
      altText: 'Struttura concreta di una cellula vegetale.',
      kind: 'image',
      mediaType: 'image/png',
    });
  });

  test('routes a later raster request through image generation after creating a diagram', async () => {
    getArtifactVisualReviewSettingsMock.mockResolvedValue({ enabled: false, maxRounds: 1 });
    callOpenRouterMock
      .mockResolvedValueOnce(DIAGRAM_PLAN_RESPONSE)
      .mockResolvedValueOnce(DIAGRAM_RENDER_RESPONSE);
    requestGeneratedImageMock.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,Zm90b3NpbnRlc2k=',
      mediaType: 'image/png',
    });

    const lesson = {
      id: 'lesson-photosynthesis',
      title: 'La fotosintesi',
      description: 'Trasformazione dell energia durante la fotosintesi.',
      type: 'core' as const,
      isCompleted: false,
      content: '## Processo\n\nLa luce viene trasformata in energia chimica.',
    };
    const diagramDraft = await generateLessonArtifactDraft({
      lesson,
      projectId: 'project-biology',
      projectTitle: 'Biologia',
      prompt: 'Crea un diagramma del processo.',
    });
    const rasterDraft = await generateLessonArtifactDraft({
      lesson,
      projectId: 'project-biology',
      projectTitle: 'Biologia',
      prompt: 'Ora genera lo stesso concetto come immagine raster.',
      rasterImageRequested: true,
    });

    expect(diagramDraft?.visual.kind).toBe('svg');
    expect(rasterDraft?.visual).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
    });
    expect(callOpenRouterMock).toHaveBeenCalledTimes(2);
    expect(requestGeneratedImageMock).toHaveBeenCalledTimes(1);
  });

  test('does not copy generated image bytes into a replacement prompt', async () => {
    callOpenRouterMock.mockResolvedValueOnce(IMAGE_PLAN_RESPONSE);
    requestGeneratedImageMock.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      mediaType: 'image/png',
    });

    await generateLessonArtifactDraft({
      lesson: {
        id: 'lesson-1',
        title: 'La cellula',
        description: 'Struttura concreta di una cellula vegetale.',
        type: 'core',
        isCompleted: false,
        content: '## Struttura\n\nParete, membrana, citoplasma e nucleo.',
      },
      mode: 'replacement-draft',
      projectId: 'project-1',
      projectTitle: 'Biologia',
      prompt: 'Crea un’illustrazione realistica più chiara.',
      revisionInstructions: 'Mostra meglio il nucleo.',
      sourceArtifact: {
        summary: {
          id: 'artifact-source',
          kind: 'generated-visual',
          lessonId: 'lesson-1',
          lessonTitle: 'La cellula',
          previewMode: 'thumbnail',
          projectId: 'project-1',
          projectTitle: 'Biologia',
          title: 'cellula vegetale',
        },
        visual: {
          altText: 'Cellula vegetale con nucleo e membrana',
          code: 'data:image/png;base64,SECRET_IMAGE_BYTES',
          createdAt: '2026-07-10T00:00:00.000Z',
          id: 'visual-source',
          kind: 'image',
          mediaType: 'image/png',
          title: 'cellula_vegetale',
        },
      },
    });

    const imagePrompt = requestGeneratedImageMock.mock.calls[0]?.[0];
    expect(imagePrompt).toContain('Cellula vegetale con nucleo e membrana');
    expect(imagePrompt).not.toContain('SECRET_IMAGE_BYTES');
  });
});

describe('visual planner latency profile', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset();
    requestGeneratedImageMock.mockReset();
    getArtifactVisualReviewSettingsMock.mockResolvedValue({ enabled: true, maxRounds: 1 });
  });

  test('uses low reasoning only when the request still needs planning', async () => {
    callOpenRouterMock.mockResolvedValueOnce(
      JSON.stringify({
        visual_type: 'none',
        reason: 'Il testo è già sufficientemente chiaro.',
      })
    );

    const result = await generateLessonVisualExample(BASE_VISUAL_INPUT);

    expect(result).toBeNull();
    expect(callOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(callOpenRouterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'planner-model',
        modelSlot: 'artifact',
        reasoning: {
          effort: 'low',
          exclude: true,
        },
      })
    );
  });

  test('uses a generated image only when the planner selects a non-schematic subject', async () => {
    callOpenRouterMock.mockResolvedValueOnce(
      JSON.stringify({
        visual_type: 'illustrative_image',
        concept: 'Aspetto e consistenza dei diversi strati di una barriera corallina.',
        pedagogical_goal: 'build_intuition',
        anchor_heading: 'Confronto',
        reason: 'La forma e la consistenza non si comprendono bene con forme schematiche.',
      })
    );
    requestGeneratedImageMock.mockResolvedValueOnce({
      dataUrl: 'data:image/webp;base64,ZmFrZS1pbWFnZQ==',
      mediaType: 'image/webp',
    });

    const result = await generateLessonVisualExample(BASE_VISUAL_INPUT);

    expect(callOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(requestGeneratedImageMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      anchorHeading: 'Confronto',
      visual: {
        kind: 'image',
        mediaType: 'image/webp',
      },
    });
  });

  test('keeps the completed lesson when image generation is unavailable', async () => {
    callOpenRouterMock.mockResolvedValueOnce(
      JSON.stringify({
        plans: [
          {
            visual_type: 'illustrative_image',
            concept: 'Aspetto degli strati di una barriera corallina.',
            pedagogical_goal: 'build_intuition',
            anchor_heading: 'Confronto',
          },
        ],
      })
    );
    requestGeneratedImageMock.mockRejectedValueOnce(new Error('provider unavailable'));
    const statuses: string[] = [];

    const result = await appendGeneratedVisualExample({
      contentMarkdown: BASE_VISUAL_INPUT.lessonMarkdown,
      hasPdfImages: false,
      onStatusUpdate: status => statuses.push(status),
      sectionDescription: BASE_VISUAL_INPUT.sectionDescription,
      sectionTitle: BASE_VISUAL_INPUT.sectionTitle,
    });

    expect(result).toEqual({
      content: BASE_VISUAL_INPUT.lessonMarkdown,
      generatedVisuals: [],
    });
    expect(statuses.at(-1)).toBe('Esempio visivo non disponibile');
  });

  test('starts at most three visual workers concurrently and preserves planner order', async () => {
    callOpenRouterMock.mockResolvedValueOnce(
      JSON.stringify({
        plans: ['cellula', 'tessuto', 'organo', 'apparato'].map(concept => ({
          visual_type: 'illustrative_image',
          concept,
          pedagogical_goal: 'build_intuition',
          anchor_heading: 'Confronto',
        })),
      })
    );
    const imageResolvers: Array<(image: { dataUrl: string; mediaType: 'image/png' }) => void> = [];
    requestGeneratedImageMock.mockImplementation(
      () =>
        new Promise(resolve => {
          imageResolvers.push(resolve);
        })
    );

    const pendingResult = appendGeneratedVisualExample({
      contentMarkdown: BASE_VISUAL_INPUT.lessonMarkdown,
      hasPdfImages: false,
      sectionDescription: BASE_VISUAL_INPUT.sectionDescription,
      sectionTitle: BASE_VISUAL_INPUT.sectionTitle,
    });

    await vi.waitFor(() => expect(requestGeneratedImageMock).toHaveBeenCalledTimes(3));
    imageResolvers[2]?.({ dataUrl: 'data:image/png;base64,Mw==', mediaType: 'image/png' });
    imageResolvers[0]?.({ dataUrl: 'data:image/png;base64,MQ==', mediaType: 'image/png' });
    imageResolvers[1]?.({ dataUrl: 'data:image/png;base64,Mg==', mediaType: 'image/png' });

    const result = await pendingResult;
    expect(result.generatedVisuals.map(visual => visual.id)).toEqual([
      'visual-001',
      'visual-002',
      'visual-003',
    ]);
    expect(result.generatedVisuals.map(visual => visual.title)).toEqual([
      'cellula',
      'tessuto',
      'organo',
    ]);
    expect(result.content.indexOf('{{VISUAL_EXAMPLE:visual-001|')).toBeLessThan(
      result.content.indexOf('{{VISUAL_EXAMPLE:visual-002|')
    );
    expect(result.content.indexOf('{{VISUAL_EXAMPLE:visual-002|')).toBeLessThan(
      result.content.indexOf('{{VISUAL_EXAMPLE:visual-003|')
    );
  });

  test('keeps successful visual workers when another worker fails', async () => {
    callOpenRouterMock.mockResolvedValueOnce(
      JSON.stringify({
        plans: [
          { visual_type: 'illustrative_image', concept: 'primo' },
          { visual_type: 'illustrative_image', concept: 'secondo' },
        ],
      })
    );
    requestGeneratedImageMock
      .mockRejectedValueOnce(new Error('first provider request failed'))
      .mockResolvedValueOnce({
        dataUrl: 'data:image/png;base64,Mg==',
        mediaType: 'image/png',
      });

    const result = await appendGeneratedVisualExample({
      contentMarkdown: BASE_VISUAL_INPUT.lessonMarkdown,
      hasPdfImages: false,
      sectionDescription: BASE_VISUAL_INPUT.sectionDescription,
      sectionTitle: BASE_VISUAL_INPUT.sectionTitle,
    });

    expect(result.generatedVisuals).toHaveLength(1);
    expect(result.generatedVisuals[0]).toMatchObject({ id: 'visual-002', title: 'secondo' });
  });
});

describe('SVG multimodal review', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset();
    lintSvgMock.mockReset();
    lintSvgMock.mockReturnValue(['Possibile testo fuori dai bordi: "Nodo".']);
    getArtifactVisualReviewSettingsMock.mockResolvedValue({ enabled: true, maxRounds: 1 });
  });

  test('renders, reviews once, and returns the revised SVG', async () => {
    callOpenRouterMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'bozza',
          svg_code: '<svg viewBox="0 0 680 120"><text x="670" y="40">Nodo</text></svg>',
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'revisionato',
          svg_code: '<svg viewBox="0 0 680 120"><text x="40" y="40">Nodo</text></svg>',
        })
      );

    const result = await generateLessonVisualExample({
      ...BASE_VISUAL_INPUT,
      visualTypeHint: 'flowchart_svg',
    });

    expect(callOpenRouterMock).toHaveBeenCalledTimes(2);
    expect(callOpenRouterMock.mock.calls[1]?.[0].allowTextOnlyImageFallback).toBe(true);
    expect(callOpenRouterMock.mock.calls[1]?.[0].messages.at(-1)?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,UFJFVklFVw==' },
        }),
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Il linter seguente e euristico'),
        }),
      ])
    );
    expect(result?.visual).toMatchObject({
      kind: 'svg',
      title: 'revisionato',
      code: expect.stringContaining('x="40"'),
    });
  });

  test('returns the first SVG without rendering a feedback pass when review is disabled', async () => {
    getArtifactVisualReviewSettingsMock.mockResolvedValue({ enabled: false, maxRounds: 4 });
    callOpenRouterMock.mockResolvedValueOnce(
      JSON.stringify({
        title: 'prima_boza',
        svg_code: '<svg viewBox="0 0 680 120"><text x="40" y="40">Nodo</text></svg>',
      })
    );

    const result = await generateLessonVisualExample({
      ...BASE_VISUAL_INPUT,
      visualTypeHint: 'flowchart_svg',
    });

    expect(callOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(result?.visual).toMatchObject({ kind: 'svg', title: 'prima_boza' });
  });

  test('stops before the configured maximum when warnings are resolved', async () => {
    getArtifactVisualReviewSettingsMock.mockResolvedValue({ enabled: true, maxRounds: 3 });
    lintSvgMock
      .mockReturnValueOnce(['Possibile testo fuori dai bordi: "Nodo".'])
      .mockReturnValueOnce([]);
    callOpenRouterMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'bozza',
          svg_code: '<svg viewBox="0 0 680 120"><text x="670" y="40">Nodo</text></svg>',
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'corretto',
          svg_code: '<svg viewBox="0 0 680 120"><text x="40" y="40">Nodo</text></svg>',
        })
      );

    await generateLessonVisualExample({
      ...BASE_VISUAL_INPUT,
      visualTypeHint: 'flowchart_svg',
    });

    expect(callOpenRouterMock).toHaveBeenCalledTimes(2);
  });

  test('never exceeds the configured feedback round maximum', async () => {
    getArtifactVisualReviewSettingsMock.mockResolvedValue({ enabled: true, maxRounds: 3 });
    callOpenRouterMock.mockResolvedValue(
      JSON.stringify({
        title: 'ancora_con_warning',
        svg_code: '<svg viewBox="0 0 680 120"><text x="670" y="40">Nodo</text></svg>',
      })
    );

    await generateLessonVisualExample({
      ...BASE_VISUAL_INPUT,
      visualTypeHint: 'flowchart_svg',
    });

    expect(callOpenRouterMock).toHaveBeenCalledTimes(4);
  });
});
