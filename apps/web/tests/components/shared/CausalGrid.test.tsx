// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { CausalGrid } from '../../../components/shared/lessonScene/CausalGrid.tsx';

afterEach(() => vi.unstubAllGlobals());

test.each([
  'columns',
  'stack',
] as const)('connects the authored sequence across %s and updates after resizing', layout => {
  let resize!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  const items = ['First', 'Second', 'Third', 'Fourth'].map((label, index) => ({
    label,
    detail: index ? 'Explanation' : '',
    icon: 'point',
  }));
  const { container, rerender, unmount } = render(<CausalGrid items={items} />);
  const flow = container.querySelector('ol');
  if (!flow) throw Error('Ordered cards must be mounted');
  expect(container.querySelector('svg')).toBeNull();
  flow.style.setProperty('--connector-width', '2');
  flow.style.setProperty('--icon-size', '16');
  Object.defineProperties(flow, {
    offsetWidth: { value: layout === 'columns' ? 240 : 100 },
    offsetHeight: { value: layout === 'columns' ? 160 : 360 },
  });
  [...flow.children].forEach((card, index) => {
    Object.defineProperties(card, {
      offsetLeft: { value: layout === 'columns' ? (index % 2) * 140 : 0 },
      offsetTop: { value: (layout === 'columns' ? Math.floor(index / 2) : index) * 100 },
      offsetWidth: { value: 100 },
      offsetHeight: { value: 60 },
    });
  });
  act(resize);
  const lines = () => [...container.querySelectorAll('path')].map(path => path.getAttribute('d'));
  const expected =
    layout === 'columns'
      ? ['M100,30 L140,30 ', 'M190,60 V80 H50 V100 ', 'M100,130 L140,130 ']
      : ['M50,60 V80 H50 V100 ', 'M50,160 V180 H50 V200 ', 'M50,260 V280 H50 V300 '];
  expect(lines()).toHaveLength(3);
  expected.forEach((prefix, index) => expect(lines()[index]).toMatch(prefix));
  expect([...flow.querySelectorAll('strong')].map(card => card.textContent)).toEqual(
    items.map(item => item.label)
  );
  expect([...flow.querySelectorAll('.step-index')].map(step => step.textContent)).toEqual([
    '01',
    '02',
    '03',
    '04',
  ]);
  expect(flow.querySelectorAll('p')).toHaveLength(3);
  expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe(
    layout === 'columns' ? '0 0 240 160' : '0 0 100 360'
  );
  act(resize);
  expect(lines()).toHaveLength(3);
  flow.style.setProperty('--connector-width', '3');
  act(resize);
  expect(container.querySelector('g')?.getAttribute('stroke-width')).toBe('3');
  rerender(<CausalGrid items={items.slice(0, 3)} />);
  expect(lines()).toHaveLength(2);
  expect(disconnect).toHaveBeenCalledOnce();
  unmount();
  expect(disconnect).toHaveBeenCalledTimes(2);
});
