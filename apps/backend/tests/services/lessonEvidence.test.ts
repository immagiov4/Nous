import assert from 'node:assert/strict';
import { describe, expect, test } from 'vitest';

import {
  buildLessonEvidenceMaterials,
  resolveLessonEvidence,
} from '../../src/services/lessonEvidence.js';
import { encodeLessonPrimarySources } from '../../src/services/lessonPrimarySourceContext.js';

const sources = [
  {
    sourceId: 'video-source',
    title: 'Misure',
    url: 'https://www.youtube.com/watch?v=evidence',
    youtubeTranscript: {
      segments: [
        { startSeconds: 0.25, endSeconds: 2.75, text: 'Introduzione al canale.' },
        { startSeconds: 2.5, endSeconds: 5.8, text: 'La temperatura diminuisce.' },
        {
          startSeconds: 5.8,
          endSeconds: 8.125,
          text: 'Questo vale soltanto a pressione costante.',
        },
        { startSeconds: 9, endSeconds: 14, text: 'Iscrivetevi per altri video.' },
      ],
    },
  },
  {
    title: 'Ripetizione',
    youtubeTranscript: {
      segments: [
        { startSeconds: 0, endSeconds: 3, text: 'A pressione costante la temperatura diminuisce.' },
      ],
    },
  },
  { title: 'Tema estraneo', note: 'Storia della fotografia.' },
];
const materials = () =>
  buildLessonEvidenceMaterials({ sourceContext: '', researchContext: '', sources });
const selection = () => ({
  materials: [
    {
      materialId: 'source-0',
      reason: 'Mostra il fenomeno e la condizione.',
      passages: [
        { firstUnit: 1, lastUnit: 2, claims: ['La temperatura diminuisce a pressione costante.'] },
      ],
      overlaps: [],
    },
    {
      materialId: 'source-1',
      reason: 'Ripete il contenuto già sostenuto.',
      passages: [],
      overlaps: [
        {
          firstUnit: 0,
          lastUnit: 0,
          retainedMaterialId: 'source-0',
          retainedFirstUnit: 1,
          retainedLastUnit: 2,
          reason: 'Stessa affermazione e stessa condizione.',
        },
      ],
    },
    {
      materialId: 'source-2',
      reason: 'Non sostiene il fenomeno della lezione.',
      passages: [],
      overlaps: [],
    },
  ],
});

describe('lesson evidence references', () => {
  test('accepts overlap citations narrowed to units inside a retained passage', () => {
    const response = selection();
    const overlap = response.materials[1]?.overlaps[0];
    assert(overlap);
    overlap.retainedLastUnit = 1;
    expect(resolveLessonEvidence(materials(), response).selection).toEqual(response);
    overlap.retainedFirstUnit = 2;
    expect(() => resolveLessonEvidence(materials(), response)).toThrow('invalid source references');
  });
  test('retains each document identity when selecting content without its header', () => {
    const parts = ['source-a', 'source-b'].map(sourceId => ({
      source: {
        sourceId,
        title: `${sourceId}.pdf`,
        chunkIds: [`${sourceId}:chunk-1`],
        pageStart: 3,
      },
      text: `CHUNK ${sourceId}:chunk-1\nContenuto di ${sourceId}.`,
    }));
    const original = buildLessonEvidenceMaterials({
      sourceContext: encodeLessonPrimarySources(parts),
      researchContext: '',
      sources: [],
    });
    const packet = resolveLessonEvidence(original, {
      materials: [
        {
          materialId: 'primary',
          reason: 'Entrambi i documenti sostengono la lezione.',
          overlaps: [],
          passages: [1, 3].map(unit => ({
            firstUnit: unit,
            lastUnit: unit,
            claims: ['Affermazione pertinente.'],
          })),
        },
      ],
    });
    expect(packet.passages.map(passage => passage.units)).toEqual(
      parts.map(part => [
        {
          source: part.source,
          text: part.text.split('\n')[1],
          startOffset: part.text.indexOf('\n') + 1,
          endOffset: part.text.length,
        },
      ])
    );
  });
  test('keeps canonical text, overlapping timestamps, qualifier and source identity without mutating originals', () => {
    const original = structuredClone(sources);
    const packet = resolveLessonEvidence(materials(), selection());
    expect(packet.passages).toHaveLength(1);
    expect(packet.passages[0]).toMatchObject({
      sourceIndex: 0,
      source: { sourceId: 'video-source', url: sources[0].url },
      units: sources[0].youtubeTranscript?.segments.slice(1, 3),
    });
    expect(sources).toEqual(original);
    expect(packet.selection.materials[2]?.passages).toEqual([]);
  });

  test('preserves exact primary-text offsets and removes duplicated dossier transcript expansion', () => {
    const primary = 'Prima riga.\r\nSeconda riga.\n';
    const result = buildLessonEvidenceMaterials({
      sourceContext: primary,
      researchContext: JSON.stringify({ factualSummary: 'Sintesi', sources }),
      sources,
    });
    assert(result[0] && result[1]);
    const units = result[0].units;
    expect(units.map(unit => primary.slice(unit.startOffset, unit.endOffset)).join('')).toBe(
      primary
    );
    expect(result[1].units.map(unit => unit.text).join('')).toBe(
      JSON.stringify({ factualSummary: 'Sintesi' }, null, 2)
    );
  });

  test.each([
    'unknown',
    'missing',
    'duplicate',
    'out-of-range',
    'reversed',
    'overlap',
    'unretained-duplicate',
  ] as const)('rejects %s references instead of inventing source support', defect => {
    const response = selection();
    const [first, second, third] = response.materials;
    assert(first && second && third && first.passages[0] && second.overlaps[0]);
    if (defect === 'unknown') first.materialId = 'source-99';
    if (defect === 'missing') response.materials.pop();
    if (defect === 'duplicate') third.materialId = 'source-0';
    if (defect === 'out-of-range') first.passages[0].lastUnit = 99;
    if (defect === 'reversed') first.passages[0].firstUnit = 3;
    if (defect === 'overlap')
      first.passages.push({ firstUnit: 2, lastUnit: 3, claims: ['Duplicato'] });
    if (defect === 'unretained-duplicate') second.overlaps[0].retainedFirstUnit = 0;
    expect(() => resolveLessonEvidence(materials(), response)).toThrow('invalid source references');
  });
});
