import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { test } from 'vitest';
import {
  createLibraryArchiveBlob,
  LibraryArchiveError,
  readLibraryArchive,
  restoreLibraryArchiveOrganization,
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

test('library backup round trip preserves courses, folders, and placements', async () => {
  const projects = [
    buildSnapshot('course-one', 'Primo corso'),
    buildSnapshot('course-two', 'Secondo corso'),
  ];
  const folders = [
    {
      id: 'folder-parent',
      name: 'Materie',
      parentFolderId: null,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      order: 0,
    },
    {
      id: 'folder-child',
      name: 'Matematica',
      parentFolderId: 'folder-parent',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      order: 0,
    },
  ];
  const placements = [
    {
      projectId: 'course-one',
      folderId: 'folder-child',
      order: 0,
      updatedAt: '2026-07-13T00:00:00.000Z',
    },
    {
      projectId: 'course-two',
      folderId: null,
      order: 1,
      updatedAt: '2026-07-13T00:00:00.000Z',
    },
  ];

  const archive = await createLibraryArchiveBlob(projects, { folders, placements });
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const imported = await readLibraryArchive(archive);

  assert.equal(zip.file(/^projects\/.*\.nous\.zip$/u).length, 2);
  assert.deepEqual(
    imported.projects.map(project => project.id),
    ['course-one', 'course-two']
  );
  assert.deepEqual(
    imported.projects.map(project => project.title),
    ['Primo corso', 'Secondo corso']
  );
  assert.equal(
    imported.projects.every(project => !Object.hasOwn(project, 'source')),
    true
  );
  assert.equal(imported.projectArchives.length, 2);
  assert.deepEqual(imported.folders, folders);
  assert.deepEqual(imported.placements, placements);
});

test('library backup export rejects a missing project placement', async () => {
  await assert.rejects(
    () =>
      createLibraryArchiveBlob([buildSnapshot('course-one', 'Corso uno')], {
        folders: [],
        placements: [],
      }),
    /posizionamento per ogni corso/iu
  );
});

test('library backup import rejects a nested project whose id differs from the manifest', async () => {
  const archive = await createLibraryArchiveBlob([buildSnapshot('course-one', 'Corso uno')], {
    folders: [],
    placements: [
      {
        projectId: 'course-one',
        folderId: null,
        order: 0,
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
    ],
  });
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestEntry = zip.file('library.json');
  assert.ok(manifestEntry);
  const manifest = JSON.parse(await manifestEntry.async('string')) as {
    projects: Array<{ id: string }>;
    placements: Array<{ projectId: string }>;
  };
  if (manifest.projects[0]) manifest.projects[0].id = 'different-course';
  if (manifest.placements[0]) manifest.placements[0].projectId = 'different-course';
  zip.file('library.json', JSON.stringify(manifest));
  const malformed = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  const imported = await readLibraryArchive(malformed);

  assert.deepEqual(imported.projectArchives, []);
  assert.deepEqual(imported.rejectedProjects, [
    {
      code: 'LIBRARY_ARCHIVE_PROJECT_INVALID',
      id: 'different-course',
      projectCount: 1,
      projectIndex: 1,
      stage: 'nested-project-read',
      title: 'Corso uno',
    },
  ]);
});

test('library backup v2 accepts duplicate sibling orders used by the current stores', async () => {
  const timestamp = '2026-07-13T00:00:00.000Z';
  const archive = await createLibraryArchiveBlob([buildSnapshot('course-one', 'Corso uno')], {
    folders: [
      {
        id: 'folder-one',
        name: 'Materie',
        parentFolderId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        order: 0,
      },
    ],
    placements: [{ projectId: 'course-one', folderId: null, order: 1, updatedAt: timestamp }],
  });
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestEntry = zip.file('library.json');
  assert.ok(manifestEntry);
  const manifest = JSON.parse(await manifestEntry.async('string')) as {
    placements: Array<{ order: number }>;
  };
  if (manifest.placements[0]) manifest.placements[0].order = 0;
  zip.file('library.json', JSON.stringify(manifest));
  const validArchive = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  const imported = await readLibraryArchive(validArchive);

  assert.equal(imported.folders[0]?.order, 0);
  assert.equal(imported.placements[0]?.order, 0);
});

test('legacy library backup v1 imports projects at root without organization metadata', async () => {
  const timestamp = '2026-07-13T00:00:00.000Z';
  const archive = await createLibraryArchiveBlob([buildSnapshot('course-one', 'Corso uno')], {
    folders: [],
    placements: [{ projectId: 'course-one', folderId: null, order: 0, updatedAt: timestamp }],
  });
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  const manifestEntry = zip.file('library.json');
  assert.ok(manifestEntry);
  const manifest = JSON.parse(await manifestEntry.async('string')) as Record<string, unknown>;
  manifest.archiveVersion = 1;
  delete manifest.folders;
  delete manifest.placements;
  zip.file('library.json', JSON.stringify(manifest));
  const legacyArchive = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  const imported = await readLibraryArchive(legacyArchive);

  assert.deepEqual(imported.folders, []);
  assert.deepEqual(imported.placements, []);
});

test('library backup restore recreates nested folders and project placements', async () => {
  const calls: string[] = [];
  const repository = {
    createFolder: async ({
      name,
      parentFolderId,
    }: {
      name: string;
      parentFolderId?: string | null;
    }) => {
      const id = name === 'Materie' ? 'new-parent' : 'new-child';
      calls.push(`create:${name}:${parentFolderId ?? 'root'}`);
      return {
        id,
        name,
        parentFolderId: parentFolderId ?? null,
        createdAt: '',
        updatedAt: '',
        order: 0,
      };
    },
    deleteFolder: async (folderId: string) => {
      calls.push(`delete:${folderId}`);
    },
    moveFolder: async (folderId: string, parentFolderId: string | null, targetIndex?: number) => {
      calls.push(`folder:${folderId}:${parentFolderId ?? 'root'}:${targetIndex}`);
      return null;
    },
    moveProjects: async (projectIds: string[], folderId: string | null, targetIndex?: number) => {
      calls.push(`project:${projectIds.join(',')}:${folderId ?? 'root'}:${targetIndex}`);
      return [];
    },
  };

  await restoreLibraryArchiveOrganization(
    repository,
    {
      folders: [
        {
          id: 'old-parent',
          name: 'Materie',
          parentFolderId: null,
          createdAt: '',
          updatedAt: '',
          order: 0,
        },
        {
          id: 'old-child',
          name: 'Matematica',
          parentFolderId: 'old-parent',
          createdAt: '',
          updatedAt: '',
          order: 0,
        },
      ],
      placements: [
        { projectId: 'course-one', folderId: 'old-child', order: 0, updatedAt: '' },
        { projectId: 'course-two', folderId: null, order: 0, updatedAt: '' },
      ],
    },
    new Map([
      ['course-one', 'imported-course-one'],
      ['course-two', 'imported-course-two'],
    ])
  );

  assert.deepEqual(calls, [
    'create:Materie:root',
    'create:Matematica:new-parent',
    'folder:new-parent:root:0',
    'project:imported-course-two:root:1',
    'folder:new-child:new-parent:0',
    'project:imported-course-one:new-child:0',
  ]);
});

test('library backup restore removes folders created before a placement failure', async () => {
  const deletedFolders: string[] = [];
  const repository = {
    createFolder: async () => ({
      id: 'new-folder',
      name: 'Materie',
      parentFolderId: null,
      createdAt: '',
      updatedAt: '',
      order: 0,
    }),
    deleteFolder: async (folderId: string) => {
      deletedFolders.push(folderId);
    },
    moveFolder: async () => null,
    moveProjects: async () => {
      throw new Error('placement failed');
    },
  };

  await assert.rejects(
    () =>
      restoreLibraryArchiveOrganization(
        repository,
        {
          folders: [
            {
              id: 'old-folder',
              name: 'Materie',
              parentFolderId: null,
              createdAt: '',
              updatedAt: '',
              order: 0,
            },
          ],
          placements: [
            { projectId: 'course-one', folderId: 'old-folder', order: 0, updatedAt: '' },
          ],
        },
        new Map([['course-one', 'new-course']])
      ),
    /placement failed/iu
  );
  assert.deepEqual(deletedFolders, ['new-folder']);
});

test('library backup import rejects a single-course archive', async () => {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify({ format: 'nous-project-archive' }));
  const archive = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  await assert.rejects(
    () => readLibraryArchive(archive),
    /Hai selezionato il backup di un singolo corso\./
  );
});

test('library backup import identifies a malformed ZIP', async () => {
  await assert.rejects(
    () => readLibraryArchive(new Blob([new Uint8Array([0x6e, 0x6f, 0x75, 0x73])])),
    (error: unknown) => {
      assert(error instanceof LibraryArchiveError);
      assert.equal(error.code, 'LIBRARY_ARCHIVE_ZIP_UNREADABLE');
      assert.equal(error.stage, 'zip-open');
      return true;
    }
  );
});

test('library backup import identifies a missing manifest', async () => {
  const zip = new JSZip();
  zip.file('unrelated.txt', 'not a Nous backup');
  const archive = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  await assert.rejects(
    () => readLibraryArchive(archive),
    (error: unknown) => {
      assert(error instanceof LibraryArchiveError);
      assert.equal(error.code, 'LIBRARY_ARCHIVE_INVALID');
      assert.equal(error.stage, 'manifest-read');
      return true;
    }
  );
});

test('library backup import reports the manifest size limit without archive content', async () => {
  const zip = new JSZip();
  zip.file('library.json', 'x'.repeat(2_000_000), { compression: 'DEFLATE' });
  const archive = new Blob([
    new Uint8Array(await zip.generateAsync({ compression: 'DEFLATE', type: 'uint8array' })),
  ]);

  await assert.rejects(
    () => readLibraryArchive(archive),
    (error: unknown) => {
      assert(error instanceof LibraryArchiveError);
      assert.equal(error.code, 'LIBRARY_ARCHIVE_MANIFEST_TOO_LARGE');
      assert.equal(error.stage, 'manifest-read');
      assert.equal(error.limitBytes, 1_000_000);
      return true;
    }
  );
});

test('library backup import does not report a corrupt manifest as oversized', async () => {
  const manifest = JSON.stringify({
    archiveVersion: 1,
    format: 'nous-library-archive',
    projects: [{ id: 'course', path: 'projects/course.nous.zip', title: 'Corso' }],
  });
  const zip = new JSZip();
  zip.file('library.json', manifest, { compression: 'STORE' });
  const archiveBytes = Buffer.from(
    await zip.generateAsync({ compression: 'STORE', type: 'uint8array' })
  );
  const manifestOffset = archiveBytes.indexOf(manifest);
  assert.notEqual(manifestOffset, -1);
  archiveBytes[manifestOffset] ^= 1;

  await assert.rejects(
    () => readLibraryArchive(new Blob([archiveBytes])),
    (error: unknown) => {
      assert(error instanceof LibraryArchiveError);
      assert.equal(error.code, 'LIBRARY_ARCHIVE_INVALID');
      assert.equal(error.stage, 'manifest-read');
      return true;
    }
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
    () => readLibraryArchive(archive),
    /La versione 99 del backup non è supportata\./
  );
});

test('library backup import rejects cyclic folder hierarchies before importing projects', async () => {
  const timestamp = '2026-07-13T00:00:00.000Z';
  const zip = new JSZip();
  zip.file(
    'library.json',
    JSON.stringify({
      format: 'nous-library-archive',
      archiveVersion: 2,
      projects: [{ id: 'course', title: 'Corso', path: 'projects/course.nous.zip' }],
      folders: [
        {
          id: 'folder-a',
          name: 'A',
          parentFolderId: 'folder-b',
          createdAt: timestamp,
          updatedAt: timestamp,
          order: 0,
        },
        {
          id: 'folder-b',
          name: 'B',
          parentFolderId: 'folder-a',
          createdAt: timestamp,
          updatedAt: timestamp,
          order: 0,
        },
      ],
      placements: [{ projectId: 'course', folderId: 'folder-a', order: 1, updatedAt: timestamp }],
    })
  );
  const archive = new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);

  await assert.rejects(() => readLibraryArchive(archive), /gerarchia delle cartelle.*ciclo/iu);
});

test('library backup import isolates a missing nested course with its position', async () => {
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

  const imported = await readLibraryArchive(archive);

  assert.deepEqual(imported.projectArchives, []);
  assert.deepEqual(imported.rejectedProjects, [
    {
      code: 'LIBRARY_ARCHIVE_ENTRY_MISSING',
      id: 'missing',
      projectCount: 1,
      projectIndex: 1,
      stage: 'nested-project-read',
      title: 'Corso',
    },
  ]);
});

test('library backup import isolates a corrupt nested course without reporting it as oversized', async () => {
  const archive = await createLibraryArchiveBlob([buildSnapshot('course', 'Corso')], {
    folders: [],
    placements: [
      {
        projectId: 'course',
        folderId: null,
        order: 0,
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
    ],
  });
  const archiveBytes = Buffer.from(await archive.arrayBuffer());
  const zip = await JSZip.loadAsync(archiveBytes);
  const nestedEntry = zip.file('projects/001-course.nous.zip');
  assert(nestedEntry);
  const nestedBytes = Buffer.from(await nestedEntry.async('uint8array'));
  const nestedOffset = archiveBytes.indexOf(nestedBytes);
  assert.notEqual(nestedOffset, -1);
  archiveBytes[nestedOffset] ^= 1;

  const imported = await readLibraryArchive(new Blob([archiveBytes]));

  assert.deepEqual(imported.projectArchives, []);
  assert.deepEqual(imported.rejectedProjects, [
    {
      code: 'LIBRARY_ARCHIVE_PROJECT_INVALID',
      id: 'course',
      projectCount: 1,
      projectIndex: 1,
      stage: 'nested-project-read',
      title: 'Corso',
    },
  ]);
});

test('library backup import preserves a valid course when another nested archive is corrupt', async () => {
  const timestamp = '2026-07-13T00:00:00.000Z';
  const projects = Array.from({ length: 2 }, (_, index) =>
    buildSnapshot(`course-${index + 1}`, `Corso ${index + 1}`)
  );
  const archive = await createLibraryArchiveBlob(projects, {
    folders: [],
    placements: projects.map((project, index) => ({
      projectId: project.id,
      folderId: null,
      order: index,
      updatedAt: timestamp,
    })),
  });
  const zip = await JSZip.loadAsync(await archive.arrayBuffer());
  zip.file('projects/002-course-2.nous.zip', new Uint8Array([0x6e, 0x6f, 0x75, 0x73]), {
    binary: true,
    compression: 'STORE',
  });
  const archiveWithCorruptCourse = new Blob([
    new Uint8Array(await zip.generateAsync({ type: 'uint8array' })),
  ]);

  const imported = await readLibraryArchive(archiveWithCorruptCourse);

  assert.equal(imported.projectCount, 2);
  assert.deepEqual(
    imported.projectArchives.map(project => project.id),
    ['course-1']
  );
  assert.deepEqual(imported.rejectedProjects, [
    {
      code: 'LIBRARY_ARCHIVE_PROJECT_INVALID',
      id: 'course-2',
      projectCount: 2,
      projectIndex: 2,
      stage: 'nested-project-read',
      title: 'Corso 2',
    },
  ]);
});

test('library backup rejects aggregate expansion before opening nested project archives', async () => {
  const expandedNestedArchive = 'x'.repeat(2_000_000);
  const zip = new JSZip();
  zip.file(
    'library.json',
    JSON.stringify({
      archiveVersion: 1,
      format: 'nous-library-archive',
      projects: [{ id: 'compressed-course', path: 'projects/course.nous.zip', title: 'Corso' }],
    }),
    { compression: 'DEFLATE' }
  );
  zip.file('projects/course.nous.zip', expandedNestedArchive, { compression: 'DEFLATE' });
  const archive = new Blob([
    new Uint8Array(
      await zip.generateAsync({
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
        type: 'uint8array',
      })
    ),
  ]);

  await assert.rejects(() => readLibraryArchive(archive), /non è un archivio ZIP Nous leggibile/iu);
});
