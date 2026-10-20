// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { buildReadableTextElements } from '../../../utils/reader/readingText.ts';

describe('buildReadableTextElements', () => {
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

    const blocks = buildReadableTextElements(container);

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

    const blocks = buildReadableTextElements(container);

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
