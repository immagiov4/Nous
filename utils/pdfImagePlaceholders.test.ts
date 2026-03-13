import assert from 'node:assert/strict';
import test from 'node:test';
import type { LessonImageRef, PdfImageAsset } from '../types';
import { replacePdfImagePlaceholders, restoreLegacyPdfImagePlaceholders, stripPdfImagePlaceholders } from './pdfImagePlaceholders.ts';

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

test('drops orphan placeholders without throwing', () => {
  const rendered = replacePdfImagePlaceholders(
    'Testo\n\n{{PDF_IMAGE:pdf-img-404|alt=Mancante}}\n\nAltro',
    { 'pdf-img-001': asset }
  );

  assert.equal(rendered.includes('pdf-img-404'), false);
  assert.match(rendered, /^Testo/);
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

  assert.match(restored, /\{\{PDF_IMAGE:pdf-img-001\|alt=Schema di rete\|caption=Figura 1: Rete\}\}/);
});

test('restores legacy standalone PDF images into placeholders', () => {
  const restored = restoreLegacyPdfImagePlaceholders(
    'Prima <img src="data:image/png;base64,BROKEN" alt="Diagramma" data-pdf-asset-id="pdf-img-001" /> Dopo'
  );

  assert.match(restored, /\{\{PDF_IMAGE:pdf-img-001\|alt=Diagramma\}\}/);
});
