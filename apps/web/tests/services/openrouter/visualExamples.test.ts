import { beforeEach, describe, expect, test, vi } from 'vitest';

const { callOpenRouterMock } = vi.hoisted(() => ({
  callOpenRouterMock: vi.fn(),
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
  });

  test.each([
    ['Crea un grafico a barre con questi dati', 'chart_html'],
    ['Disegna un diagramma entità-relazione per utenti e corsi', 'mermaid_erd'],
    ['Mostra un class diagram UML', 'mermaid_class'],
    ['Costruisci un diagramma di flusso del processo', 'flowchart_svg'],
    ['Rendilo un simulatore interattivo con uno slider', 'interactive_html'],
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
});

describe('visual planner latency profile', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset();
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
});
