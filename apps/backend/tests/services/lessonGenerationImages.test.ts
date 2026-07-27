import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  resolveLessonImageRefs,
  selectCandidatePdfImages,
} from '../../src/services/lessonGenerationImages.js';
import type { LessonPdfImageAsset } from '../../src/services/lessonGenerationSources.js';

const image = (
  id: string,
  sourceOrder: number,
  overrides: Partial<LessonPdfImageAsset> = {}
): LessonPdfImageAsset => ({
  caption: `Figura ${id}`,
  dataUrl: 'data:image/png;base64,AA==',
  id,
  mimeType: 'image/png',
  sourceOrder,
  textAfter: '',
  textBefore: '',
  ...overrides,
});

test('PDF image candidates exclude unclear figures and preserve relevance ordering', () => {
  const candidates = selectCandidatePdfImages(
    [
      image('generic', 1, { caption: 'Schema generico', pageNumber: 2 }),
      image('clear', 2, {
        caption: 'Direzione del drittofilo e della cimosa nel tessuto',
        pageNumber: 8,
      }),
      image('unclear', 3, { caption: undefined, pageNumber: 8 }),
    ],
    'Drittofilo e cimosa',
    'Riconoscere la direzione del tessuto',
    [8]
  );

  assert.deepEqual(
    candidates.map(candidate => candidate.id),
    ['clear']
  );
});

test('a relevant clear PDF figure is restored when the model returns no image placements', () => {
  const images = [
    image('grain-map', 1, {
      caption: 'Mappa del tessuto con drittofilo, trama e cimosa',
      pageNumber: 8,
    }),
  ];

  const refs = resolveLessonImageRefs({
    contentMarkdown: '## Drittofilo e cimosa\n\nOsserva la direzione dei fili nel tessuto.',
    draftRefs: [],
    images,
    sectionDescription: 'Riconoscere drittofilo, trama e cimosa.',
    sectionTitle: 'La struttura del tessuto',
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.assetId, 'grain-map');
  assert.equal(refs[0]?.anchorHeading, 'Drittofilo e cimosa');
});

test('model-selected PDF figures are deduplicated and restricted to available assets', () => {
  const images = [image('valid', 1, { caption: 'Struttura del tessuto' })];
  const refs = resolveLessonImageRefs({
    contentMarkdown: '## Struttura\n\nContenuto.',
    draftRefs: [
      { alt: 'Figura valida', anchorHeading: 'Struttura', assetId: 'valid', caption: '' },
      { alt: 'Duplicata', anchorHeading: '', assetId: 'valid', caption: '' },
      { alt: 'Sconosciuta', anchorHeading: '', assetId: 'missing', caption: '' },
    ],
    images,
    sectionDescription: 'Descrizione',
    sectionTitle: 'Titolo',
  });

  assert.deepEqual(
    refs.map(reference => reference.assetId),
    ['valid']
  );
  assert.equal(refs[0]?.caption, 'Struttura del tessuto');
});

test('all verified PDF image placements survive without a per-lesson cap', () => {
  const images = Array.from({ length: 4 }, (_, index) =>
    image(`figure-${index + 1}`, index, { caption: `Figura verificata ${index + 1}` })
  );
  const refs = resolveLessonImageRefs({
    contentMarkdown: '## Figure\n\nContenuto.',
    draftRefs: images.map(item => ({
      alt: item.caption || '',
      anchorHeading: 'Figure',
      assetId: item.id,
      caption: item.caption || '',
    })),
    images,
    sectionDescription: 'Descrizione',
    sectionTitle: 'Titolo',
  });

  assert.deepEqual(
    refs.map(reference => reference.assetId),
    ['figure-1', 'figure-2', 'figure-3', 'figure-4']
  );
});
