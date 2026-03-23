import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeBytesBase64, encodeTextBase64 } from '../projectSource.ts';
import { buildDocumentInputContent } from './shared.ts';

test('buildDocumentInputContent serializes markdown and structured text files as plain text source', () => {
  const markdownContent = buildDocumentInputContent(
    {
      name: 'notes.md',
      mimeType: '',
      data: encodeTextBase64('# Heading\n\nBody'),
    },
    'Prompt di test'
  );

  const jsonContent = buildDocumentInputContent(
    {
      name: 'schema.json',
      mimeType: '',
      data: encodeTextBase64('{"ok":true}'),
    },
    'Prompt di test'
  );

  assert.equal(typeof markdownContent, 'string');
  if (typeof markdownContent !== 'string') {
    throw new Error('Expected markdown content to be serialized as text');
  }
  assert.match(markdownContent, /CONTENUTO SORGENTE:/);
  assert.match(markdownContent, /# Heading/);

  assert.equal(typeof jsonContent, 'string');
  if (typeof jsonContent !== 'string') {
    throw new Error('Expected JSON content to be serialized as text');
  }
  assert.match(jsonContent, /schema\.json/);
  assert.match(jsonContent, /"ok":true/);
});

test('buildDocumentInputContent keeps pdf uploads in file mode', () => {
  const content = buildDocumentInputContent(
    {
      name: 'dispensa.pdf',
      mimeType: 'application/pdf',
      data: encodeTextBase64('fake pdf'),
    },
    'Prompt PDF'
  );

  assert.ok(Array.isArray(content));
  assert.equal(content[1]?.type, 'file');
});

test('buildDocumentInputContent keeps true images in image mode', () => {
  const content = buildDocumentInputContent(
    {
      name: 'diagram.png',
      mimeType: 'image/png',
      data: encodeBytesBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])),
    },
    'Prompt immagine'
  );

  assert.ok(Array.isArray(content));
  assert.equal(content[0]?.type, 'image_url');
});
