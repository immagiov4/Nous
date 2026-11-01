import { ContextNoteCatalogSchema, serializeContextNoteView } from '@shared/contextNoteCatalog';
import { MAX_CONTEXT_CHAT_FIELD_CHARS } from '@shared/lessonSourceContext';
import { expect, test, vi } from 'vitest';
import {
  buildConversationNoteCatalog,
  resolveConversationNotePassage,
  restoreConversationNotePassage,
  validateConversationNotePassage,
} from '../../../utils/context/conversationNoteCatalog.ts';
import { createSectionAnnotationSelector } from '../../../utils/learning/sectionAnnotationAnchors.ts';
import { resolveSelectedSegments } from '../../../utils/learning/sectionAnnotationProjection.ts';

const build = (
  content: string,
  locale = 'en',
  selection?: { selectedText: string; selectedTextStart?: number }
) => buildConversationNoteCatalog({ content, locale, selection });

const assertRoundTrip = (catalog: ReturnType<typeof build>) => {
  for (const entry of catalog.entries) {
    expect(createSectionAnnotationSelector(catalog.content, entry.segments)).toEqual(
      entry.selector
    );
    const resolved = resolveSelectedSegments({ content: catalog.content, ...entry.anchor });
    expect(resolved).toEqual(entry.segments);
    expect(createSectionAnnotationSelector(catalog.content, resolved)?.exact).toBe(entry.text);
  }
};

test('addresses distinct sentences and repeated text by different snapshot-bound IDs', () => {
  const source = 'First sentence. Second sentence.\n\nFirst sentence.';
  const catalog = build(source);
  expect(catalog.entries.map(e => e.text)).toEqual([
    'First sentence.',
    'Second sentence.',
    'First sentence.',
  ]);
  expect(new Set(catalog.entries.map(e => e.id)).size).toBe(3);
  expect(build(source).entries[0].id).toBe(catalog.entries[0].id);
  assertRoundTrip(catalog);
});

test('keeps the entire pre-PR Markdown prefix in a lesson longer than 22000 characters', () => {
  const content =
    'La memoria conserva informazioni. La pratica rende più preciso il richiamo.\n\n'.repeat(300);
  expect(content.length).toBeGreaterThanOrEqual(22_000);
  const catalog = build(content, 'it');
  const view = serializeContextNoteView(catalog.records);
  expect(view.replace(/⟦p[0-9a-z]+⟧/gu, '')).toBe(content.slice(0, MAX_CONTEXT_CHAT_FIELD_CHARS));
});

test('rebuilding identical input resolves a previously issued ID and has the same snapshot identity', async () => {
  const source = 'Prima frase. Seconda frase.';
  const first = build(source, 'it', { selectedText: 'Seconda frase.', selectedTextStart: 13 });
  const rebuilt = build(source, 'it', { selectedText: 'Seconda frase.', selectedTextStart: 13 });
  expect(await rebuilt.snapshotId).toBe(await first.snapshotId);
  expect(
    resolveConversationNotePassage(rebuilt, { passageId: first.entries[0].id })?.selector
  ).toEqual(first.entries[0].selector);
});

test('keeps stable exact targets without secure-context crypto on private-network HTTP', async () => {
  const source = 'Prima frase. Seconda frase.';
  const secure = build(source, 'it');
  const secureId = await secure.snapshotId;
  vi.stubGlobal('crypto', {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  });
  try {
    const insecure = build(source, 'it');
    expect(await insecure.snapshotId).toBe(secureId);
    expect(
      resolveConversationNotePassage(insecure, { passageId: secure.entries[1].id })?.selector
    ).toEqual(secure.entries[1].selector);
    assertRoundTrip(insecure);
  } finally {
    vi.unstubAllGlobals();
  }
});

test.each([
  'it',
  'en',
])('Italian abbreviations and decimal punctuation retain exact targets under %s', locale => {
  const catalog = build('Es. 3,5 cm. è la misura. Poi misuriamo ancora.', locale);
  expect(catalog.entries.length).toBeGreaterThan(0);
  assertRoundTrip(catalog);
});

test('uses visible text for formatting, headings, list paragraphs and separate table cells', () => {
  const catalog = build(
    '# A heading. Still a heading\n\n**Bold** and [linked](https://example.test) text. Next.\n\n- First item. Next item sentence.\n- Second item.\n\n| Label | Value |\n|---|---|\n| Size. In cm. | 3,5 |'
  );
  expect(catalog.entries.map(e => e.text)).toEqual([
    'A heading. Still a heading',
    'Bold and linked text.',
    'Next.',
    'First item.',
    'Next item sentence.',
    'Second item.',
    'Label',
    'Value',
    'Size. In cm.',
    '3,5',
  ]);
  assertRoundTrip(catalog);
});

test('clips sentences to markable runs without joining across math, code or artifacts', () => {
  const catalog = build(
    'Before $x+y$ after.\n\n`code`\n\n```js\nsecret()\n```\n\n![plot](image.png)\n\nBefore `inline()` after.'
  );
  expect(catalog.entries.map(e => e.text)).toEqual(['Before', 'after.', 'Before', 'after.']);
  assertRoundTrip(catalog);
});

test('preserves a precise captured sub-selection and excludes missing and protected selections', () => {
  const content = 'A long sentence with a precise choice.\n\n`code`';
  const catalog = build(content, 'en', { selectedText: 'precise choice', selectedTextStart: 23 });
  expect(catalog.entries.find(e => e.kind === 'selection')?.text).toBe('precise choice');
  assertRoundTrip(catalog);
  expect(
    build(content, 'en', { selectedText: 'missing' }).entries.some(e => e.kind === 'selection')
  ).toBe(false);
  expect(
    build(content, 'en', { selectedText: 'code' }).entries.some(e => e.kind === 'selection')
  ).toBe(false);
});

test('maps CRLF, entities and renderer-normalized indentation back to raw source', () => {
  const catalog = build('    Frase visibile nel testo.\r\n\r\nA &amp; B.\r\n\r\n**C** and D.');
  expect(catalog.entries.map(e => e.text)).toEqual([
    'Frase visibile nel testo.',
    'A & B.',
    'C and D.',
  ]);
  assertRoundTrip(catalog);
});

test('clips only complete targets while preserving the pre-PR source prefix', async () => {
  const catalog = build(
    `Short sentence.\n\n\`\`\`js\n${'const value = 1;\n'.repeat(3000)}\n\`\`\`\n\nLater sentence.`
  );
  expect(catalog.entries.map(entry => entry.text)).toEqual(['Short sentence.']);
  expect(
    catalog.records
      .filter(r => r.kind === 'context')
      .map(r => r.text)
      .join('').length
  ).toBeLessThanOrEqual(MAX_CONTEXT_CHAT_FIELD_CHARS);
  expect(
    ContextNoteCatalogSchema.safeParse({
      records: catalog.records,
      snapshotId: await catalog.snapshotId,
    }).success
  ).toBe(true);
  expect(catalog.records.filter(r => r.kind !== 'context').map(r => r.id)).toEqual(
    catalog.entries.map(e => e.id)
  );
  assertRoundTrip(catalog);
});

test('retains math, code and table relationships as non-citable explanation context', () => {
  const source =
    'The sum is $x+y$.\n\n```js\nreturn x+y;\n```\n\n| Term | Value |\n|---|---|\n| x | 3 |';
  const catalog = build(source);
  const context = catalog.records
    .filter(r => r.kind === 'context')
    .map(r => r.text)
    .join('');
  expect(context).toContain('$x+y$');
  expect(context).toContain('return x+y;');
  expect(serializeContextNoteView(catalog.records)).toContain('```js\nreturn x+y;\n```');
  expect(catalog.entries.filter(e => e.kind === 'tableCell').map(e => e.text)).toEqual([
    'Term',
    'Value',
    'x',
    '3',
  ]);
  assertRoundTrip(catalog);
});

test('does not convert ambiguous historical quotes or preserve stale selection offsets', () => {
  const catalog = build('Repeated sentence. Repeated sentence.');
  expect(
    resolveConversationNotePassage(catalog, { selectedTextDraft: 'Repeated sentence.' })
  ).toBeUndefined();
  expect(
    build('First sentence. Second sentence.', 'en', {
      selectedText: 'Second sentence.',
      selectedTextStart: 0,
    }).entries.some(e => e.kind === 'selection')
  ).toBe(false);
});

test('keeps the captured focus addressable when the preceding lesson body fills its budget', () => {
  const content = `First sentence.\n\n\`\`\`js\n${'const x=1;\n'.repeat(3000)}\n\`\`\`\n\nFinal focus sentence.`;
  const catalog = build(content, 'en', { selectedText: 'Final focus sentence.' });
  expect(
    catalog.entries.some(e => e.kind === 'selection' && e.text === 'Final focus sentence.')
  ).toBe(true);
  expect(
    catalog.records
      .filter(r => r.kind === 'context')
      .map(r => r.text)
      .join('').length
  ).toBeLessThanOrEqual(MAX_CONTEXT_CHAT_FIELD_CHARS);
  assertRoundTrip(catalog);
});

test('historical update provenance includes captured annotation identity', async () => {
  const input = {
    content: 'First sentence.',
    locale: 'en',
    hasExistingNote: true,
    annotationId: 'captured',
  };
  const first = buildConversationNoteCatalog(input);
  expect(await buildConversationNoteCatalog(input).snapshotId).toBe(await first.snapshotId);
  expect(
    await buildConversationNoteCatalog({ ...input, annotationId: 'replacement' }).snapshotId
  ).not.toBe(await first.snapshotId);
});

test('restores a pre-identity-capture pending proposal when no annotation was attached', async () => {
  const catalog = buildConversationNoteCatalog({
    content:
      'Working memory holds a few active items. Grouping related items reduces the number of separate units.',
    locale: 'it',
    origin: { projectId: 'synthetic-course', lessonId: 'lesson' },
  });
  const result = await restoreConversationNotePassage(
    catalog,
    { passageId: 'p0' },
    {
      contextNoteSnapshotId: 'a0d7586a3a257bdc9dee125ecab63de07f28b6fa1460489e00f8da4028c5381d',
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.target?.text).toBe('Working memory holds a few active items.');
});

test.each([
  true,
  undefined,
])('only the captured annotation target updates, even for a subspan: %s', hasExistingNote => {
  const content = 'First sentence. Second sentence.';
  const annotationSelector = build(content).entries[0].selector;
  const catalog = buildConversationNoteCatalog({
    content,
    locale: 'en',
    annotationId: 'attached',
    annotationSelector,
    hasExistingNote,
    selection: { selectedText: 'First', selectedTextStart: 0 },
  });
  const selected = catalog.entries.find(entry => entry.id === 's');
  expect(selected).toMatchObject({
    text: 'First sentence.',
    selector: annotationSelector,
    annotationId: 'attached',
    hasExistingNote: true,
  });
  for (const entry of catalog.entries.filter(entry => entry.id !== 's')) {
    expect(entry.annotationId).toBeUndefined();
    expect(entry.hasExistingNote).toBe(false);
  }
  assertRoundTrip(catalog);
});

test('an invalid stored selector has no update identity and cannot relocate to its quotation', () => {
  const annotationSelector = build('First sentence. Second sentence.').entries[0].selector;
  const content = 'Changed first sentence. First sentence.';
  const catalog = buildConversationNoteCatalog({
    content,
    locale: 'en',
    annotationId: 'attached',
    annotationSelector,
    hasExistingNote: true,
    selection: {
      selectedText: 'First sentence.',
      selectedTextStart: content.indexOf('First sentence.'),
    },
  });
  expect(catalog.entries.find(entry => entry.id === 's')?.annotationId).toBeUndefined();
  expect(catalog.entries.find(entry => entry.id === 's')?.hasExistingNote).toBe(false);
  expect(
    validateConversationNotePassage({
      catalog,
      input: { passageId: 's' },
      current: { lessonContent: content },
    }).error?.code
  ).toBe('anchor_mismatch');
  expect(
    validateConversationNotePassage({
      catalog,
      input: { passageId: 'p1' },
      current: { lessonContent: content },
    }).error
  ).toBeUndefined();
  const otherQuote = validateConversationNotePassage({
    catalog,
    input: { selectedTextDraft: 'Changed first sentence.' },
    current: { lessonContent: content },
  });
  expect(otherQuote.error).toBeUndefined();
  expect(otherQuote.target?.hasExistingNote).toBe(false);
});

test('historical quotes keep their own exact target and update only when it equals the annotation target', () => {
  const content = 'First sentence. Second sentence.';
  const annotationSelector = build(content).entries[0].selector;
  const catalog = buildConversationNoteCatalog({
    content,
    locale: 'en',
    hasExistingNote: true,
    annotationId: 'attached',
    annotationSelector,
    selection: { selectedText: 'First', selectedTextStart: 0 },
  });
  for (const quote of ['First', 'First sentence.', 'Second sentence.']) {
    const target = resolveConversationNotePassage(catalog, { selectedTextDraft: quote });
    expect(target?.text).toBe(quote);
    expect(target?.hasExistingNote).toBe(quote === annotationSelector.exact);
  }
});

test.each([
  '**First** sentence. Second sentence.',
  '# First sentence.',
  '- First sentence. Second sentence.',
  '[First](https://example.test) sentence. Second sentence.',
])('the stored annotation selector round-trips formatted source: %s', content => {
  const annotationSelector = build(content).entries[0].selector;
  const catalog = buildConversationNoteCatalog({
    content,
    locale: 'en',
    annotationId: 'attached',
    annotationSelector,
    hasExistingNote: true,
    selection: { selectedText: 'First', selectedTextStart: 0 },
  });
  expect(catalog.entries.find(entry => entry.id === 's')).toMatchObject({
    selector: annotationSelector,
    hasExistingNote: true,
    annotationId: 'attached',
  });
  assertRoundTrip(catalog);
});
