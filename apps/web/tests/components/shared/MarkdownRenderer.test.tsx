// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import MarkdownRenderer from '../../../components/shared/MarkdownRenderer.tsx';

describe('MarkdownRenderer', () => {
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

  test('adds a stronger dashed border only to annotated passages that have a saved note', () => {
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
      borderWidth: '1.5px',
      borderStyle: 'dashed',
    });
    expect(plainMark).not.toHaveAttribute('data-nous-note-attached');
    expect(plainMark).not.toHaveStyle({
      borderStyle: 'dashed',
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
