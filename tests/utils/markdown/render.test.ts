import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeMarkdownForRendering } from '../../../utils/markdown/render.ts';

test('normalizeMarkdownForRendering converts single-line cpp snippets into fenced code blocks', () => {
  const input = 'Sintassi:\n\ncpp while (i < 5) { std::cout << i; }';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(output, 'Sintassi:\n\n```cpp\nwhile (i < 5) { std::cout << i; }\n```');
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

  assert.equal(output, '```cpp\n#include <iostream>\nstd::vector<int> values;\n```');
});

test('normalizeMarkdownForRendering keeps multiline constructor snippets together across blank lines', () => {
  const input =
    'ServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\nServer *server, MetricsBackend *mb):\nEnvironment(server),\n\nm_map(std::move(map)),\n\nm_script(server->getScriptIface()),\n\nm_server(server)';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(
    output,
    '```cpp\nServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\nServer *server, MetricsBackend *mb):\nEnvironment(server),\n\nm_map(std::move(map)),\n\nm_script(server->getScriptIface()),\n\nm_server(server)\n```'
  );
});

test('normalizeMarkdownForRendering keeps language-labeled multiline code together across blank lines', () => {
  const input =
    'cpp\nServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\nServer *server, MetricsBackend *mb):\nEnvironment(server),\n\nm_map(std::move(map)),\n\nm_script(server->getScriptIface()),\n\nm_server(server)';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(
    output,
    '```cpp\nServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\nServer *server, MetricsBackend *mb):\nEnvironment(server),\n\nm_map(std::move(map)),\n\nm_script(server->getScriptIface()),\n\nm_server(server)\n```'
  );
});

test('normalizeMarkdownForRendering stops the code block before following prose', () => {
  const input =
    "ServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\nServer *server, MetricsBackend *mb):\nEnvironment(server),\n\nm_map(std::move(map)),\n\nm_script(server->getScriptIface()),\n\nm_server(server)\n\nQui l'ownership della mappa e chiarissima.";

  const output = normalizeMarkdownForRendering(input);

  assert.equal(
    output,
    "```cpp\nServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\nServer *server, MetricsBackend *mb):\nEnvironment(server),\n\nm_map(std::move(map)),\n\nm_script(server->getScriptIface()),\n\nm_server(server)\n```\n\nQui l'ownership della mappa e chiarissima."
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

test('normalizeMarkdownForRendering extracts trailing prose from existing fenced code blocks', () => {
  const input =
    "```cpp\nServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\nServer *server, MetricsBackend *mb):\nEnvironment(server),\n\nm_map(std::move(map)),\n\nm_script(server->getScriptIface()),\n\nm_server(server)\n\nQui l'ownership della mappa e chiarissima: il `ServerEnvironment` la riceve.\n```";

  assert.equal(
    normalizeMarkdownForRendering(input),
    "```cpp\nServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\nServer *server, MetricsBackend *mb):\nEnvironment(server),\n\nm_map(std::move(map)),\n\nm_script(server->getScriptIface()),\n\nm_server(server)\n```\n\nQui l'ownership della mappa e chiarissima: il `ServerEnvironment` la riceve."
  );
});

test('normalizeMarkdownForRendering strips accidental mark tags from inline code spans', () => {
  const input = 'Classi: `<mark>Server</mark>` e `<mark>Client</mark>`.';

  assert.equal(normalizeMarkdownForRendering(input), 'Classi: `Server` e `Client`.');
});

test('normalizeMarkdownForRendering strips accidental mark tags with annotation attributes from inline code spans', () => {
  const input = 'Classi: `<mark data-lumina-annotation-id="annotation-1">Server</mark>`.';

  assert.equal(normalizeMarkdownForRendering(input), 'Classi: `Server`.');
});

test('normalizeMarkdownForRendering strips accidental mark tags from fenced code blocks', () => {
  const input = '```cpp\n<mark>Server</mark> server;\n```';

  assert.equal(normalizeMarkdownForRendering(input), '```cpp\nServer server;\n```');
});

test('normalizeMarkdownForRendering strips accidental mark tags with annotation attributes from fenced code blocks', () => {
  const input = '```cpp\n<mark data-lumina-annotation-id="annotation-1">Server</mark> server;\n```';

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

test('normalizeMarkdownForRendering promotes bare word-like subscripts into text mode', () => {
  const input = 'Qui il beneficio nasce dal ridurre $T_cluster$ e $T_update$.';

  assert.equal(
    normalizeMarkdownForRendering(input),
    'Qui il beneficio nasce dal ridurre $T_{\\text{cluster}}$ e $T_{\\text{update}}$.'
  );
});

test('normalizeMarkdownForRendering promotes braced word-like superscripts and subscripts into text mode', () => {
  const input =
    '$C_{server}$ scala meglio e $T^{update}$ resta locale, mentre $x_i$ e $a_{ij}$ restano invariati.';

  assert.equal(
    normalizeMarkdownForRendering(input),
    '$C_{\\text{server}}$ scala meglio e $T^{\\text{update}}$ resta locale, mentre $x_i$ e $a_{ij}$ restano invariati.'
  );
});

test('normalizeMarkdownForRendering converts orphan bracket-delimited display math into KaTeX display blocks', () => {
  const input = [
    'La formula e:',
    '',
    '[',
    'f(\\omega) \\approx \\sum_i a_i Y_i(\\omega)',
    ']',
    '',
    'Fine.',
  ].join('\n');

  assert.equal(
    normalizeMarkdownForRendering(input),
    ['La formula e:', '', '$$', 'f(\\omega) \\approx \\sum_i a_i Y_i(\\omega)', '$$', 'Fine.'].join(
      '\n'
    )
  );
});

test('normalizeMarkdownForRendering converts single-line bracket-delimited display math into KaTeX display blocks', () => {
  const input = [
    'La formula e:',
    '',
    '[ AO(p) = \\frac{1}{2\\pi}\\int_{\\Omega^+} V_p(\\omega), d\\omega ]',
    '',
    'Fine.',
  ].join('\n');

  assert.equal(
    normalizeMarkdownForRendering(input),
    [
      'La formula e:',
      '',
      '$$',
      'AO(p) = \\frac{1}{2\\pi}\\int_{\\Omega^+} V_p(\\omega), d\\omega',
      '$$',
      'Fine.',
    ].join('\n')
  );
});

test('normalizeMarkdownForRendering does not swallow prose with backtick-wrapped C++ types into code blocks', () => {
  const input =
    "cpp\nServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\tServer *server, MetricsBackend *mb):\n\tEnvironment(server),\n\tm_server(server)\n\nQui l'ownership della mappa e chiarissima: il `ServerEnvironment` la riceve e la conserva in un `std::unique_ptr`.";

  assert.equal(
    normalizeMarkdownForRendering(input),
    "```cpp\nServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\tServer *server, MetricsBackend *mb):\n\tEnvironment(server),\n\tm_server(server)\n```\n\nQui l'ownership della mappa e chiarissima: il `ServerEnvironment` la riceve e la conserva in un `std::unique_ptr`."
  );
});

test('normalizeMarkdownForRendering keeps multi-line function call arguments together via paren tracking', () => {
  const input =
    'Client::Client(...):\n\tm_tsrc(tsrc),\n\tm_env(\n\t\tmake_irr<ClientMap>(this, engine, control, 666),\n\t\ttsrc, this\n\t),';

  const output = normalizeMarkdownForRendering(input);

  assert.ok(
    output.includes(
      '\tm_env(\n\t\tmake_irr<ClientMap>(this, engine, control, 666),\n\t\ttsrc, this\n\t),\n```'
    ),
    'tsrc, this and ), must remain inside the fenced block'
  );
});

test('normalizeMarkdownForRendering preserves angle brackets inside inline backtick code spans', () => {
  const input = 'Il parametro `std::unique_ptr<ServerMap> map` comunica ownership esclusiva.';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(output, input, '<ServerMap> inside backtick code must not be escaped');
});

test('normalizeMarkdownForRendering splits prose back out of an existing fenced code block', () => {
  const input = [
    '#### Un esempio concreto e il costruttore di `ServerEnvironment`',
    '',
    '```cpp',
    'ServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,',
    '\t\tServer *server, MetricsBackend *mb):',
    '\tEnvironment(server),',
    '\tm_map(std::move(map)),',
    '\tm_script(server->getScriptIface()),',
    '\tm_server(server)',
    '',
    "Qui l'ownership della mappa e chiarissima: il `ServerEnvironment` la riceve e la conserva in un `std::unique_ptr`.",
    '```',
  ].join('\n');

  const output = normalizeMarkdownForRendering(input);

  assert.ok(
    output.includes("\tm_server(server)\n```\n\nQui l'ownership della mappa e chiarissima"),
    'prose should be moved outside the fenced code block'
  );
});

test('normalizeMarkdownForRendering refences orphaned continuation lines after a premature closing fence', () => {
  const input = [
    '```cpp',
    '\tm_env(',
    '\t\tmake_irr<ClientMap>(this, rendering_engine, control, 666),',
    '```',
    '\t\ttsrc, this',
    '\t),',
    '',
    'Qui il costruttore racconta gia una storia.',
  ].join('\n');

  const output = normalizeMarkdownForRendering(input);

  assert.ok(
    output.includes(
      '```cpp\n\tm_env(\n\t\tmake_irr<ClientMap>(this, rendering_engine, control, 666),\n\t\ttsrc, this\n\t),\n```'
    ),
    'orphaned continuation lines should be merged back into the previous fenced code block'
  );
});

test('normalizeMarkdownForRendering converts bare-paren inline math containing LaTeX commands into dollar-delimited math', () => {
  const input =
    'Una matrice (A) applicata a (x) produce (y = Ax). Se (A \\in \\mathbb{R}^{m\\times n}) e (x \\in \\mathbb{R}^n), il risultato (Ax) appartiene a (\\mathbb{R}^m).';

  assert.equal(
    normalizeMarkdownForRendering(input),
    'Una matrice (A) applicata a (x) produce (y = Ax). Se $A \\in \\mathbb{R}^{m\\times n}$ e $x \\in \\mathbb{R}^n$, il risultato (Ax) appartiene a $\\mathbb{R}^m$.'
  );
});

test('normalizeMarkdownForRendering leaves bare-paren spans without LaTeX commands as plain text', () => {
  const input = 'The result (see section A) and the note (this is important) stay as prose.';

  assert.equal(normalizeMarkdownForRendering(input), input);
});

test('normalizeMarkdownForRendering does not double-convert content already inside dollar math spans', () => {
  const input = 'Already math $A \\in \\mathbb{R}^n$ and bare paren (B \\in \\mathbb{R}^m) here.';

  assert.equal(
    normalizeMarkdownForRendering(input),
    'Already math $A \\in \\mathbb{R}^n$ and bare paren $B \\in \\mathbb{R}^m$ here.'
  );
});

test('normalizeMarkdownForRendering converts backslash-paren inline math delimiters into dollar-delimited math', () => {
  const input =
    'Se \\(A\\) ha \\(m\\) righe e \\(n\\) colonne, scriviamo \\(A \\in \\mathbb{R}^{m\\times n}\\).';

  assert.equal(
    normalizeMarkdownForRendering(input),
    'Se $A$ ha $m$ righe e $n$ colonne, scriviamo $A \\in \\mathbb{R}^{m\\times n}$.'
  );
});

test('normalizeMarkdownForRendering converts backslash-bracket display math into dollar display math', () => {
  const input = 'La formula:\n\n\\[\ny = Ax\n\\]\n\nFine.';

  assert.equal(
    normalizeMarkdownForRendering(input),
    'La formula:\n\n$$\ny = Ax\n$$\n\nFine.'
  );
});
