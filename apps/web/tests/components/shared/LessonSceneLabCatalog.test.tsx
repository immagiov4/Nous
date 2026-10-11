// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { motionTargets } from '@shared/lessonPlayback';
import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import {
  LAB_COMPOSITION_SCENE,
  LAB_QUICK_SCENES,
} from '../../../../backend/tests/helpers/lessonSceneLabExamples';
import { LessonSceneVisual } from '../../../components/shared/lessonScene/LessonSceneVisual.tsx';
import { sceneElements } from '../../../components/workspace/playback/stageMotion.ts';

vi.mock('@tabler-icon-nodes', () => ({
  default: { point: [['circle', { cx: '12', cy: '12', r: '4' }]] },
}));

const example = (type: string) => {
  const scene = LAB_QUICK_SCENES.find(scene => scene.type === type);
  if (!scene) throw new Error(`Missing lab example: ${type}`);
  return scene;
};

describe('lab catalog rendering', () => {
  test.each([
    ...LAB_QUICK_SCENES,
    LAB_COMPOSITION_SCENE,
  ])('renders the authored $type example in both reader variants', scene => {
    const { container, rerender } = render(<LessonSceneVisual scene={scene} />);
    expect(container.querySelector('article')).toHaveClass(`type-${scene.type}`);
    expect(container.querySelector('h2')).toHaveTextContent(scene.title);
    expect(container.querySelectorAll('script, button, input')).toHaveLength(0);
    const elements = sceneElements(container, scene);
    expect([...elements.keys()].sort()).toEqual(
      motionTargets(scene)
        .map(target => target.id)
        .sort()
    );
    expect(container.innerHTML).not.toMatch(/NaN|undefined|Infinity/);
    rerender(<LessonSceneVisual scene={scene} variant="bare" />);
    expect(container.querySelector('figure')).toHaveClass('lesson-scene-bare');
    expect(container.innerHTML).not.toMatch(/NaN|undefined|Infinity/);
  });

  test('preserves integration banks, entities, and branch geometry', () => {
    const { container } = render(<LessonSceneVisual scene={example('integration')} />);
    expect(container.querySelectorAll('.q-bank')).toHaveLength(2);
    expect(container.querySelectorAll('.q-bank .q-box')).toHaveLength(4);
    expect(container.querySelectorAll('.q-core .q-box')).toHaveLength(1);
    expect(container.querySelector('.q-branches path')).toHaveAttribute(
      'd',
      'M 25 0 V 18 M 75 0 V 18 M 25 18 H 75 M 50 18 V 36'
    );
    expect(container.querySelectorAll('.q-branches-out')).toHaveLength(1);
  });

  test('preserves the funnel common scale including partial cells', () => {
    const { container } = render(<LessonSceneVisual scene={example('funnel')} />);
    expect(container.querySelectorAll('.q-funnel-cell')).toHaveLength(30);
    const widths = [...container.querySelectorAll('.q-funnel-cell-fill')].map(cell =>
      Number(cell.getAttribute('width'))
    );
    expect(widths.some(width => Math.abs(width - 3.6) < 1e-9)).toBe(true);
    expect(container.querySelector('.q-svg')).toHaveAttribute('viewBox', '0 0 640 378');
  });

  test('preserves radial and proportional geometry', () => {
    const { container, rerender } = render(<LessonSceneVisual scene={example('radar')} />);
    expect(container.querySelectorAll('circle.q-grid')).toHaveLength(4);
    expect(container.querySelectorAll('line.q-grid')).toHaveLength(4);
    // Trigonometry rounding differs across engines, so compare coordinates numerically.
    const radarPoints = (container.querySelector('.q-radar')?.getAttribute('points') ?? '')
      .split(/[ ,]/)
      .map(Number);
    expect(radarPoints).toHaveLength(8);
    [320, 106, 398, 210, 320, 340, 216, 210].forEach((coordinate, index) => {
      expect(radarPoints[index]).toBeCloseTo(coordinate);
    });
    rerender(<LessonSceneVisual scene={example('proportional-static')} />);
    expect(container.querySelectorAll('.q-units .q-box')).toHaveLength(4);
    expect(container.querySelector('.q-result strong')).toHaveTextContent('512 MB');
  });

  test('keeps composition properties and sequence in separate fixed panels', () => {
    const { container } = render(<LessonSceneVisual scene={LAB_COMPOSITION_SCENE} />);
    expect(container.querySelectorAll('.composed-panels > section')).toHaveLength(2);
    expect(
      container.querySelectorAll('.composed-panels > section:first-child .parts .concept')
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('.composed-panels > section:last-child .steps > li')
    ).toHaveLength(2);
  });

  test('renders the exact decimal proportional total', () => {
    const scene = { ...example('proportional-static'), quantity: 3, amountPerUnit: 0.1 };
    const { container } = render(<LessonSceneVisual scene={scene} />);
    expect(container.querySelector('.q-result strong')).toHaveTextContent(/0[.,]3 MB/);
    expect(container.querySelector('.q-result strong')?.textContent).not.toContain(
      '00000000000000004'
    );
  });

  test('escapes teaching text rather than executing it', () => {
    const scene = {
      ...example('process'),
      items: [
        { label: '<script>alert(1)</script>', detail: '" onmouseover="bad', icon: '' },
        { label: 'B', detail: '', icon: '' },
      ],
    };
    const { container } = render(<LessonSceneVisual scene={scene} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('.q-box strong')).toHaveTextContent('<script>alert(1)</script>');
    expect(container.querySelector('.q-box p')).toHaveTextContent('" onmouseover="bad');
    expect(container.querySelector('[onmouseover]')).toBeNull();
  });
});
