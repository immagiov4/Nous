import { beforeEach, describe, expect, test, vi } from 'vitest';

const { callOpenRouterMock, requestGeneratedImageMock } = vi.hoisted(() => ({
  callOpenRouterMock: vi.fn(),
  requestGeneratedImageMock: vi.fn(),
}));

vi.mock('../../../services/openrouter/svgReview.ts', () => ({
  lintSvg: () => ['Possibile testo fuori dai bordi: "Nodo".'],
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
    MODEL_VISUAL_PLANNER: 'planner-model',
    MODEL_VISUAL_RENDERER: 'renderer-model',
  };
});

import { generateLessonArtifactDraft } from '../../../services/openrouter/artifactDrafts.ts';
import {
  generateLessonVisualExample,
  inferExplicitVisualType,
} from '../../../services/openrouter/visualExamples.ts';

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

describe('explicit visual intent', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset();
    requestGeneratedImageMock.mockReset();
  });

  test.each([
    ['Crea un grafico a barre con questi dati', 'chart_html'],
    ['Disegna un diagramma entità-relazione per utenti e corsi', 'mermaid_erd'],
    ['Mostra un class diagram UML', 'mermaid_class'],
    ['Costruisci un diagramma di flusso del processo', 'flowchart_svg'],
    ['Rendilo un simulatore interattivo con uno slider', 'interactive_html'],
    ['Crea un’illustrazione realistica di una cellula', 'illustrative_image'],
  ] as const)('maps %s to %s without an LLM planner', (prompt, expectedType) => {
    expect(inferExplicitVisualType(prompt)).toBe(expectedType);
  });

  test('keeps ambiguous requests on the planner path', () => {
    expect(inferExplicitVisualType('Fammi una visuale utile per questa lezione')).toBeUndefined();
  });

  test('renders an explicit chart draft with one OpenRouter call', async () => {
    callOpenRouterMock.mockResolvedValueOnce(VALID_CHART_RESPONSE);

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

    expect(callOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(callOpenRouterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'renderer-model',
      })
    );
    expect(callOpenRouterMock.mock.calls[0]?.[0].messages[1].content).toContain(
      '"visual_type": "chart_html"'
    );
    expect(draft?.visual.kind).toBe('html');
  });

  test('generates an explicit image draft without an extra LLM renderer call', async () => {
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

    expect(callOpenRouterMock).not.toHaveBeenCalled();
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
  test('does not copy generated image bytes into a replacement prompt', async () => {
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
});

describe('SVG multimodal review', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset();
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
});
