import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseMarkdownAnalysis,
  planMarkdownFencedCode,
} from '../../../utils/markdown/codeRanges.ts';
import { normalizeMarkdownForRendering } from '../../../utils/markdown/render.ts';

const escapeFenceRun = (fence: string): string =>
  [...fence].map(character => `\\${character}`).join('');

test('normalizeMarkdownForRendering removes Delete control characters from inline LaTeX', () => {
  assert.equal(
    normalizeMarkdownForRendering(
      'La lettera $\u007f\\mathbf{p}_{\\text{locale}}$ indica un punto.'
    ),
    'La lettera $\\mathbf{p}_{\\text{locale}}$ indica un punto.'
  );
});

test('normalizeMarkdownForRendering removes ANSI styling from inline LaTeX', () => {
  assert.equal(
    normalizeMarkdownForRendering(
      'La lettera $\u001b[1m\\mathbf{p}_{\\text{locale}}\u001b[0m$ indica un punto.'
    ),
    'La lettera $\\mathbf{p}_{\\text{locale}}$ indica un punto.'
  );
});

test.each([
  ['ordinary prose ending in a comma', 'Una unità nascosta può calcolare, per esempio,'],
  ['an existing fenced code block', '```cpp\n#include <iostream>\n```'],
  ['language-prefixed bare code', 'cpp while (i < 5) { std::cout << i; }'],
  ['the reported bare Lua line', 'local tempo = 0'],
  [
    'bare parenthetical prose',
    'The result (see section A) and the note (this is important) stay as prose.',
  ],
])('normalizeMarkdownForRendering keeps %s unchanged', (_case, input) => {
  assert.equal(normalizeMarkdownForRendering(input), input);
});

test('normalizeMarkdownForRendering escapes disallowed raw html while preserving mark tags', () => {
  const input = 'Header <iostream> e <mark>focus</mark>.';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(output, 'Header &lt;iostream&gt; e <mark>focus</mark>.');
});

test('normalizeMarkdownForRendering preserves every line in valid fenced code blocks', () => {
  const input =
    "```cpp\nServerEnvironment::ServerEnvironment(std::unique_ptr<ServerMap> map,\n\nServer *server, MetricsBackend *mb):\nEnvironment(server),\n\nm_map(std::move(map)),\n\nm_script(server->getScriptIface()),\n\nm_server(server)\n\nQui l'ownership della mappa e chiarissima: il `ServerEnvironment` la riceve.\n```";

  assert.equal(normalizeMarkdownForRendering(input), input);
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

test('normalizeMarkdownForRendering preserves angle brackets inside inline backtick code spans', () => {
  const input = 'Il parametro `std::unique_ptr<ServerMap> map` comunica ownership esclusiva.';

  const output = normalizeMarkdownForRendering(input);

  assert.equal(output, input, '<ServerMap> inside backtick code must not be escaped');
});

test('normalizeMarkdownForRendering does not reconstruct a prematurely closed fence', () => {
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

  assert.equal(output, input);
});

test('normalizeMarkdownForRendering preserves model-split fenced blocks without merging them', () => {
  const input = [
    'Il ciclo:',
    '',
    '```text',
    'FOR (i = valoreIniziale; condizioneDiContinuazione; aggiornamento) {',
    '```',
    '',
    'blocco di istruzioni',
    '',
    '```text',
    '}',
    '```',
  ].join('\n');

  assert.equal(normalizeMarkdownForRendering(input), input);
});

test('normalizeMarkdownForRendering converts bare-paren inline math containing LaTeX commands into dollar-delimited math', () => {
  const input =
    'Una matrice (A) applicata a (x) produce (y = Ax). Se (A \\in \\mathbb{R}^{m\\times n}) e (x \\in \\mathbb{R}^n), il risultato (Ax) appartiene a (\\mathbb{R}^m).';

  assert.equal(
    normalizeMarkdownForRendering(input),
    'Una matrice (A) applicata a (x) produce (y = Ax). Se $A \\in \\mathbb{R}^{m\\times n}$ e $x \\in \\mathbb{R}^n$, il risultato (Ax) appartiene a $\\mathbb{R}^m$.'
  );
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

  assert.equal(normalizeMarkdownForRendering(input), 'La formula:\n\n$$\ny = Ax\n$$\n\nFine.');
});

test('normalizeMarkdownForRendering repairs JSON-double-escaped commands inside display math', () => {
  const input = String.raw`$$
y = \\phi_0 + \\phi_1x
$$`;

  assert.equal(
    normalizeMarkdownForRendering(input),
    String.raw`$$
y = \phi_0 + \phi_1x
$$`
  );
});

test('normalizeMarkdownForRendering renders an isolated LaTeX environment command as code', () => {
  const input = String.raw`Il simbolo $\begin{aligned}$ serve soltanto ad allineare le righe.`;

  assert.equal(
    normalizeMarkdownForRendering(input),
    'Il simbolo `\\begin{aligned}` serve soltanto ad allineare le righe.'
  );
});

test('normalizeMarkdownForRendering wraps a bare double-escaped LaTeX environment', () => {
  const input = String.raw`Prima.

\\operatorname{ReLU}(z) = \\begin{cases} 0 & \\text{se } z < 0 \\ z & \\text{se } z \\ge 0 \\end{cases}

Dopo.`;

  assert.equal(
    normalizeMarkdownForRendering(input),
    String.raw`Prima.

$$
\operatorname{ReLU}(z) = \begin{cases} 0 & \text{se } z < 0 \\ z & \text{se } z \ge 0 \end{cases}
$$

Dopo.`
  );
});

test('normalizeMarkdownForRendering wraps a bare assignment containing a LaTeX environment', () => {
  const input = String.raw`y = \\begin{cases} 0 & \\text{se } x < 0 \\ x & \\text{se } x \\ge 0 \\end{cases}`;

  assert.equal(
    normalizeMarkdownForRendering(input),
    String.raw`$$
y = \begin{cases} 0 & \text{se } x < 0 \\ x & \text{se } x \ge 0 \end{cases}
$$`
  );
});

test('normalizeMarkdownForRendering does not treat a nested language fence as a closing fence', () => {
  const input = [
    '```js',
    'const first = true;',
    '```javascript',
    'const nested = true;',
    '```',
    '',
    '## Dopo il codice',
  ].join('\n');

  assert.equal(normalizeMarkdownForRendering(input), input);
});

test('normalizeMarkdownForRendering escapes an unclosed fence so following prose remains markdown', () => {
  const output = normalizeMarkdownForRendering(
    ['Prima', '```ts', 'const answer = 42;', '## Dopo il codice', 'Testo leggibile.'].join('\n')
  );

  assert.ok(output.includes(`${escapeFenceRun('```')}ts`));
  assert.match(output, /## Dopo il codice/);
  assert.match(output, /Testo leggibile\./);
});

test('normalizeMarkdownForRendering does not promote an indented pseudo-closer', () => {
  const input = ['~~~ts', 'const answer = 42;', '    ~~~', '## Still code-like input'].join('\n');

  assert.equal(normalizeMarkdownForRendering(input), input.replace('~~~', escapeFenceRun('~~~')));
});

test('normalizeMarkdownForRendering preserves container-relative indented code', () => {
  const input = ['> ~~~outer', '>', '>     ```lang', '>     content'].join('\n');

  assert.equal(
    normalizeMarkdownForRendering(input),
    [`> ${escapeFenceRun('~~~')}outer`, '>', '>     ```lang', '>     content'].join('\n')
  );
});

test('normalizeMarkdownForRendering escapes consecutive unclosed list fences independently', () => {
  const input = ['- ```ts', '  first', '- ```js', '  second'].join('\n');

  assert.equal(
    normalizeMarkdownForRendering(input),
    [`- ${escapeFenceRun('```')}ts`, '  first', `- ${escapeFenceRun('```')}js`, '  second'].join(
      '\n'
    )
  );
});

test('normalizeMarkdownForRendering neutralizes unclosed openers in indented list continuations', () => {
  const inputs = [
    ['-   ```ts', '    ```js', '    text'],
    ['> -   ```ts', '>     ```js', '>     text'],
  ];

  inputs.forEach(lines => {
    const output = normalizeMarkdownForRendering(lines.join('\n'));
    assert.equal(output.split('\n').filter(line => line.includes(escapeFenceRun('```'))).length, 2);
    assert.deepEqual(planMarkdownFencedCode(output).unclosedRanges, []);
  });
});

test.each([
  {
    expected: [
      '&lt;div&gt;',
      '```html',
      '<span>literal</span>',
      '```',
      '&lt;/div&gt;',
      'After',
    ].join('\n'),
    input: ['<div>', '```html', '<span>literal</span>', '```', '</div>', 'After'].join('\n'),
    name: 'valid fenced HTML',
  },
  {
    input: ['- item', '    ```ts', '    code', '- sibling'].join('\n'),
    expected: ['- item', `    ${escapeFenceRun('```')}ts`, '    code', '- sibling'].join('\n'),
    name: 'unordered list',
  },
  {
    input: ['> - item', '>     ```ts', '>     code', '> - sibling'].join('\n'),
    expected: ['> - item', `>     ${escapeFenceRun('```')}ts`, '>     code', '> - sibling'].join(
      '\n'
    ),
    name: 'blockquote list',
  },
])('normalizeMarkdownForRendering retains $name context for unclosed fences', ({
  input,
  expected,
}) => {
  const output = normalizeMarkdownForRendering(input);

  assert.equal(output, expected);
  assert.deepEqual(planMarkdownFencedCode(output).unclosedRanges, []);
});

test('normalizeMarkdownForRendering still processes a sibling after an unclosed list fence', () => {
  const input = ['- ```ts', '  first', '- Header <iostream>'].join('\n');

  assert.equal(
    normalizeMarkdownForRendering(input),
    [`- ${escapeFenceRun('```')}ts`, '  first', '- Header &lt;iostream&gt;'].join('\n')
  );
});

test('normalizeMarkdownForRendering escapes disallowed HTML inside an unclosed fence', () => {
  const input = ['```ts', '<iframe src="https://example.com"></iframe>'].join('\n');

  assert.equal(
    normalizeMarkdownForRendering(input),
    [`${escapeFenceRun('```')}ts`, '&lt;iframe src="https://example.com"&gt;&lt;/iframe&gt;'].join(
      '\n'
    )
  );
});

test.each([
  {
    expected: [
      '&lt;div&gt;',
      `${escapeFenceRun('```')}ts`,
      'code',
      '&lt;/div&gt;',
      '## After',
    ].join('\n'),
    input: ['<div>', '```ts', 'code', '</div>', '## After'].join('\n'),
    name: 'escaped raw HTML',
  },
  {
    expected: [`${escapeFenceRun('```')}ts`, 'code', '## After'].join('\n'),
    input: ['    ```ts', '    code', '    ## After'].join('\n'),
    name: 'normalized indentation',
  },
])('normalizeMarkdownForRendering neutralizes fences exposed by $name', ({ expected, input }) => {
  const output = normalizeMarkdownForRendering(input);

  assert.equal(output, expected);
  assert.deepEqual(planMarkdownFencedCode(output).unclosedRanges, []);
});

test('normalizeMarkdownForRendering preserves HTML-like text in code after an unclosed opener', () => {
  const input = [
    '```ts',
    'Use `<div>` inline.',
    '~~~html',
    '<div>fenced</div>',
    '~~~',
    'After.',
  ].join('\n');

  assert.equal(normalizeMarkdownForRendering(input), input.replace('```', escapeFenceRun('```')));
});

test.each([
  {
    expected: [
      `${escapeFenceRun('~~~')}outer`,
      '&lt;div&gt;',
      `${escapeFenceRun('```')}ts`,
      'code',
      '&lt;/div&gt;',
    ].join('\n'),
    input: ['~~~outer', '<div>', '```ts', 'code', '</div>'].join('\n'),
    name: 'nested unclosed fence',
  },
  {
    expected: [`${escapeFenceRun('~~~')}outer`, '&lt;div&gt;', '`<span>`', '&lt;/div&gt;'].join(
      '\n'
    ),
    input: ['~~~outer', '<div>', '`<span>`', '</div>'].join('\n'),
    name: 'inline code',
  },
  {
    expected: [
      `${escapeFenceRun('~~~')}outer`,
      '&lt;div&gt;',
      '```html',
      '<span>literal</span>',
      '```',
      '&lt;/div&gt;',
    ].join('\n'),
    input: ['~~~outer', '<div>', '```html', '<span>literal</span>', '```', '</div>'].join('\n'),
    name: 'nested valid fenced HTML',
  },
])('normalizeMarkdownForRendering preserves $name exposed by escaped HTML', ({
  expected,
  input,
}) => {
  const output = normalizeMarkdownForRendering(input);

  assert.equal(output, expected);
  assert.deepEqual(planMarkdownFencedCode(output).unclosedRanges, []);
});

test('normalizeMarkdownForRendering escapes nested unclosed fence openers to a fixed point', () => {
  const input = ['```ts', 'const first = true;', '```js', 'const second = true;', '## After'].join(
    '\n'
  );

  assert.equal(
    normalizeMarkdownForRendering(input),
    [
      `${escapeFenceRun('```')}ts`,
      'const first = true;',
      `${escapeFenceRun('```')}js`,
      'const second = true;',
      '## After',
    ].join('\n')
  );
});

test('normalizeMarkdownForRendering leaves no inline-code delimiter in an escaped opener', () => {
  const input = ['```js', 'alpha', '``'].join('\n');
  const output = normalizeMarkdownForRendering(input);

  assert.equal(output, [`${escapeFenceRun('```')}js`, 'alpha', '``'].join('\n'));
  assert.deepEqual(parseMarkdownAnalysis(output).codeRanges, []);
});

test('normalizeMarkdownForRendering preserves a valid fence exposed by nested malformed openers', () => {
  const input = ['`````', 'outer', '~~~~', 'middle', '```', 'inner', '```'].join('\n');

  assert.equal(
    normalizeMarkdownForRendering(input),
    [
      escapeFenceRun('`````'),
      'outer',
      escapeFenceRun('~~~~'),
      'middle',
      '```',
      'inner',
      '```',
    ].join('\n')
  );
});

test('normalizeMarkdownForRendering neutralizes many malformed openers in one pass', () => {
  const openerCount = 64;
  const input = Array.from({ length: openerCount }, (_, index) => `\`\`\`lang${index}`).join('\n');
  const output = normalizeMarkdownForRendering(input);

  assert.equal(
    output.split('\n').filter(line => line.startsWith(`${escapeFenceRun('```')}lang`)).length,
    openerCount
  );
});

test('normalizeMarkdownForRendering batches decreasing marker-only openers', () => {
  const lines = Array.from({ length: 64 }, (_, index) => '`'.repeat(67 - index));
  const output = normalizeMarkdownForRendering(lines.join('\n'));

  assert.equal(output, lines.map(escapeFenceRun).join('\n'));
  assert.deepEqual(planMarkdownFencedCode(output).unclosedRanges, []);
});

test('normalizeMarkdownForRendering does not turn indented plain-text fragments into code blocks', () => {
  const input = [
    '1. **Definizione del modello:** Si stabilisce una funzione parametrica',
    '',
    '    y = f(x, φ)',
    '',
    '    f',
    '',
    '    Figura 3.3',
    '',
    '\tchunk-022',
    '',
    '    /',
    '',
    '    mono',
  ].join('\n');

  const output = normalizeMarkdownForRendering(input);

  assert.doesNotMatch(output, /```/);
  assert.match(output, /y = f\(x, φ\)/);
  assert.match(output, /\nf\n/);
  assert.match(output, /\nFigura 3\.3\n/);
  assert.match(output, /\nchunk-022\n/);
  assert.match(output, /\n\/\n/);
  assert.match(output, /\nmono$/);
});

test('normalizeMarkdownForRendering leaves malformed JSON fences unrepaired', () => {
  const input = [
    'Il server usa l’identificatore per trovare una voce nello store, ad esempio:',
    '',
    '{',
    '  "userId": "42",',
    '  "role": "editor",',
    '  "createdAt": "2026-07-11T10:00:00.000Z"',
    '}',
    '```',
    '',
    'Il vantaggio difensivo è chiaro.',
  ].join('\n');

  assert.equal(normalizeMarkdownForRendering(input), input.replace('```', escapeFenceRun('```')));
});

test('normalizeMarkdownForRendering does not insert a JSON fence before later fence syntax', () => {
  const input = [
    'Il record della sessione è:',
    '',
    '{',
    '  "userId": "42",',
    '  "role": "editor"',
    '}',
    '```',
    '',
    'Il server legge la sessione prima di eseguire:',
    '',
    '```js',
    'const session = await store.get(sessionId);',
    '```',
  ].join('\n');

  assert.equal(normalizeMarkdownForRendering(input), input);
});

test('normalizeMarkdownForRendering escapes an unmatched fence after single-line JSON', () => {
  const input = [
    'Il cookie non deve contenere dati autorevoli:',
    '',
    '{ "userId": 42, "role": "admin" }',
    '```',
    '',
    'Il server conserva invece lo stato.',
  ].join('\n');

  assert.equal(normalizeMarkdownForRendering(input), input.replace('```', escapeFenceRun('```')));
});

test('normalizeMarkdownForRendering does not restore a JSON fence around invalid JSON', () => {
  const input = ['Testo prima.', '', '{ "userId": }', '```', '', 'Testo dopo.'].join('\n');
  const output = normalizeMarkdownForRendering(input);

  assert.doesNotMatch(output, /```json/u);
  assert.match(output, /\{ "userId": \}/u);
  assert.match(output, /Testo dopo\./u);
});
