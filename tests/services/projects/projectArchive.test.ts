import assert from 'node:assert/strict';
import { test } from 'vitest';
import JSZip from 'jszip';
import { AppState, type ProjectSnapshot } from '../../../types.ts';
import {
  createProjectArchiveBlob,
  readProjectImportData,
} from '../../../services/projects/projectArchive.ts';
import { encodeBytesBase64 } from '../../../services/projects/projectSource.ts';

const buildPdfSnapshot = (): ProjectSnapshot => {
  const pdfBytes = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x46, 0x61, 0x6b, 0x65, 0x20, 0x50,
    0x44, 0x46, 0x0a,
  ]);

  return {
    id: 'project-pdf',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.READING,
    source: {
      kind: 'pdf',
      file: {
        name: 'dispensa.pdf',
        mimeType: 'application/pdf',
        data: encodeBytesBase64(pdfBytes),
      },
    },
    learningPlan: {
      title: 'Percorso',
      summary: 'Sintesi',
      sections: [],
      backgroundMusicUrl: '',
    },
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
    lastOpenedAt: '2026-04-03T00:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };
};

test('createProjectArchiveBlob keeps pdf bytes outside the manifest and restores them losslessly on import', async () => {
  const snapshot = buildPdfSnapshot();
  const archive = await createProjectArchiveBlob(snapshot);
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestText = await zip.file('project.json')?.async('string');

  assert.equal(Boolean(manifestText), true);
  assert.equal(manifestText?.includes('"data"'), false);
  assert.equal(manifestText?.includes(snapshot.source?.kind === 'pdf' ? snapshot.source.file.data : ''), false);

  const imported = (await readProjectImportData(archive)) as ProjectSnapshot;

  assert.deepEqual(imported.source, snapshot.source);
});

test('readProjectImportData still supports legacy json exports', async () => {
  const legacyExport = {
    version: '4.1',
    source: {
      kind: 'pdf',
      file: {
        name: 'dispensa.pdf',
        mimeType: 'application/pdf',
        data: 'ZmFrZQ==',
      },
    },
    learningPlan: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
  };
  const legacyBlob = new Blob([JSON.stringify(legacyExport)], {
    type: 'application/json',
  });

  assert.deepEqual(await readProjectImportData(legacyBlob), legacyExport);
});
