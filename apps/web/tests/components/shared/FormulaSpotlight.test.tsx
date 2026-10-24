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
  const read = () => ({
    elapsedMs,
    durationMs: 10000,
    cueTimes: [0, 2000, 4000, 6000, 8000],
    cueEndTimes: [500, 2500, 4500, 6500, 8500],
  });
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
  seek(1000);
  expect(container.querySelector('[data-formula-symbol][data-active="true"]')).toBeNull();
  expect(screen.getByText('La stima assegnata dal modello.')).not.toBeVisible();
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

test('highlights only the spoken subscript and leaves its base unselected', () => {
  const scene = {
    ...formulaSpotlight,
    formula: String.raw`\nousSymbol{x}_{\nousSymbol{i}}`,
    symbols: [
      { id: 'x', latex: 'x', name: 'Variabile', meaning: 'La variabile', anchor: 'ics' },
      { id: 'i', latex: 'i', name: 'Pedice', meaning: 'Il pedice', anchor: 'il pedice i' },
    ],
  };
  const { container } = render(
    <LessonSceneVisual
      scene={scene}
      variant="bare"
      readAnimationFrame={() => ({
        elapsedMs: 2100,
        durationMs: 4000,
        cueTimes: [0, 2000],
        cueEndTimes: [500, 2500],
      })}
    />
  );
  const selected = container.querySelectorAll('.spotlight-formula [data-active="true"]');
  expect(selected).toHaveLength(1);
  expect(selected[0].textContent).toBe('i');
  expect(container.querySelector('.nous-formula-symbol-x')?.getAttribute('data-active')).toBe(
    'false'
  );
});

test('highlights a symbol again when a later cue names the same formula position', () => {
  const { container } = render(
    <LessonSceneVisual
      scene={formulaSpotlight}
      variant="bare"
      readAnimationFrame={() => ({
        elapsedMs: 4200,
        durationMs: 6000,
        cueTimes: [0, 2000, 4000],
        cueEndTimes: [500, 2500, 4500],
        cueSymbolIndices: [0, 1, 0],
      })}
    />
  );
  expect(
    container.querySelector('.nous-formula-symbol-probability')?.getAttribute('data-active')
  ).toBe('true');
  expect(container.querySelector('.nous-formula-symbol-theta')?.getAttribute('data-active')).toBe(
    'false'
  );
  expect(container.querySelectorAll('[data-formula-symbol][data-active="true"]')).toHaveLength(1);
});
