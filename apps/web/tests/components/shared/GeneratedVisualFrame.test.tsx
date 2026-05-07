// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import GeneratedVisualFrame from '../../../components/shared/GeneratedVisualFrame.tsx';
import type { LessonGeneratedVisual } from '../../../types.ts';

const brightHtmlVisual: LessonGeneratedVisual = {
  code: '<div style="background-color:#c8fff2;color:#f4f4f4;border-color:#f4f4f4">Nodo chiaro</div>',
  createdAt: '2026-05-07T00:00:00.000Z',
  id: 'visual-bright-html',
  kind: 'html',
  title: 'Nodo chiaro',
};

const brightSvgVisual: LessonGeneratedVisual = {
  code: "<svg viewBox='0 0 100 60'><style>.box{fill:#ccfbf1;stroke:#14b8a6}.th{fill:#f4f4f4}</style><rect class='box' x='10' y='10' width='80' height='40'/><text class='th' x='50' y='30'>Nodo</text></svg>",
  createdAt: '2026-05-07T00:00:00.000Z',
  id: 'visual-bright-svg',
  kind: 'svg',
  title: 'Nodo SVG',
};

describe('GeneratedVisualFrame', () => {
  test('injects dark-mode normalization for generated HTML colors', () => {
    render(
      <GeneratedVisualFrame isDarkMode={true} title="Nodo chiaro" visual={brightHtmlVisual} />
    );

    const frame = screen.getByTitle('Nodo chiaro');
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('normalizeDarkHtmlTheme'));
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('toDarkSurfaceColor'));
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('background-color'));
    expect(frame).toHaveAttribute(
      'srcDoc',
      expect.stringContaining('background: transparent !important')
    );
  });

  test('injects dark-mode normalization for bright colored SVG fills', () => {
    render(<GeneratedVisualFrame isDarkMode={true} title="Nodo SVG" visual={brightSvgVisual} />);

    const frame = screen.getByTitle('Nodo SVG');
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('isBrightLightModeSurface'));
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('toDarkSurfaceColor(fill)'));
  });

  test('allows compact embedding without the default article spacing', () => {
    render(
      <GeneratedVisualFrame
        className="my-0"
        isDarkMode={true}
        title="Nodo compatto"
        visual={brightHtmlVisual}
      />
    );

    expect(screen.getByTitle('Nodo compatto').closest('figure')).toHaveClass('my-0');
  });
});
