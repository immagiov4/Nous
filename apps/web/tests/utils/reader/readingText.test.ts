// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import {
  buildReadableBlocks,
  buildReadableTextElements,
  prepareMarkdownForSpeech,
} from '../../../utils/reader/readingText.ts';

describe('buildReadableBlocks', () => {
  test('ignores image figures while preserving surrounding lesson text order', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <article class="prose">
        <p>Prima parte leggibile.</p>
        <figure data-nous-speech="ignore">
          <img src="data:image/png;base64,AAA" alt="Alt da saltare" />
          <figcaption>Caption da saltare.</figcaption>
        </figure>
        <p>Seconda parte leggibile.</p>
      </article>
    `;

    const blocks = buildReadableBlocks(container);

    expect(blocks.map(block => block.text)).toEqual([
      'Prima parte leggibile.',
      'Seconda parte leggibile.',
    ]);
  });

  test('continues reading after media split the lesson into multiple prose renderers', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <article class="prose">
        <p>Prima del media.</p>
      </article>
      <figure data-nous-speech="ignore">
        <img src="data:image/png;base64,AAA" alt="Alt da saltare" />
      </figure>
      <article class="prose">
        <p>Dopo il media.</p>
      </article>
    `;

    const blocks = buildReadableBlocks(container);

    expect(blocks.map(block => block.text)).toEqual(['Prima del media.', 'Dopo il media.']);
  });

  test('reads inline code while ignoring code blocks and interactive quizzes', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <article class="prose">
        <p>Usa il comando <code>fetch</code> per continuare.</p>
        <pre><code>fetch('/api').then(run);</code></pre>
        <section data-nous-speech="ignore"><p>Quiz da non leggere.</p></section>
      </article>
    `;

    expect(buildReadableTextElements(container).map(item => item.text)).toEqual([
      'Usa il comando fetch per continuare.',
    ]);
  });

  test('falls back to textContent when a browser returns empty innerText for a detached clone', () => {
    const originalInnerTextDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'innerText'
    );
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get: () => '',
    });

    try {
      const container = document.createElement('div');
      container.innerHTML = '<article class="prose"><p>Testo selezionabile.</p></article>';

      expect(buildReadableTextElements(container).map(item => item.text)).toEqual([
        'Testo selezionabile.',
      ]);
    } finally {
      if (originalInnerTextDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'innerText', originalInnerTextDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'innerText');
      }
    }
  });
});

describe('prepareMarkdownForSpeech', () => {
  test('drops media placeholders, code blocks, math, and ignored html while preserving inline code', () => {
    const input = [
      '# Titolo',
      '',
      'Intro con [link utile](https://example.com) e `codice inline`.',
      '',
      '{{PDF_IMAGE:asset-1|alt=Figura}}',
      '{{VISUAL_EXAMPLE:visual-1|title=Schema}}',
      '',
      '<figure><img src="cover.png" /><figcaption>Da ignorare</figcaption></figure>',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '- Punto finale con <mark>focus</mark>.',
    ].join('\n');

    expect(prepareMarkdownForSpeech(input)).toBe(
      ['Titolo', '', 'Intro con link utile e codice inline.', '', 'Punto finale con focus.'].join(
        '\n'
      )
    );
  });

  test('removes markdown images and list markers without swallowing paragraph text', () => {
    const input = [
      '1. Primo punto con ![diagramma](diagram.png)',
      '',
      '> Citazione con [fonte](https://example.com/source)',
      '',
      'Testo finale.',
    ].join('\n');

    expect(prepareMarkdownForSpeech(input)).toBe(
      ['Primo punto con', '', 'Citazione con fonte', '', 'Testo finale.'].join('\n')
    );
  });

  test('reads inline code immediately adjacent to a markdown image', () => {
    expect(prepareMarkdownForSpeech('![diagramma](image.png)`codice inline`')).toBe(
      'codice inline'
    );
  });

  test('does not read reference definition destinations', () => {
    expect(
      prepareMarkdownForSpeech(
        'Testo introduttivo.\n\n[fonte]: https://example.com/percorso-nascosto'
      )
    ).toBe('Testo introduttivo.');
  });

  test('reads malformed definitions and removes complete multiline definitions', () => {
    expect(prepareMarkdownForSpeech('[ref]: destinazione non valida')).toBe(
      '[ref]: destinazione non valida'
    );
    expect(
      prepareMarkdownForSpeech('Prima.\n\n[ref]: /image.png\n  "Titolo nascosto"\n\nDopo.')
    ).toBe('Prima.\n\nDopo.');
  });

  test('collapses noisy inline whitespace while preserving paragraph breaks', () => {
    const input = ['#  Titolo\tstrano', '', '', '', 'Testo\t con   spazi.'].join('\r\n');

    expect(prepareMarkdownForSpeech(input)).toBe(
      ['Titolo strano', '', 'Testo con spazi.'].join('\n')
    );
  });
});
