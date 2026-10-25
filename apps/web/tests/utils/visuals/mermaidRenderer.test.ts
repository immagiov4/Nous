// @vitest-environment jsdom

import mermaid from 'mermaid';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  type MermaidRenderCache,
  renderMermaidDiagram,
} from '../../../utils/visuals/mermaidRenderer.ts';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg><text>Diagramma</text></svg>' })),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mermaid.render).mockReset().mockResolvedValue({
    svg: '<svg><text>Diagramma</text></svg>',
    diagramType: 'flowchart',
  });
});

test('renders through the bundled Mermaid API with the strict configuration', async () => {
  const signal = new AbortController().signal;

  await expect(renderMermaidDiagram('flowchart LR\nA --> B', true, signal)).resolves.toContain(
    '<svg>'
  );
  expect(mermaid.initialize).toHaveBeenCalledWith({
    securityLevel: 'strict',
    startOnLoad: false,
    theme: 'dark',
  });
  expect(mermaid.render).toHaveBeenCalledWith(
    expect.stringMatching(/^nous-mermaid-\d+$/),
    'flowchart LR\nA --> B'
  );
});

test('reuses a prepared SVG when drawing during playback is unavailable', async () => {
  const cache: MermaidRenderCache = new Map();
  const signal = new AbortController().signal;
  const prepared = await renderMermaidDiagram('flowchart LR\nA[Alpha]', false, signal, cache);
  vi.mocked(mermaid.render).mockRejectedValue(new Error('Drawing would block playback'));
  const svg = await renderMermaidDiagram('flowchart LR\nA[Alpha]', false, signal, cache);
  expect(
    new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('text')?.textContent
  ).toBe('Diagramma');
  expect(svg).toBe(prepared);
});

test('refreshes prepared diagrams when their source or theme changes', async () => {
  const cache: MermaidRenderCache = new Map();
  const signal = new AbortController().signal;
  const sources = ['flowchart LR\nA[Alpha]', 'flowchart LR\nA[Beta]'];
  vi.mocked(mermaid.render)
    .mockResolvedValueOnce({
      svg: '<svg fill="black"><text>Alpha</text></svg>',
      diagramType: 'flowchart',
    })
    .mockResolvedValueOnce({
      svg: '<svg fill="black"><text>Beta</text></svg>',
      diagramType: 'flowchart',
    })
    .mockResolvedValueOnce({
      svg: '<svg fill="white"><text>Beta</text></svg>',
      diagramType: 'flowchart',
    });
  const first = await renderMermaidDiagram(sources[0], false, signal, cache);
  const changed = await renderMermaidDiagram(sources[1], false, signal, cache);
  const dark = await renderMermaidDiagram(sources[1], true, signal, cache);
  const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(parse(first).querySelector('text')?.textContent).toBe('Alpha');
  expect(parse(changed).querySelector('text')?.textContent).toBe('Beta');
  expect(parse(dark).documentElement.getAttribute('fill')).toBe('white');
});

test('a retiring view does not cancel another consumer of its shared diagram', async () => {
  const cache: MermaidRenderCache = new Map();
  const controller = new AbortController();
  let finish!: (result: Awaited<ReturnType<typeof mermaid.render>>) => void;
  vi.mocked(mermaid.render).mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const first = renderMermaidDiagram('flowchart LR\nA[Alpha]', false, controller.signal, cache);
  const observed = first.catch(error => error);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  controller.abort();
  const second = renderMermaidDiagram(
    'flowchart LR\nA[Alpha]',
    false,
    new AbortController().signal,
    cache
  );
  finish({ svg: '<svg><text>Alpha</text></svg>', diagramType: 'flowchart' });
  expect(await observed).toBe(controller.signal.reason);
  const svg = await second;
  expect(
    new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('text')?.textContent
  ).toBe('Alpha');
});

test('a failed preparation does not poison a later diagram request', async () => {
  const cache: MermaidRenderCache = new Map();
  const signal = new AbortController().signal;
  vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('Renderer unavailable'));
  await expect(
    renderMermaidDiagram('flowchart LR\nA[Alpha]', false, signal, cache)
  ).rejects.toThrow('Renderer unavailable');
  const svg = await renderMermaidDiagram('flowchart LR\nA[Alpha]', false, signal, cache);
  expect(
    new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('text')?.textContent
  ).toBe('Diagramma');
});
