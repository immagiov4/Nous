// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { MarkedSlider } from '../../../components/shared/MarkedSlider.tsx';

test.each([
  { compact: false, thumb: 40, track: 36 },
  { compact: true, thumb: 32, track: 28 },
])('slider geometry follows its thumb size: compact=$compact', ({ compact, thumb, track }) => {
  const props = { compact, min: 0, max: 1, step: 0.1, markerCount: 3, onChange: vi.fn() };
  const { container, rerender } = render(<MarkedSlider {...props} value={0} />);
  const host = container.firstElementChild as HTMLElement;
  expect(host.style.getPropertyValue('--slider-thumb-size')).toBe(`${thumb}px`);
  expect(host.style.getPropertyValue('--slider-track-size')).toBe(`${track}px`);
  expect(container.querySelector<HTMLElement>('[data-slider-fill]')?.style.width).toBe(
    `calc(0% + ${thumb / 2}px)`
  );
  expect(container.querySelector<HTMLElement>('[data-slider-marker="1"]')?.style.left).toBe(
    `calc(100% - ${thumb / 2}px)`
  );
  rerender(<MarkedSlider {...props} value={1} />);
  expect(container.querySelector<HTMLElement>('[data-slider-fill]')?.style.width).toBe(
    `calc(100% - ${thumb / 2}px)`
  );
});
