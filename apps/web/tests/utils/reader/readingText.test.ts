// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import {
  buildReadableBlocks,
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
});

describe('prepareMarkdownForSpeech', () => {
  test('drops media placeholders, code, math, and ignored html while preserving readable prose', () => {
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
      ['Titolo', '', 'Intro con link utile e .', '', 'Punto finale con focus.'].join('\n')
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

  test('collapses noisy inline whitespace while preserving paragraph breaks', () => {
    const input = ['#  Titolo\tstrano', '', '', '', 'Testo\t con   spazi.'].join('\r\n');

    expect(prepareMarkdownForSpeech(input)).toBe(
      ['Titolo strano', '', 'Testo con spazi.'].join('\n')
    );
  });
});
