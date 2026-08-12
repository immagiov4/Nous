// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import GeneratedVisualFrame from '../../../components/shared/GeneratedVisualFrame.tsx';
import type { LessonGeneratedVisual } from '../../../types.ts';
import { renderMermaidDiagram } from '../../../utils/visuals/mermaidRenderer.ts';

vi.mock('../../../utils/visuals/mermaidRenderer.ts', () => ({
  renderMermaidDiagram: vi.fn(async () => '<svg viewBox="0 0 100 50"><text>Agente</text></svg>'),
}));

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

const mermaidVisual: LessonGeneratedVisual = {
  code: 'flowchart LR\n  A[Contesto] --> B[Agente]',
  createdAt: '2026-08-08T00:00:00.000Z',
  id: 'visual-mermaid',
  kind: 'mermaid',
  title: 'Flusso del contesto',
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

const invalidScriptVisual: LessonGeneratedVisual = {
  code: '<div>Contenuto valido</div><script>const broken = );</script>',
  createdAt: '2026-05-07T00:00:00.000Z',
  id: 'visual-invalid-script',
  kind: 'html',
  title: 'Script non valido',
};

const rasterImageVisual = {
  altText: 'Sezione trasversale di una foglia',
  code: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
  createdAt: '2026-07-10T00:00:00.000Z',
  id: 'visual-raster-image',
  kind: 'image',
  mediaType: 'image/png',
  title: 'sezione_foglia',
} as unknown as LessonGeneratedVisual;

const unsafeImageVisual = {
  altText: 'Immagine non sicura',
  code: 'javascript:alert(1)',
  createdAt: '2026-07-10T00:00:00.000Z',
  id: 'visual-unsafe-image',
  kind: 'image',
  mediaType: 'image/png',
  title: 'immagine_non_sicura',
} as unknown as LessonGeneratedVisual;

const externalResourceVisual: LessonGeneratedVisual = {
  code: '<form><input></form><script src="https://example.com/widget.js"></script>',
  createdAt: '2026-08-10T00:00:00.000Z',
  id: 'visual-external-resource',
  kind: 'html',
  title: 'Risorsa esterna',
};
describe('GeneratedVisualFrame', () => {
  test('renders generated raster images directly without an iframe', () => {
    render(<GeneratedVisualFrame title="Sezione foglia" visual={rasterImageVisual} />);

    expect(screen.getByRole('img', { name: 'Sezione trasversale di una foglia' })).toHaveAttribute(
      'src',
      rasterImageVisual.code
    );
    expect(screen.queryByTitle('Sezione foglia')).toBeNull();
  });

  test('rejects unsafe generated image sources', () => {
    render(<GeneratedVisualFrame title="Immagine non sicura" visual={unsafeImageVisual} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Immagine non disponibile');
  });

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
  });

  test('fits the complete locally rendered Mermaid diagram inside a thumbnail viewport', async () => {
    render(
      <div className="h-16">
        <GeneratedVisualFrame
          className="h-full my-0"
          displayMode="thumbnail"
          title="Flusso del contesto"
          visual={mermaidVisual}
        />
      </div>
    );

    const frame = await screen.findByTitle('Flusso del contesto');
    expect(frame).toHaveClass('h-full');
    expect(frame).toHaveStyle({ height: '100%', minHeight: '0' });
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('.mermaid > svg'));
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('max-height: 100% !important'));
    expect(frame).not.toHaveAttribute('srcDoc', expect.stringContaining('cdn.jsdelivr.net'));
    expect(frame).not.toHaveAttribute('srcDoc', expect.stringContaining('<script src='));
    expect(renderMermaidDiagram).toHaveBeenCalledWith(
      mermaidVisual.code,
      false,
      expect.any(AbortSignal)
    );
  });

  test('uses the strict capability sandbox and content security policy', () => {
    render(<GeneratedVisualFrame title="Nodo chiaro" visual={brightHtmlVisual} />);

    const frame = screen.getByTitle('Nodo chiaro');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame).toHaveAttribute(
      'srcDoc',
      expect.stringContaining("default-src 'none'; script-src 'unsafe-inline'")
    );
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining("connect-src 'none'"));
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining("form-action 'none'"));
    expect(frame).toHaveAttribute('srcDoc', expect.stringContaining('img-src data: blob:'));
  });

  test('marks historical visuals requiring forbidden capabilities as unavailable', async () => {
    render(<GeneratedVisualFrame title="Risorsa esterna" visual={externalResourceVisual} />);

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Esempio visuale non disponibile')
    );
    expect(screen.queryByTitle('Risorsa esterna')).toBeNull();
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
    expect(frame).not.toHaveAttribute(
      'srcDoc',
      expect.stringContaining('Function(script.textContent')
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
    expect(frame).toHaveAttribute(
      'srcDoc',
      expect.stringContaining('Generated visual failed the DOM reference preflight.')
    );
  });

  test('executes inline scripts without requiring the forbidden eval capability', () => {
    render(
      <GeneratedVisualFrame
        isDarkMode={false}
        title="Script non valido"
        visual={invalidScriptVisual}
      />
    );

    const frame = screen.getByTitle('Script non valido');
    const srcDoc = frame.getAttribute('srcDoc') ?? '';
    const insertionIndex = srcDoc.indexOf('script.replaceWith(replayedScript)');

    expect(srcDoc).not.toContain("Function(script.textContent || '')");
    expect(insertionIndex).toBeGreaterThan(-1);
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
    globalThis.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'generated-visual-error', error },
        source: frame.contentWindow,
      })
    );

    expect(consoleError).toHaveBeenCalledWith('[Nous] Generated visual runtime error', error);
    consoleError.mockRestore();
  });

  test('removes a visual when the browser blocks a dynamically requested capability', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<GeneratedVisualFrame title="Nodo chiaro" visual={brightHtmlVisual} />);

    const frame = screen.getByTitle('Nodo chiaro') as HTMLIFrameElement;
    globalThis.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'generated-visual-capability-blocked',
          blockedUri: 'https://example.com/runtime-resource.js',
          directive: 'script-src-elem',
        },
        source: frame.contentWindow,
      })
    );

    expect(await screen.findByRole('status')).toHaveTextContent('Esempio visuale non disponibile');
    expect(screen.queryByTitle('Nodo chiaro')).toBeNull();
    consoleError.mockRestore();
  });

  test('allows a regenerated visual with the same id after a blocked capability', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <GeneratedVisualFrame title="Nodo chiaro" visual={brightHtmlVisual} />
    );
    const frame = screen.getByTitle('Nodo chiaro') as HTMLIFrameElement;
    globalThis.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'generated-visual-capability-blocked' },
        source: frame.contentWindow,
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Esempio visuale non disponibile');

    rerender(
      <GeneratedVisualFrame
        title="Nodo rigenerato"
        visual={{ ...brightHtmlVisual, code: '<button>Visuale rigenerato</button>' }}
      />
    );

    expect(await screen.findByTitle('Nodo rigenerato')).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
