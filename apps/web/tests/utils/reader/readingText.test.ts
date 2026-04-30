// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { buildReadableBlocks } from '../../../utils/reader/readingText.ts';

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
