import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { test } from 'vitest';
import {
  createLibraryArchiveBlob,
  readLibraryArchiveProjects,
} from '../../../services/projects/libraryArchive.ts';
import { encodeTextBase64 } from '../../../services/projects/projectSource.ts';
import { AppState, type ProjectSnapshot } from '../../../types.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

const buildSnapshot = (id: string, title: string): ProjectSnapshot => ({
  id,
  version: '4.1',
  sourceKind: 'document',
  state: AppState.READING,
  source: {
    kind: 'pdf',
    file: {
      name: `${id}.pdf`,
      mimeType: 'application/pdf',
      data: encodeTextBase64(`# ${title}`),
    },
  },
  learningPlan: buildTestLearningPlan(
    [buildTestLesson({ id: `${id}-lesson`, title: 'Lezione', moduleTitle: 'Modulo' })],
    { title, summary: 'Sintesi', backgroundMusicUrl: '' }
  ),
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: null,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
  lastOpenedAt: '2026-07-13T00:00:00.000Z',
});

test('library backup round trip preserves every course and its source', async () => {
  const projects = [
    buildSnapshot('course-one', 'Primo corso'),
    buildSnapshot('course-two', 'Secondo corso'),
  ];

  const archive = await createLibraryArchiveBlob(projects);
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const imported = await readLibraryArchiveProjects(archive);

  assert.equal(zip.file(/^projects\/.*\.nous\.zip$/u).length, 2);
  assert.deepEqual(
    imported.map(project => project.id),
    ['course-one', 'course-two']
  );
  assert.deepEqual(
    imported.map(project => project.source),
    projects.map(project => project.source)
  );
});

test('library backup import rejects a single-course archive', async () => {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify({ format: 'nous-project-archive' }));
  const archive = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  await assert.rejects(
    () => readLibraryArchiveProjects(archive),
    /Hai selezionato il backup di un singolo corso\./
  );
});

test('library backup import identifies an unsupported manifest version', async () => {
  const zip = new JSZip();
  zip.file(
    'library.json',
    JSON.stringify({ format: 'nous-library-archive', archiveVersion: 99, projects: [] })
  );
  const archive = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  await assert.rejects(
    () => readLibraryArchiveProjects(archive),
    /La versione 99 del backup non è supportata\./
  );
});

test('library backup import reports the missing nested course position', async () => {
  const zip = new JSZip();
  zip.file(
    'library.json',
    JSON.stringify({
      format: 'nous-library-archive',
      archiveVersion: 1,
      projects: [{ id: 'missing', title: 'Corso', path: 'projects/missing.nous.zip' }],
    })
  );
  const archive = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  await assert.rejects(
    () => readLibraryArchiveProjects(archive),
    /Nel backup manca il corso 1 di 1\./
  );
});
