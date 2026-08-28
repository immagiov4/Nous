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
  test('skips lone-CR fenced code while preserving surrounding prose', () => {
    const input = ['Prima.', '', '```ts', 'const secret = 42;', '```', '', 'Dopo.'].join('\r');

    expect(prepareMarkdownForSpeech(input)).toBe('Prima.\n\nDopo.');
  });

  test('reads bare code-like text that the renderer leaves as prose', () => {
    expect(
      prepareMarkdownForSpeech('Prima.\n\ncpp while (i < 5) { std::cout << i; }\n\nDopo.')
    ).toBe('Prima.\n\ncpp while (i < 5) { std::cout << i; }\n\nDopo.');
  });

  test('reads malformed JSON instead of treating it as repaired fenced code', () => {
    const input = ['Prima.', '', '{ "userId": 42, "role": "admin" }', '```', '', 'Dopo.'].join(
      '\n'
    );

    expect(prepareMarkdownForSpeech(input)).toBe(
      'Prima.\n\n{ "userId": 42, "role": "admin" }\n```\n\nDopo.'
    );
  });

  test('reads prose after escaped raw HTML reveals an unclosed fence', () => {
    const input = ['<div>', '```ts', 'code', '</div>', '## After [Docs](https://e.test)'].join(
      '\n'
    );

    expect(prepareMarkdownForSpeech(input)).toBe(
      ['<div>', '```ts', 'code', '</div>', 'After Docs'].join('\n')
    );
  });

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

  test('keeps a word boundary where an inline image is removed', () => {
    expect(prepareMarkdownForSpeech('prima![freccia](arrow.png)dopo')).toBe('prima dopo');
  });

  test('keeps a word boundary where an inline footnote reference is removed', () => {
    expect(prepareMarkdownForSpeech('prima[^nota]dopo\n\n[^nota]: nota')).toBe(
      'prima dopo\n\nnota'
    );
    expect(prepareMarkdownForSpeech('prima[^nota].\n\n[^nota]: nota')).toBe('prima.\n\nnota');
    expect(prepareMarkdownForSpeech('prima[^uno][^due]dopo\n\n[^uno]: uno\n[^due]: due')).toBe(
      'prima dopo\n\nuno\ndue'
    );
    expect(prepareMarkdownForSpeech('prima[^nota]*dopo*\n\n[^nota]: nota')).toBe(
      'prima dopo\n\nnota'
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

  test('reads Setext heading text without speaking its underline', () => {
    expect(prepareMarkdownForSpeech('Titolo\n===')).toBe('Titolo');
    expect(prepareMarkdownForSpeech('Prima riga\nseconda riga\n===')).toBe(
      'Prima riga\nseconda riga'
    );
    expect(prepareMarkdownForSpeech('    Titolo\n    ===')).toBe('Titolo');
    expect(prepareMarkdownForSpeech('\tTitolo\n\t===')).toBe('Titolo');
  });

  test('removes continued reference destinations and every unsupported viewer token', () => {
    const input = [
      'Prima.',
      '',
      '[ref]:',
      '  /image.png "Titolo nascosto"',
      '{{VISUAL_SLOT:slot-1|title=Schema nascosto}}',
      'Dopo.',
    ].join('\n');

    expect(prepareMarkdownForSpeech(input)).toBe('Prima.\n\nDopo.');
  });

  test('reads incomplete placeholder-like text that the reader displays', () => {
    const input = 'Testo prima {{VISUAL_SLOT:bozza testo dopo';

    expect(prepareMarkdownForSpeech(input)).toMatch(/bozza testo dopo/u);
  });

  test('does not read closed placeholders with whitespace payloads', () => {
    expect(prepareMarkdownForSpeech('Prima {{VISUAL_SLOT:   }} dopo')).toBe('Prima dopo');
  });

  test('does not read complete media placeholders containing protected Markdown', () => {
    expect(prepareMarkdownForSpeech('Prima {{PDF_IMAGE:id|alt=$x$}} dopo')).toBe('Prima dopo');
    expect(prepareMarkdownForSpeech('Prima {{PDF_IMAGE:id|caption=`formula`}} dopo')).toBe(
      'Prima dopo'
    );
    expect(prepareMarkdownForSpeech('Prima {{VISUAL_EXAMPLE:id|title=$x$}} dopo')).toBe(
      'Prima dopo'
    );
  });

  test('keeps later inline-code placeholders after a protected range crosses a media token', () => {
    const input = '{{PDF_IMAGE:id|alt=$x}} tail$ then `{{INLINE_QUIZ:1}}` after';

    expect(prepareMarkdownForSpeech(input)).toBe('tail$ then {{INLINE QUIZ:1}} after');
  });

  test('reads a malformed marker before removing a later complete marker', () => {
    const speech = prepareMarkdownForSpeech(
      'Prima {{VISUAL_SLOT:bozza poi {{VISUAL_SLOT:slot-1}} dopo'
    );

    expect(speech).toMatch(/bozza poi/u);
    expect(speech).not.toMatch(/slot-1/u);
  });

  test('reads a malformed PDF marker before removing a later complete marker', () => {
    const speech = prepareMarkdownForSpeech(
      'Prima {{PDF_IMAGE:bozza poi {{PDF_IMAGE:asset-1}} dopo'
    );

    expect(speech).toMatch(/bozza poi/u);
    expect(speech).not.toMatch(/asset-1/u);
  });

  test('reads placeholders with unknown options that the reader displays', () => {
    const speech = prepareMarkdownForSpeech('Prima {{PDF_IMAGE:asset-1|foo=bar}} dopo');

    expect(speech).toMatch(/foo=bar/u);
  });

  test('reads complete placeholders shown as inline code', () => {
    expect(prepareMarkdownForSpeech('Mostra `{{INLINE_QUIZ:0}}` come sintassi.')).toBe(
      'Mostra {{INLINE QUIZ:0}} come sintassi.'
    );
  });

  test('does not read inline-code placeholders consumed by media renderers', () => {
    expect(
      prepareMarkdownForSpeech(
        'Mostra `{{PDF_IMAGE:missing}}` e `{{VISUAL_SLOT:slot-1}}` come sintassi.'
      )
    ).toBe('Mostra e come sintassi.');
  });

  test('does not read full or collapsed reference labels', () => {
    const input = [
      '[Testo pieno][destinazione]',
      '[Testo collassato][]',
      '',
      '[destinazione]: /full',
      '[Testo collassato]: /collapsed',
    ].join('\n');

    const speech = prepareMarkdownForSpeech(input);
    expect(speech).not.toMatch(/destinazione|collapsed/u);
    expect(speech).toMatch(/Testo pieno|Testo collassato/u);
  });

  test('keeps prose after overlapping hidden definition ranges', () => {
    expect(prepareMarkdownForSpeech('- [ref]:\n    /image.png\n\nDopo.')).toBe('Dopo.');
  });

  test('does not read reference labels exposed by escaped raw html', () => {
    const speech = prepareMarkdownForSpeech('<div>\n[Testo][ref]\n</div>\n\n[ref]: /hidden');

    expect(speech).toMatch(/Testo/u);
    expect(speech).not.toMatch(/ref|hidden/u);
  });

  test('does not read footnote labels exposed by escaped raw html', () => {
    const speech = prepareMarkdownForSpeech('<div>\nTesto[^nota]\n</div>\n\n[^nota]: Corpo');

    expect(speech).toMatch(/Testo/u);
    expect(speech).toMatch(/Corpo/u);
    expect(speech).not.toMatch(/\[?\^nota/u);
  });

  test('follows rendered footnote, autolink, and list-definition visibility', () => {
    const speech = prepareMarkdownForSpeech(
      [
        'Testo[^nota] e <https://example.com>.',
        '',
        '[^nota]: Contenuto della nota.',
        '',
        '- [ref]:',
        '    /image.png',
        '',
        '  ![Immagine][ref]',
      ].join('\n')
    );

    expect(speech).toMatch(/Contenuto della nota/u);
    expect(speech).toMatch(/https:\/\/example\.com/u);
    expect(speech).not.toMatch(/image\.png|Immagine/u);
    expect(speech).not.toMatch(/\[\^nota\]/u);
  });

  test('reads visible content inside a multiline mark', () => {
    expect(prepareMarkdownForSpeech('<mark>\npassaggio visibile\n</mark>')).toBe(
      'passaggio visibile'
    );
  });

  test('does not read raw HTML syntax hidden by the renderer', () => {
    const speech = prepareMarkdownForSpeech(
      'Prima <!-- <script>istruzione interna</script> --> dopo.\n\n<!doctype html>'
    );

    expect(speech).toBe('Prima dopo.');
  });

  test('does not read hidden HTML syntax inside escaped raw HTML', () => {
    const speech = prepareMarkdownForSpeech('<script>\n\n<!-- internal -->\n\n</script>');

    expect(speech).toBe('<script>\n\n</script>');
  });

  test('preserves malformed email autolinks and skips list-indented fenced code', () => {
    const speech = prepareMarkdownForSpeech(
      ['<a@b>', '- Voce', '', '    ~~~md', '    segreto-nel-codice', '    ~~~'].join('\n')
    );

    expect(speech).toMatch(/<a@b>/u);
    expect(speech).not.toMatch(/segreto-nel-codice/u);
    expect(prepareMarkdownForSpeech('<https://example.com>')).toBe('<https://example.com>');
  });

  test('reads renderer-normalized prose and skips protected backslash math', () => {
    expect(prepareMarkdownForSpeech(String.raw`    Frase visibile con \(x + y\).`)).toBe(
      'Frase visibile con .'
    );
  });

  test('reads visible prose beside delimited inline math', () => {
    expect(prepareMarkdownForSpeech(String.raw`x = $\frac{a}{b}$`)).toBe('x =');
  });

  test('skips protected backslash math inside escaped raw html', () => {
    expect(prepareMarkdownForSpeech(String.raw`<span>\(visible\)</span>`)).toBe('<span> </span>');
  });

  test('reads inline code inside escaped raw html without treating its dollars as math', () => {
    expect(prepareMarkdownForSpeech('<div>`$x$`</div>')).toBe('<div>$x$</div>');
  });

  test('skips fenced code inside escaped raw html', () => {
    expect(prepareMarkdownForSpeech('<div>\n```\nsecret\n```\n</div>')).toBe('<div>\n\n</div>');
  });

  test('collapses noisy inline whitespace while preserving paragraph breaks', () => {
    const input = ['#  Titolo\tstrano', '', '', '', 'Testo\t con   spazi.'].join('\r\n');

    expect(prepareMarkdownForSpeech(input)).toBe(
      ['Titolo strano', '', 'Testo con spazi.'].join('\n')
    );
  });
});
