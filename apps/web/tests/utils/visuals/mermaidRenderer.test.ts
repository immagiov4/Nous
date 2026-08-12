// @vitest-environment jsdom

import mermaid from 'mermaid';
import { beforeEach, expect, test, vi } from 'vitest';
import { renderMermaidDiagram } from '../../../utils/visuals/mermaidRenderer.ts';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg><text>Diagramma</text></svg>' })),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
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
