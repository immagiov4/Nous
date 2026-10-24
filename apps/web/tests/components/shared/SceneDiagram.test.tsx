// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { LessonScene } from '@shared/lessonScene';
import { render, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SceneDiagram } from '../../../components/shared/lessonScene/SceneDiagram';

vi.mock('../../../utils/visuals/mermaidRenderer.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../utils/visuals/mermaidRenderer.ts')>()),
  renderConfiguredMermaid: async () => `<svg viewBox="0 -10 600 450" height="450">
      <line class="actor-line" y1="46" y2="2000" />
      <line class="actor-line" y1="46" y2="2000" />
      <line class="messageLine0" data-y="200" data-height="0" />
      <line class="messageLine1" data-y="270" data-height="0" />
      <path class="messageLine0" data-y="340" data-height="30" />
      <text class="messageText" data-y="320" data-height="16">Request</text>
    </svg>`,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(SVGElement.prototype, 'getBBox');
});

test('bounds sequence lifelines and SVG height to the final message, including self-message paths', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 600, 400)
  );
  // jsdom has no SVG layout engine; these are the message bounds returned by the browser API.
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value(this: SVGElement) {
      return new DOMRect(
        0,
        Number(this.getAttribute('data-y')),
        100,
        Number(this.getAttribute('data-height'))
      );
    },
  });
  const scene: LessonScene = {
    type: 'sequence',
    title: 'Requests',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [],
    diagram: {
      nodes: [
        { id: 'a', label: 'Client', kind: 'start' },
        { id: 'b', label: 'Service', kind: 'end' },
      ],
      edges: [
        { from: 'a', to: 'b', label: 'Request', kind: 'call', evidence: 'Request' },
        { from: 'b', to: 'a', label: 'Response', kind: 'return', evidence: 'Response' },
        { from: 'b', to: 'b', label: 'Local request', kind: 'call', evidence: 'Local request' },
      ],
    },
  };
  const { container } = render(<SceneDiagram scene={scene} isDarkMode={false} />);
  await waitFor(() => expect(container.querySelectorAll('.actor-line')).toHaveLength(2));
  expect(
    Array.from(container.querySelectorAll('.actor-line'), line => line.getAttribute('y2'))
  ).toEqual(['390', '390']);
  expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 -10 600 420');
  expect(container.querySelector('svg')).toHaveAttribute('height', '420');
  expect(container.querySelectorAll('.messageLine0, .messageLine1')).toHaveLength(3);
});
