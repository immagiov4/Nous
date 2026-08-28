import assert from 'node:assert/strict';
import type { ProjectDocumentImageAsset } from '@shared/projectAsset';
import { expect, test } from 'vitest';
import type { LessonImageRef, PdfImageAsset } from '../../../types';
import {
  parsePdfContentParts,
  replacePdfImagePlaceholders,
  restoreLegacyPdfImagePlaceholders,
  stripPdfImagePlaceholders,
} from '../../../utils/pdf/imagePlaceholders.ts';

const asset: PdfImageAsset = {
  id: 'pdf-img-001',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,AAAA',
  textBefore: 'before',
  textAfter: 'after',
  sourceOrder: 1,
};

const imageRef: LessonImageRef = {
  assetId: 'pdf-img-001',
  alt: 'Schema di rete',
  caption: 'Figura 1',
};

test('replaces known PDF image placeholders with figure HTML', () => {
  const rendered = replacePdfImagePlaceholders(
    'Intro\n\n{{PDF_IMAGE:pdf-img-001|alt=Schema di rete|caption=Figura 1}}\n\nFine',
    { 'pdf-img-001': asset },
    { 'pdf-img-001': imageRef }
  );

  assert.match(rendered, /<figure/);
  assert.match(rendered, /data-pdf-asset-id="pdf-img-001"/);
  assert.match(rendered, /Schema di rete/);
  assert.match(rendered, /Figura 1/);
});

test('preserves a malformed PDF marker before replacing a later complete marker', () => {
  const rendered = replacePdfImagePlaceholders(
    'Prima {{PDF_IMAGE:bozza poi {{PDF_IMAGE:pdf-img-001}} dopo',
    { 'pdf-img-001': asset }
  );

  expect(rendered).toMatch(/\{\{PDF_IMAGE:bozza poi/u);
  assert.match(rendered, /data-pdf-asset-id="pdf-img-001"/u);
  assert.match(rendered, /dopo/u);
});

test('preserves PDF placeholders with unknown options', () => {
  const content = 'Prima {{PDF_IMAGE:pdf-img-001|foo=bar}} dopo';

  expect(replacePdfImagePlaceholders(content, { 'pdf-img-001': asset })).toBe(content);
});

test('drops orphan placeholders without throwing', () => {
  const rendered = replacePdfImagePlaceholders(
    'Testo\n\n{{PDF_IMAGE:pdf-img-404|alt=Mancante}}\n\nAltro',
    { 'pdf-img-001': asset }
  );

  assert.equal(rendered.includes('pdf-img-404'), false);
  assert.match(rendered, /^Testo/);
});

test('resolves durable PDF images by logical placeholder ID, not storage asset ID', () => {
  const durableAsset: ProjectDocumentImageAsset = {
    asset: {
      byteSize: 4,
      hash: 'b'.repeat(64),
      id: 'a'.repeat(64),
      mediaType: 'image/png',
    },
    id: 'pdf-image-logical-1',
    sourceOrder: 1,
    textAfter: 'after',
    textBefore: 'before',
  };

  const parts = parsePdfContentParts('{{PDF_IMAGE:pdf-image-logical-1|alt=Schema durevole}}', {
    'pdf-image-logical-1': durableAsset,
  });

  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.type, 'image');
  assert.equal(parts[0]?.key, 'img-pdf-image-logical-1-0');
  if (parts[0]?.type === 'image') {
    assert.equal(parts[0].asset, durableAsset);
  }
});

test('strips PDF image placeholders for speech preparation', () => {
  const stripped = stripPdfImagePlaceholders('A {{PDF_IMAGE:pdf-img-001|alt=Schema}} B');
  assert.equal(stripped, 'A   B');
});

test('restores legacy PDF figures into placeholders', () => {
  const restored = restoreLegacyPdfImagePlaceholders(`
Intro

<figure class="card">
  <img src="data:image/png;base64,BROKEN" alt="Schema di rete" data-pdf-asset-id="pdf-img-001" />
  <figcaption>Figura 1: <strong>Rete</strong></figcaption>
</figure>

Fine`);

  assert.match(
    restored,
    /\{\{PDF_IMAGE:pdf-img-001\|alt=Schema di rete\|caption=Figura 1: Rete\}\}/
  );
});

test('restores legacy standalone PDF images into placeholders', () => {
  const restored = restoreLegacyPdfImagePlaceholders(
    'Prima <img src="data:image/png;base64,BROKEN" alt="Diagramma" data-pdf-asset-id="pdf-img-001" /> Dopo'
  );

  assert.match(restored, /\{\{PDF_IMAGE:pdf-img-001\|alt=Diagramma\}\}/);
});

test('normalizes persisted placeholders whose text contains a legacy opening brace', () => {
  const restored = restoreLegacyPdfImagePlaceholders(
    'Prima {{PDF_IMAGE:pdf-img-001|alt=Set {A|caption=Insieme {A}} dopo'
  );

  expect(restored).toBe('Prima {{PDF_IMAGE:pdf-img-001|alt=Set  A|caption=Insieme  A}} dopo');
  assert.equal(parsePdfContentParts(restored, { 'pdf-img-001': asset })[1]?.type, 'image');
});

test('does not let an incomplete legacy marker consume the next complete placeholder', () => {
  const restored = restoreLegacyPdfImagePlaceholders(
    'Prima {{PDF_IMAGE:bozza|alt=Set {A poi {{PDF_IMAGE:pdf-img-001}} dopo'
  );

  expect(restored).toMatch(/\{\{PDF_IMAGE:bozza\|alt=Set \{A poi/u);
  assert.equal(parsePdfContentParts(restored, { 'pdf-img-001': asset })[1]?.type, 'image');
});
