import { ContextNoteCatalogSchema, serializeContextNoteView } from '@shared/contextNoteCatalog';
import { MAX_CONTEXT_CHAT_FIELD_CHARS } from '@shared/lessonSourceContext';
import { expect, test } from 'vitest';
import {
  buildConversationNoteCatalog,
  resolveConversationNotePassage,
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
  expect(build(source).entries[0].id).not.toBe(catalog.entries[0].id);
  assertRoundTrip(catalog);
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

test('clips only complete records and never advertises a truncated or protected target', () => {
  const catalog = build(
    `Short sentence.\n\n\`\`\`js\n${'const value = 1;\n'.repeat(3000)}\n\`\`\`\n\nLater sentence.`
  );
  expect(catalog.entries.map(entry => entry.text)).toEqual(['Short sentence.']);
  expect(serializeContextNoteView(catalog.records).length).toBeLessThanOrEqual(
    MAX_CONTEXT_CHAT_FIELD_CHARS
  );
  expect(ContextNoteCatalogSchema.safeParse({ records: catalog.records }).success).toBe(true);
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
  expect(serializeContextNoteView(catalog.records).length).toBeLessThanOrEqual(
    MAX_CONTEXT_CHAT_FIELD_CHARS
  );
  assertRoundTrip(catalog);
});
