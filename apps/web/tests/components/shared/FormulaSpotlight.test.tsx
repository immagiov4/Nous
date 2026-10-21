// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { formulaSpotlight } from '../../../../backend/tests/helpers/formulaSpotlight';
import { LessonSceneVisual } from '../../../components/shared/lessonScene/LessonSceneVisual';

test('expands only the narrated symbol and restores it on backward seeks', () => {
  let elapsedMs = 0;
  let callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const read = () => ({ elapsedMs, durationMs: 10000, cueTimes: [0, 2000, 4000, 6000, 8000] });
  const { container, rerender } = render(
    <LessonSceneVisual scene={formulaSpotlight} readAnimationFrame={read} variant="bare" />
  );
  expect(screen.getByText('Probabilità')).toBeVisible();
  expect(screen.getByText('La stima assegnata dal modello.')).toBeVisible();
  expect(screen.getByText('I valori appresi dal modello.')).not.toBeVisible();
  function seek(time: number) {
    elapsedMs = time;
    const pending = callbacks;
    callbacks = [];
    act(() => {
      for (const callback of pending) callback(time);
    });
  }
  seek(2000);
  expect(screen.getByText('La stima assegnata dal modello.')).not.toBeVisible();
  expect(screen.getByText('I valori appresi dal modello.')).toBeVisible();
  expect(container.querySelector('.nous-formula-symbol-theta')?.getAttribute('data-active')).toBe(
    'true'
  );
  rerender(<LessonSceneVisual scene={formulaSpotlight} readAnimationFrame={read} variant="bare" />);
  expect(container.querySelector('.nous-formula-symbol-theta')?.getAttribute('data-active')).toBe(
    'true'
  );
  seek(0);
  expect(screen.getByText('La stima assegnata dal modello.')).toBeVisible();
  expect(screen.getByText('I valori appresi dal modello.')).not.toBeVisible();
});
