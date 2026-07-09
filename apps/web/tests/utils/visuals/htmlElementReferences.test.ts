import { describe, expect, test } from 'vitest';
import {
  findMissingStaticHtmlElementIds,
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
  });
});
