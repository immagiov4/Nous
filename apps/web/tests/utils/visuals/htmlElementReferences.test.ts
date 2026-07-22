import { describe, expect, test } from 'vitest';
import {
  findMissingDirectlyDereferencedHtmlElementIds,
  findMissingStaticHtmlElementIds,
  hasInvalidInlineJavaScript,
  hasUnsafeHtmlElementDereferences,
} from '../../../utils/visuals/htmlElementReferences.ts';

describe('findMissingStaticHtmlElementIds', () => {
  test('returns referenced IDs that are absent from the generated markup', () => {
    const html = `
      <div id="present-output"></div>
      <script>
        document.getElementById('present-output').textContent = 'ok';
        document.getElementById('missing-output').textContent = 'errore';
      </script>
    `;

    expect(findMissingStaticHtmlElementIds(html)).toEqual(['missing-output']);
  });

  test('accepts elements declared after the script and returns stable unique IDs', () => {
    const html = `
      <script>
        document.getElementById("late-node").textContent = "ok";
        document.getElementById("missing-node").textContent = "uno";
        document.getElementById("missing-node").textContent = "due";
      </script>
      <div id="late-node"></div>
    `;

    expect(findMissingStaticHtmlElementIds(html)).toEqual(['missing-node']);
  });

  test('orders missing IDs by deterministic UTF-16 code units', () => {
    const html = `
      <script>
        document.getElementById('a-output').textContent = 'uno';
        document.getElementById('Z-output').textContent = 'due';
      </script>
    `;

    expect(findMissingStaticHtmlElementIds(html)).toEqual(['Z-output', 'a-output']);
  });

  test('does not mistake HTML strings inside scripts for mounted elements', () => {
    const html = `
      <script>
        const markup = '<div id="not-mounted"></div>';
        document.getElementById('not-mounted').textContent = markup;
      </script>
    `;

    expect(findMissingStaticHtmlElementIds(html)).toEqual(['not-mounted']);
  });

  test('detects direct DOM dereferences even when the ID is computed dynamically', () => {
    const unsafeHtml = `
      <script>
        ['output-a', 'output-b'].forEach(id => {
          document.getElementById(id).textContent = 'errore';
        });
      </script>
    `;
    const guardedHtml = `
      <script>
        const output = document.getElementById('output-a');
        if (output) output.textContent = 'ok';
      </script>
      <div id="output-a"></div>
    `;

    expect(hasUnsafeHtmlElementDereferences(unsafeHtml)).toBe(true);
    expect(hasUnsafeHtmlElementDereferences(guardedHtml)).toBe(false);
    expect(
      hasUnsafeHtmlElementDereferences(`
        <div id="output-a"></div>
        <script>document.getElementById('output-a').textContent = 'ok';</script>
      `)
    ).toBe(false);
  });
});

describe('findMissingDirectlyDereferencedHtmlElementIds', () => {
  test('blocks only missing IDs that are dereferenced without a null guard', () => {
    const html = `
      <script>
        const optionalOutput = document.getElementById('optional-output');
        if (optionalOutput) optionalOutput.textContent = 'ok';
        document.getElementById('required-output').textContent = 'errore';
      </script>
    `;

    expect(findMissingDirectlyDereferencedHtmlElementIds(html)).toEqual(['required-output']);
  });

  test('accepts a directly dereferenced element declared later in the document', () => {
    const html = `
      <script>document.getElementById('result').textContent = 'ok';</script>
      <output id="result"></output>
    `;

    expect(findMissingDirectlyDereferencedHtmlElementIds(html)).toEqual([]);
  });
});

describe('hasInvalidInlineJavaScript', () => {
  test('rejects malformed executable scripts without running them', () => {
    const html = '<div></div><script>const values = [1, 2, );</script>';

    expect(hasInvalidInlineJavaScript(html)).toBe(true);
  });

  test('accepts valid classic and module scripts while ignoring data blocks', () => {
    const html = `
      <script>const draw = () => [1, 2, 3].map(value => value * 2);</script>
      <script type="module">export const ready = true;</script>
      <script type="application/json">{"invalid as JavaScript": true}</script>
    `;

    expect(hasInvalidInlineJavaScript(html)).toBe(false);
  });
});
