// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

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

const scriptBeforeDomVisual: LessonGeneratedVisual = {
  code: '<script>document.getElementById("late-node").textContent = "ok";</script><div id="late-node"></div>',
  createdAt: '2026-05-07T00:00:00.000Z',
  id: 'visual-script-before-dom',
  kind: 'html',
  title: 'Script prima del DOM',
};

const missingElementVisual: LessonGeneratedVisual = {
  code: '<div id="present-node"></div><script>document.getElementById("missing-output").textContent = "ok";</script>',
  createdAt: '2026-05-07T00:00:00.000Z',
  id: 'visual-missing-element',
  kind: 'html',
  title: 'Elemento mancante',
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

  test('mounts generated HTML before replaying embedded scripts', () => {
    render(
      <GeneratedVisualFrame
        isDarkMode={false}
        title="Script prima del DOM"
        visual={scriptBeforeDomVisual}
      />
    );

    const frame = screen.getByTitle('Script prima del DOM');
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('template.innerHTML'));
    expect(frame).toHaveAttribute(
      'srcDoc',
      expect.stringContaining('await replayGeneratedVisualScripts(root)')
    );
    expect(frame).toHaveAttribute(
      'srcDoc',
      expect.stringContaining('document.getElementById(\\"late-node\\")')
    );
    expect(frame).toHaveAttribute(
      'srcDoc',
      expect.stringContaining('async function replayGeneratedVisualScripts')
    );
    expect(frame).toHaveAttribute(
      'srcDoc',
      expect.stringContaining('replayedScript.async = false')
    );
    expect(frame).toHaveAttribute(
      'srcDoc',
      expect.stringContaining("window.addEventListener('generated-visual-ready'")
    );
  });

  test('includes actionable visual diagnostics in runtime error reports', () => {
    render(
      <GeneratedVisualFrame
        isDarkMode={false}
        title="Elemento mancante"
        visual={missingElementVisual}
      />
    );

    const frame = screen.getByTitle('Elemento mancante');
    expect(frame).toHaveAttribute(
      'srcDoc',
      expect.stringContaining('const missingStaticElementIds = ["missing-output"]')
    );
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('visual-missing-element'));
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('generated-visual-error'));
  });

  test('forwards iframe runtime diagnostics to the main console', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <GeneratedVisualFrame
        isDarkMode={false}
        title="Elemento mancante"
        visual={missingElementVisual}
      />
    );

    const frame = screen.getByTitle('Elemento mancante') as HTMLIFrameElement;
    const error = {
      message: "can't access property textContent",
      missingElementIds: ['missing-output'],
      visualId: missingElementVisual.id,
      visualTitle: missingElementVisual.title,
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'generated-visual-error', error },
        source: frame.contentWindow,
      })
    );

    expect(consoleError).toHaveBeenCalledWith('[Nous] Generated visual runtime error', error);
    consoleError.mockRestore();
  });
});
