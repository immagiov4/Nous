import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMarkdownForRendering } from './renderMarkdown.ts';

test('normalizeMarkdownForRendering converts single-line cpp snippets into fenced code blocks', () => {
  const input = 'Sintassi:\n\ncpp while (i < 5) { std::cout << i; }';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(
    output,
    'Sintassi:\n\n```cpp\nwhile (i < 5) { std::cout << i; }\n```'
  );
});

test('normalizeMarkdownForRendering repairs language label plus multiline code into one fenced block', () => {
  const input =
    'Un esempio semplice chiarisce il valore della regola\n\ncpp\nif (condition) {\ndoSomething();\n} else { doSomethingElse();\n}';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(
    output,
    'Un esempio semplice chiarisce il valore della regola\n\n```cpp\nif (condition) {\ndoSomething();\n} else { doSomethingElse();\n}\n```'
  );
});

test('normalizeMarkdownForRendering keeps multiline code together when the first line starts with the language label', () => {
  const input = 'cpp if (condition) {\ndoSomething();\n}';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(output, '```cpp\nif (condition) {\ndoSomething();\n}\n```');
});

test('normalizeMarkdownForRendering wraps standalone C++ lines and preserves angle brackets as code', () => {
  const input = '#include <iostream>\nstd::vector<int> values;';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(
    output,
    '```cpp\n#include <iostream>\nstd::vector<int> values;\n```'
  );
});

test('normalizeMarkdownForRendering escapes disallowed raw html while preserving mark tags', () => {
  const input = 'Header <iostream> e <mark>focus</mark>.';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(output, 'Header &lt;iostream&gt; e <mark>focus</mark>.');
});

test('normalizeMarkdownForRendering leaves existing fenced code blocks untouched', () => {
  const input = '```cpp\n#include <iostream>\n```';

  assert.equal(normalizeMarkdownForRendering(input), input);
});

test('normalizeMarkdownForRendering strips accidental mark tags from inline code spans', () => {
  const input = 'Classi: `<mark>Server</mark>` e `<mark>Client</mark>`.';

  assert.equal(normalizeMarkdownForRendering(input), 'Classi: `Server` e `Client`.');
});

test('normalizeMarkdownForRendering strips accidental mark tags from fenced code blocks', () => {
  const input = '```cpp\n<mark>Server</mark> server;\n```';

  assert.equal(normalizeMarkdownForRendering(input), '```cpp\nServer server;\n```');
});

test('normalizeMarkdownForRendering repairs common katex text-mode underscore errors', () => {
  const input =
    '$\\text{protocol version} = \\min(\\text{min_supported_client}, \\text{min_supported_server})$';

  assert.equal(
    normalizeMarkdownForRendering(input),
    '$\\text{protocol version} = \\min(\\text{min\\_supported\\_client}, \\text{min\\_supported\\_server})$'
  );
});
