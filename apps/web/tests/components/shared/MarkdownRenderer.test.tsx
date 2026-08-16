// @vitest-environment jsdom
import type { ProjectDocumentImageAsset } from '@shared/projectAsset';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import MarkdownRenderer from '../../../components/shared/MarkdownRenderer.tsx';
import { resolveProjectDocumentImage } from '../../../services/projects/projectDocumentImageResolver.ts';
import {
  getSectionAnnotationHighlightHit,
  resolveSectionAnnotationHighlightEntries,
} from '../../../utils/learning/sectionAnnotationHighlights.ts';

vi.mock('../../../services/projects/projectDocumentImageResolver.ts', async importOriginal => ({
  ...(await importOriginal()),
  resolveProjectDocumentImage: vi.fn(),
}));

const originalRangeGetClientRects = Range.prototype.getClientRects;
const originalDocumentFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');

afterEach(() => {
  vi.mocked(resolveProjectDocumentImage).mockReset();
  vi.unstubAllGlobals();
  if (originalRangeGetClientRects) {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: originalRangeGetClientRects,
    });
  } else {
    Reflect.deleteProperty(Range.prototype, 'getClientRects');
  }
  if (originalDocumentFontsDescriptor) {
    Object.defineProperty(document, 'fonts', originalDocumentFontsDescriptor);
  } else {
    Reflect.deleteProperty(document, 'fonts');
  }
});

describe('MarkdownRenderer', () => {
  test('paints anchored annotations without inserting marks when CSS highlights are available', () => {
    class TestHighlight extends Set<AbstractRange> {}

    const highlights = new Map<string, TestHighlight>();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', TestHighlight);
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [
        { bottom: 28, height: 18, left: 10, right: 35, top: 10, width: 25 },
        { bottom: 42, height: 33, left: 35, right: 55, top: 9, width: 20 },
        { bottom: 28, height: 18, left: 55, right: 80, top: 10, width: 25 },
        { bottom: 50, height: 18, left: 10, right: 45, top: 32, width: 35 },
      ],
    });

    const annotation = {
      anchor: {
        kind: 'selection' as const,
        selector: {
          end: 37,
          exact: 'Prima grassetto, poi codice e finale.',
          prefix: '',
          start: 0,
          suffix: '',
        },
      },
      createdAt: '2026-07-15T10:00:00.000Z',
      id: 'annotation-native',
      note: 'Nota utile',
      updatedAt: '2026-07-15T10:00:00.000Z',
    };

    const { container, rerender, unmount } = render(
      <MarkdownRenderer
        content={'Prima **grassetto**, poi `codice` e finale.'}
        sectionAnnotations={[annotation]}
      />
    );

    expect(container.querySelector('mark')).toBeNull();
    const paragraph = container.querySelector('p');
    const annotationHighlight = highlights.get('nous-annotations');
    const noteHighlight = highlights.get('nous-annotation-notes');
    expect(annotationHighlight).toBeDefined();
    expect(
      Array.from(annotationHighlight || [])
        .map(range => range.toString())
        .join('')
    ).toBe(annotation.anchor.selector.exact);
    expect(annotationHighlight).toHaveLength(1);
    expect(noteHighlight?.size).toBe(annotationHighlight?.size);
    expect(screen.getByText('codice')).toHaveAttribute(
      'data-nous-annotation-inline-highlight',
      'true'
    );
    const highlightLines = Array.from(
      container.querySelectorAll<HTMLElement>('.nous-annotation-highlight-line')
    );
    expect(highlightLines).toHaveLength(2);
    expect(highlightLines.map(line => line.style.left)).toEqual(['7px', '7px']);
    expect(highlightLines.map(line => line.style.top)).toEqual(['9px', '32px']);
    expect(highlightLines.map(line => line.style.width)).toEqual(['76px', '41px']);
    expect(highlightLines.map(line => line.style.height)).toEqual(['33px', '18px']);
    expect(highlightLines.every(line => line.style.maxWidth === 'none')).toBe(true);

    rerender(
      <MarkdownRenderer
        content={'Prima **grassetto**, poi `codice` e finale.'}
        sectionAnnotations={[{ ...annotation, note: 'Nota aggiornata' }]}
      />
    );
    expect(container.querySelector('p')).toBe(paragraph);
    expect(container.querySelector('mark')).toBeNull();

    unmount();
    expect(highlights.get('nous-annotations')?.size).toBe(0);
  });

  test('resolves native annotation clicks from highlight rectangles when caret lookup is unavailable', () => {
    class TestHighlight extends Set<AbstractRange> {}

    vi.stubGlobal('CSS', { highlights: new Map<string, TestHighlight>() });
    vi.stubGlobal('Highlight', TestHighlight);
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ bottom: 28, height: 18, left: 10, right: 80, top: 10, width: 70 }],
    });
    let clickedEvent: Event | null = null;
    const { container } = render(
      <MarkdownRenderer
        content="Passaggio annotato."
        onClick={event => {
          clickedEvent = event.nativeEvent;
        }}
        sectionAnnotations={[
          {
            anchor: {
              kind: 'selection',
              selector: {
                end: 18,
                exact: 'Passaggio annotato',
                prefix: '',
                start: 0,
                suffix: '.',
              },
            },
            createdAt: '2026-07-15T10:00:00.000Z',
            id: 'annotation-mobile-hit',
            note: 'Nota mobile',
            updatedAt: '2026-07-15T10:00:00.000Z',
          },
        ]}
      />
    );

    fireEvent.click(container.querySelector('article') as HTMLElement, {
      clientX: 20,
      clientY: 18,
    });

    if (!clickedEvent) {
      throw new Error('The annotation click did not reach the Markdown renderer.');
    }
    expect(getSectionAnnotationHighlightHit(clickedEvent)).toMatchObject({
      annotationId: 'annotation-mobile-hit',
      selectedText: 'Passaggio annotato',
    });
  });

  test('renders one continuous mark while preserving nested inline formatting', () => {
    const { container } = render(
      <MarkdownRenderer
        content={
          '<mark data-nous-annotation-id="annotation-inline">Prima **grassetto**, poi *corsivo* e infine [un link](https://example.com/percorso_(test) "Titolo con ) parentesi")</mark>.'
        }
      />
    );

    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].querySelector('strong')).toHaveTextContent('grassetto');
    expect(marks[0].querySelector('em')).toHaveTextContent('corsivo');
    expect(marks[0].querySelector('a')).toHaveAttribute(
      'href',
      'https://example.com/percorso_(test)'
    );
  });

  test('splits native highlight ranges around DOM nodes excluded from speech', () => {
    const article = document.createElement('article');
    article.innerHTML = 'Prima<span data-nous-speech="ignore">contenuto ignorato</span>finale.';
    const entries = resolveSectionAnnotationHighlightEntries(article, [
      {
        anchor: {
          kind: 'selection',
          selector: {
            end: 12,
            exact: 'Primafinale.',
            prefix: '',
            start: 0,
            suffix: '',
          },
        },
        createdAt: '2026-07-22T10:00:00.000Z',
        id: 'annotation-ignored-gap',
        note: '',
        updatedAt: '2026-07-22T10:00:00.000Z',
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.ranges).toHaveLength(2);
    expect(entries[0]?.ranges.map(range => range.toString())).toEqual(['Prima', 'finale.']);
  });

  test('native persisted highlights re-anchor a repeated quote only where saved context matches', () => {
    const article = document.createElement('article');
    article.innerHTML = '<p>Nuovo. Beta uno. Beta due.</p>';
    const entries = resolveSectionAnnotationHighlightEntries(article, [
      {
        anchor: {
          kind: 'selection',
          selector: {
            end: 14,
            exact: 'Beta',
            prefix: 'Beta uno.',
            start: 10,
            suffix: 'due.',
          },
        },
        createdAt: '2026-08-15T10:00:00.000Z',
        id: 'annotation-native-repeated',
        note: '',
        updatedAt: '2026-08-15T10:00:00.000Z',
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.ranges).toHaveLength(1);
    expect(entries[0]?.ranges[0]?.toString()).toBe('Beta');
    expect(entries[0]?.ranges[0]?.startOffset).toBe('Nuovo. Beta uno. '.length);
  });

  test('native persisted highlights stay hidden when the remaining duplicate mismatches context', () => {
    const article = document.createElement('article');
    article.innerHTML = '<p>Beta uno.</p>';
    const entries = resolveSectionAnnotationHighlightEntries(article, [
      {
        anchor: {
          kind: 'selection',
          selector: {
            end: 14,
            exact: 'Beta',
            prefix: 'Beta uno.',
            start: 10,
            suffix: 'due.',
          },
        },
        createdAt: '2026-08-15T10:00:00.000Z',
        id: 'annotation-native-orphaned',
        note: '',
        updatedAt: '2026-08-15T10:00:00.000Z',
      },
    ]);

    expect(entries).toEqual([]);
  });

  test('native persisted highlights stay hidden when boundary context is unavailable', () => {
    const article = document.createElement('article');
    article.innerHTML = '<p>Beta due.</p>';
    const entries = resolveSectionAnnotationHighlightEntries(article, [
      {
        anchor: {
          kind: 'selection',
          selector: {
            end: 14,
            exact: 'Beta',
            prefix: 'Beta uno.',
            start: 10,
            suffix: '',
          },
        },
        createdAt: '2026-08-15T10:00:00.000Z',
        id: 'annotation-native-unavailable-boundary-context',
        note: '',
        updatedAt: '2026-08-15T10:00:00.000Z',
      },
    ]);

    expect(entries).toEqual([]);
  });

  test('preserves visible whitespace between raw block and inline elements', () => {
    const article = document.createElement('article');
    article.innerHTML = '<p>Alpha</p> <span>beta</span>';
    const entries = resolveSectionAnnotationHighlightEntries(article, [
      {
        anchor: {
          kind: 'selection',
          selector: { end: 10, exact: 'Alpha beta', prefix: '', start: 0, suffix: '' },
        },
        createdAt: '2026-08-15T10:00:00.000Z',
        id: 'annotation-mixed-html-whitespace',
        note: '',
        updatedAt: '2026-08-15T10:00:00.000Z',
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.selectedText).toBe('Alpha beta');
    expect(entries[0]?.ranges.map(range => range.toString()).join('')).toBe('Alpha beta');
  });

  test('keeps long multi-paragraph highlights inside paragraph ranges without side bands', () => {
    class TestHighlight extends Set<AbstractRange> {}

    vi.stubGlobal('CSS', { highlights: new Map<string, TestHighlight>() });
    vi.stubGlobal('Highlight', TestHighlight);
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: function (this: Range) {
        const paragraphIndex = [
          'Primo paragrafo lungo.',
          'Secondo paragrafo lungo.',
          'Terzo paragrafo lungo.',
        ].indexOf(this.toString());
        const top = paragraphIndex * 72;
        return [
          { bottom: top + 18, height: 18, left: 20, right: 80, top, width: 60 },
          { bottom: top + 36, height: 18, left: 0, right: 100, top: top + 18, width: 100 },
          { bottom: top + 54, height: 18, left: 10, right: 70, top: top + 36, width: 60 },
        ];
      },
    });

    const exact = 'Primo paragrafo lungo. Secondo paragrafo lungo. Terzo paragrafo lungo.';
    const { container } = render(
      <MarkdownRenderer
        content={'Primo paragrafo lungo.\n\nSecondo paragrafo lungo.\n\nTerzo paragrafo lungo.'}
        sectionAnnotations={[
          {
            anchor: {
              kind: 'selection',
              selector: { end: exact.length, exact, prefix: '', start: 0, suffix: '' },
            },
            createdAt: '2026-08-15T10:00:00.000Z',
            id: 'annotation-multi-paragraph',
            note: '',
            updatedAt: '2026-08-15T10:00:00.000Z',
          },
        ]}
      />
    );

    const highlight = (CSS.highlights as Map<string, TestHighlight>).get('nous-annotations');
    expect(Array.from(highlight || []).map(range => range.toString())).toEqual([
      'Primo paragrafo lungo.',
      'Secondo paragrafo lungo.',
      'Terzo paragrafo lungo.',
    ]);
    const highlightLines = Array.from(
      container.querySelectorAll<HTMLElement>('.nous-annotation-highlight-line')
    );
    expect(highlightLines).toHaveLength(9);
    expect(highlightLines.map(line => line.style.left)).toEqual([
      '17px',
      '-3px',
      '7px',
      '17px',
      '-3px',
      '7px',
      '17px',
      '-3px',
      '7px',
    ]);
    expect(highlightLines.map(line => line.style.width)).toEqual([
      '66px',
      '106px',
      '66px',
      '66px',
      '106px',
      '66px',
      '66px',
      '106px',
      '66px',
    ]);
    expect(highlightLines.map(line => line.style.height)).toEqual(Array(9).fill('18px'));
  });

  test('resolves native highlights around inline KaTeX from the canonical TeX projection', () => {
    const content =
      'La convenzione OpenXR usa $+X$ verso destra, $+Y$ verso l’alto e $-Z$ in avanti.';
    const { container } = render(<MarkdownRenderer content={content} />);
    const article = container.querySelector('article');
    expect(article).not.toBeNull();

    const entries = resolveSectionAnnotationHighlightEntries(article as HTMLElement, [
      {
        anchor: {
          kind: 'selection',
          selector: {
            end: content.length,
            exact: 'La convenzione OpenXR usa +X verso destra, +Y verso l’alto e -Z in avanti.',
            prefix: '',
            start: 0,
            suffix: '',
          },
        },
        createdAt: '2026-07-25T10:00:00.000Z',
        id: 'annotation-inline-katex',
        note: '',
        updatedAt: '2026-07-25T10:00:00.000Z',
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.ranges).toHaveLength(7);
    expect(entries[0]?.ranges.map(range => range.toString()).join('')).toContain('+X');
    expect(entries[0]?.ranges.map(range => range.toString()).join('')).toContain('+Y');
    expect(entries[0]?.ranges.map(range => range.toString()).join('')).toContain('−Z');
  });

  test('uses one stable line geometry across normal text and inline math fragments', () => {
    class TestHighlight extends Set<AbstractRange> {}

    vi.stubGlobal('CSS', { highlights: new Map<string, TestHighlight>() });
    vi.stubGlobal('Highlight', TestHighlight);
    const exact = 'Normale x1 e y2 finale.';
    const fragmentRects = [
      { bottom: 28, height: 18, left: 10, right: 50, top: 10, width: 40 },
      { bottom: 32, height: 15, left: 62, right: 68, top: 17, width: 6 },
      { bottom: 28, height: 18, left: 74, right: 92, top: 10, width: 18 },
      { bottom: 23, height: 15, left: 104, right: 110, top: 8, width: 6 },
      { bottom: 28, height: 18, left: 116, right: 146, top: 10, width: 30 },
    ];
    let clientRectCallIndex = 0;
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [fragmentRects[clientRectCallIndex++]].filter(Boolean),
    });

    const { container } = render(
      <MarkdownRenderer
        content={'Normale $x_1$ e $y^2$ finale.'}
        sectionAnnotations={[
          {
            anchor: {
              kind: 'selection',
              selector: { end: exact.length, exact, prefix: '', start: 0, suffix: '' },
            },
            createdAt: '2026-08-16T10:00:00.000Z',
            id: 'annotation-line-metrics',
            note: '',
            updatedAt: '2026-08-16T10:00:00.000Z',
          },
        ]}
      />
    );

    const highlightLines = Array.from(
      container.querySelectorAll<HTMLElement>('.nous-annotation-highlight-line')
    );
    expect(highlightLines).toHaveLength(1);
    expect(highlightLines[0]?.style.left).toBe('7px');
    expect(highlightLines[0]?.style.top).toBe('8px');
    expect(highlightLines[0]?.style.width).toBe('142px');
    expect(highlightLines[0]?.style.height).toBe('24px');
  });

  test('remeasures highlight lines after document fonts finish loading', async () => {
    class TestHighlight extends Set<AbstractRange> {}

    vi.stubGlobal('CSS', { highlights: new Map<string, TestHighlight>() });
    vi.stubGlobal('Highlight', TestHighlight);
    let resolveFontsReady = () => {};
    const fontsReady = new Promise<void>(resolve => {
      resolveFontsReady = resolve;
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: fontsReady },
    });
    let fontsAreReady = false;
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [
        {
          bottom: 28,
          height: 18,
          left: 10,
          right: fontsAreReady ? 90 : 50,
          top: 10,
          width: fontsAreReady ? 80 : 40,
        },
      ],
    });

    const exact = 'Testo con font tardivo.';
    const { container } = render(
      <MarkdownRenderer
        content={exact}
        sectionAnnotations={[
          {
            anchor: {
              kind: 'selection',
              selector: { end: exact.length, exact, prefix: '', start: 0, suffix: '' },
            },
            createdAt: '2026-08-16T10:00:00.000Z',
            id: 'annotation-font-ready',
            note: '',
            updatedAt: '2026-08-16T10:00:00.000Z',
          },
        ]}
      />
    );
    const getHighlightLine = () =>
      container.querySelector<HTMLElement>('.nous-annotation-highlight-line');

    expect(getHighlightLine()?.style.width).toBe('46px');
    fontsAreReady = true;
    resolveFontsReady();

    await waitFor(() => expect(getHighlightLine()?.style.width).toBe('86px'));
  });

  test('softens annotation edges with minimal horizontal spacing', () => {
    const { container } = render(
      <MarkdownRenderer
        content={
          '<mark data-nous-annotation-id="annotation-detached">Prima **grassetto** e [un link](https://example.com).</mark>'
        }
        sectionAnnotations={[
          {
            anchor: {
              kind: 'selection',
              selector: {
                end: 48,
                exact: 'Prima grassetto e un link.',
                prefix: '',
                start: 0,
                suffix: '',
              },
            },
            createdAt: '2026-07-14T10:00:00.000Z',
            id: 'annotation-detached',
            note: 'Nota utile',
            updatedAt: '2026-07-14T10:00:00.000Z',
          },
        ]}
      />
    );

    const mark = container.querySelector('mark[data-nous-annotation-id="annotation-detached"]');
    expect(mark).toHaveTextContent('Prima grassetto e un link.');
    expect(mark?.querySelector('strong')).toHaveTextContent('grassetto');
    expect(mark?.querySelector('a')).toHaveAttribute('href', 'https://example.com');
    expect(mark).toHaveStyle({
      backgroundColor: 'var(--annotation-highlight-color)',
      margin: '0',
      padding: '0px 3px',
    });
    expect(mark?.getAttribute('style')).toContain('border-radius: 0.14em');
    expect(mark?.getAttribute('style')).toContain('box-decoration-break: clone');
    expect(mark?.getAttribute('style')).toContain('text-decoration-line: underline');
    expect(mark?.getAttribute('style')).toContain('text-decoration-style: dashed');
  });

  test('renders markdown lists as semantic lists with visible list styling classes', () => {
    const { container } = render(
      <MarkdownRenderer content={'### Strategia\n- Primo controllo\n- Secondo controllo'} />
    );

    expect(container.querySelector('ul')).not.toBeNull();
    expect(screen.getByText('Primo controllo').tagName.toLowerCase()).toBe('li');
    expect(container.querySelector('article')).toHaveClass('[&_ul]:list-disc');
  });

  test('renders code, inline code, links and context-menu handlers', () => {
    const onContextMenu = vi.fn();
    const onClick = vi.fn();
    const { container } = render(
      <MarkdownRenderer
        content={'```ts\nconst answer = 42;\n```\n\nUse `value`.\n\n[Docs](https://example.com)'}
        onClick={onClick}
        onContextMenu={onContextMenu}
      />
    );

    expect(screen.getByText('Docs')).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByText('Docs')).toHaveAttribute('target', '_blank');
    expect(screen.getByText('value').tagName.toLowerCase()).toBe('code');
    expect(screen.getByText('value').closest('pre')).toBeNull();
    expect(container.querySelector('pre')).toHaveTextContent('const answer = 42;');

    const article = container.querySelector('article');
    expect(article).not.toBeNull();
    if (!article) {
      throw new Error('Expected markdown article to be rendered.');
    }

    fireEvent.contextMenu(article);
    fireEvent.click(article);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('renders indented plain-text fragments without code blocks or invalid nested markup', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          'Testo introduttivo',
          '',
          '    Figura 3.3',
          '',
          '    chunk-022',
          '',
          '    /',
          '',
          'Usa `generateCurrentLessonArtifact` per continuare.',
        ].join('\n')}
      />
    );

    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getByText('Figura 3.3')).toBeInTheDocument();
    expect(screen.getByText('chunk-022')).toBeInTheDocument();
    expect(screen.getByText('generateCurrentLessonArtifact').closest('p')).not.toBeNull();
    expect(container.querySelector('p pre')).toBeNull();
  });

  test('renders JSON with a missing opening fence as one code block', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          'Il server trova nello store:',
          '',
          '{',
          '  "userId": "42",',
          '  "role": "editor"',
          '}',
          '```',
          '',
          'La sessione resta sotto il controllo del server.',
        ].join('\n')}
      />
    );

    const codeBlocks = container.querySelectorAll('pre');
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]).toHaveTextContent('"userId": "42"');
    expect(codeBlocks[0]).toHaveTextContent('"role": "editor"');
    expect(screen.queryByText('```')).not.toBeInTheDocument();
    expect(
      screen.getByText('La sessione resta sotto il controllo del server.')
    ).toBeInTheDocument();
  });

  test('keeps malformed nested and unclosed fences from swallowing the rest of the lesson', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          '```js',
          'const first = true;',
          '```javascript',
          'const nested = true;',
          '```',
          '',
          '## Dopo il primo blocco',
          '',
          '```ts',
          'const answer = 42;',
          '## Dopo il fence aperto',
          'Testo ancora leggibile.',
        ].join('\n')}
      />
    );

    expect(container.querySelector('pre')).toHaveTextContent('const nested = true;');
    expect(screen.getByRole('heading', { name: 'Dopo il primo blocco' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dopo il fence aperto' })).toBeInTheDocument();
    expect(screen.getByText('Testo ancora leggibile.')).toBeInTheDocument();
  });

  test('normalizes common code language aliases before syntax highlighting', () => {
    const { container } = render(
      <MarkdownRenderer content={'```js\nconst answer = 42;\n```\n\n```html\n<p>ok</p>\n```'} />
    );

    expect(container.querySelector('code.language-javascript')).toHaveTextContent(
      'const answer = 42;'
    );
    expect(container.querySelector('code.language-markup')).toHaveTextContent('<p>ok</p>');
  });

  test('drops unsafe raw html and attributes while preserving annotation ids', () => {
    const { container } = render(
      <MarkdownRenderer
        content={
          '<script>window.bad = true</script><mark data-nous-annotation-id="annotation-1" style="display:none" onclick="bad()">focus</mark>'
        }
      />
    );

    const mark = container.querySelector('mark[data-nous-annotation-id="annotation-1"]');
    expect(container.querySelector('script')).toBeNull();
    expect(mark).toHaveTextContent('focus');
    expect(mark).not.toHaveStyle({ display: 'none' });
    expect(mark).not.toHaveAttribute('onclick');
  });

  test('renders markdown tables with semantic cells', () => {
    render(<MarkdownRenderer content={'| Colonna | Valore |\n| --- | --- |\n| Alfa | 1 |'} />);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Colonna' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Alfa' })).toBeInTheDocument();
  });

  test('renders pdf placeholders as figures using lesson asset metadata', () => {
    render(
      <MarkdownRenderer
        content={'Intro\n\n{{PDF_IMAGE:asset-1|alt=Alt fallback|caption=Caption fallback}}\n\nFine'}
        lessonAssetsById={{
          'asset-1': {
            id: 'asset-1',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,ZmFrZQ==',
            sourceOrder: 0,
            textAfter: 'dopo',
            textBefore: 'prima',
          },
        }}
        lessonImageRefsById={{
          'asset-1': {
            assetId: 'asset-1',
            alt: 'Immagine ricca',
            caption: 'Descrizione immagine',
          },
        }}
      />
    );

    expect(screen.getByRole('img', { name: 'Immagine ricca' })).toHaveAttribute(
      'src',
      'data:image/png;base64,ZmFrZQ=='
    );
    expect(screen.getByText('Descrizione immagine')).toBeInTheDocument();
  });

  test('passes the project identity when resolving a durable PDF placeholder', async () => {
    const durableAsset: ProjectDocumentImageAsset = {
      asset: {
        byteSize: 4,
        hash: 'b'.repeat(64),
        id: 'a'.repeat(64),
        mediaType: 'image/png',
      },
      id: 'pdf-image-logical-1',
      sourceOrder: 1,
      textAfter: 'dopo',
      textBefore: 'prima',
    };
    vi.mocked(resolveProjectDocumentImage).mockResolvedValue({
      release: vi.fn(),
      src: 'blob:durable-pdf-image',
    });

    render(
      <MarkdownRenderer
        content="{{PDF_IMAGE:pdf-image-logical-1|alt=Schema durevole}}"
        lessonAssetsById={{ 'pdf-image-logical-1': durableAsset }}
        projectId="project-1"
      />
    );

    expect(await screen.findByRole('img', { name: 'Schema durevole' })).toHaveAttribute(
      'src',
      'blob:durable-pdf-image'
    );
    expect(resolveProjectDocumentImage).toHaveBeenCalledWith(
      expect.objectContaining({ image: durableAsset, projectId: 'project-1' })
    );
  });

  test('preserves custom annotation attributes on rendered mark elements', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'Testo con <mark data-nous-annotation-id="annotation-1">focus</mark>.'}
      />
    );

    expect(
      container.querySelector('mark[data-nous-annotation-id="annotation-1"]')
    ).toHaveTextContent('focus');
  });

  test('adds a dashed underline only to annotated passages that have a saved note', () => {
    const { container } = render(
      <MarkdownRenderer
        content={
          'Testo con <mark data-nous-annotation-id="annotation-1">focus</mark> e <mark data-nous-annotation-id="annotation-2">contesto</mark>.'
        }
        sectionAnnotations={[
          {
            id: 'annotation-1',
            note: 'Nota utile',
            createdAt: '2026-04-02T00:00:00.000Z',
            updatedAt: '2026-04-02T00:00:00.000Z',
          },
          {
            id: 'annotation-2',
            note: '',
            createdAt: '2026-04-02T00:00:00.000Z',
            updatedAt: '2026-04-02T00:00:00.000Z',
          },
        ]}
      />
    );

    const noteMark = container.querySelector('mark[data-nous-annotation-id="annotation-1"]');
    const plainMark = container.querySelector('mark[data-nous-annotation-id="annotation-2"]');

    expect(noteMark).toHaveAttribute('data-nous-note-attached', 'true');
    expect(noteMark).toHaveStyle({
      textDecorationLine: 'underline',
      textDecorationStyle: 'dashed',
    });
    expect(plainMark).not.toHaveAttribute('data-nous-note-attached');
    expect(plainMark).not.toHaveStyle({
      textDecorationLine: 'underline',
    });
  });

  test('uses a lighter highlight tone in dark mode for better contrast', () => {
    const { container } = render(
      <MarkdownRenderer content={'Testo con <mark>focus</mark>.'} isDarkMode />
    );

    expect(container.querySelector('article')).toHaveClass('dark:[&_mark]:bg-amber-700/50');
    expect(container.querySelector('mark')).toHaveClass('dark:bg-amber-700/50');
    expect(container.querySelector('mark')).toHaveClass('dark:text-amber-50');
  });
});
