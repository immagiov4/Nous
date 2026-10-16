import { createHash } from 'node:crypto';
import * as fixtureFiles from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PostgresAccountStore } from '../../../apps/backend/src/account/accountStore';
import { PostgresProjectStore } from '../../../apps/backend/src/projects/postgresProjectStore';
import { PostgresProjectAssetImporter } from '../../../apps/backend/src/projects/projectAssetImport';
import { buildProjectMeta } from '../../../apps/backend/src/projects/projectMeta';
import { createLibraryArchiveBlob } from '../../../apps/web/services/projects/libraryArchive';
import { createProjectArchiveBlob } from '../../../apps/web/services/projects/projectArchive';
import type { ProjectSnapshot } from '../../../apps/web/types';
import type { Story } from '../../../packages/playtest/src/types';
import { CourseFixtures, importFixture, withFixtureRun } from '../fixtures';
import { prepare, syntheticCourse } from '../prepare';
import type { StackStatus } from '../stack';
import * as workflowCleanup from '../workflowCleanup';

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

let root: string;
const status: StackStatus = {
  API_URL: 'http://127.0.0.1:55321',
  DB_URL: 'postgres://postgres:test@127.0.0.1:55322/postgres',
  ANON_KEY: 'test',
  SERVICE_ROLE_KEY: 'test',
  JWT_SECRET: 'test',
};
const story: Story = {
  id: 'fixture-test',
  title: 'Synthetic fixture',
  kind: 'check',
  body: 'Open a course.',
  viewports: ['desktop', 'mobile'],
  requires: {},
  surfaces: ['library'],
  tags: [],
  budget: { steps: 1 },
  sourcePath: 'test.md',
};
const assetBytes = new Uint8Array([1, 2, 3]);
const assetHash = createHash('sha256').update(assetBytes).digest('hex');
const assetRef = {
  id: assetHash,
  hash: assetHash,
  byteSize: assetBytes.length,
  mediaType: 'image/png',
};
const date = '2026-10-12T12:00:00.000Z';
function course(id: string, title: string): ProjectSnapshot {
  const snapshot = syntheticCourse() as unknown as ProjectSnapshot;
  snapshot.id = id;
  snapshot.updatedAt = date;
  if (!snapshot.learningPlan) throw new Error('Synthetic plan missing.');
  snapshot.learningPlan.title = title;
  const lesson = snapshot.learningPlan.modules[0].children[0];
  if (lesson.kind !== 'lesson') throw new Error('Synthetic lesson missing.');
  lesson.annotations = [
    {
      id: 'note',
      note: 'Synthetic annotation',
      createdAt: date,
      updatedAt: date,
      anchor: { kind: 'lesson' },
    },
  ];
  lesson.generatedVisuals = [
    { id: 'visual', createdAt: date, slotId: 'slot', render: { kind: 'image', asset: assetRef } },
  ];
  snapshot.source = {
    kind: 'pdf',
    file: {
      name: 'synthetic.pdf',
      mimeType: 'application/pdf',
      data: Buffer.from('synthetic source').toString('base64'),
    },
  };
  return snapshot;
}
async function backup(
  projects = [course('course-one', 'Synthetic course'), course('course-two', 'Another course')]
) {
  const archive = await createLibraryArchiveBlob(
    projects,
    {
      folders: [],
      placements: projects.map((project, order) => ({
        projectId: project.id,
        folderId: null,
        order,
        updatedAt: date,
      })),
    },
    {
      createProjectArchive: project =>
        createProjectArchiveBlob(project, { loadAsset: async () => assetBytes }),
    }
  );
  await writeFile(
    join(root, 'fixtures', 'nous-library-backup.nous-library.zip'),
    new Uint8Array(await archive.arrayBuffer())
  );
}
beforeEach(async () => {
  vi.spyOn(workflowCleanup, 'settleAccountWorkflows').mockResolvedValue();
  root = await mkdtemp(join(tmpdir(), 'nous-course-fixtures-'));
  await mkdir(join(root, 'fixtures'));
  vi.stubEnv('NOUS_E2E_DATA', root);
  vi.stubEnv('NOUS_E2E_LIBRARY', 'nous-library-backup.nous-library.zip');
  vi.spyOn(PostgresAccountStore.prototype, 'finishSetup').mockResolvedValue();
  vi.spyOn(PostgresProjectStore.prototype, 'close').mockResolvedValue();
  vi.spyOn(PostgresProjectStore.prototype, 'listProjects').mockResolvedValue([]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
function productImporter() {
  const prepareAssets = vi
    .spyOn(PostgresProjectAssetImporter.prototype, 'prepare')
    .mockImplementation(async input => ({
      assets: [],
      snapshot: { ...input.snapshot, id: input.projectId },
      release: async () => {},
    }));
  const save = vi
    .spyOn(PostgresProjectStore.prototype, 'saveProject')
    .mockImplementation(async (_userId, snapshot) => ({
      snapshot,
      meta: buildProjectMeta(snapshot),
    }));
  const store = new PostgresProjectStore(status.DB_URL);
  return { store, save, prepareAssets };
}
it('lists immutable freshness metadata and shares one validated decode across concurrent imports by ID and title', async () => {
  await backup();
  const fixtures = new CourseFixtures();
  const inventory = await fixtures.inventory();
  expect(inventory.courses).toEqual([
    expect.objectContaining({
      id: 'course-one',
      title: 'Synthetic course',
      updatedAt: date,
      lessonCount: 1,
      appVersion: '4.1',
      projectFormatVersion: 1,
      archiveVersion: 2,
    }),
    expect.objectContaining({ id: 'course-two', lessonCount: 1 }),
  ]);
  expect(Object.isFrozen(inventory.courses[0])).toBe(true);
  expect(Object.isFrozen(inventory.courses)).toBe(true);
  expect(inventory.sha256).toBe(
    createHash('sha256')
      .update(await readFile(inventory.archivePath))
      .digest('hex')
  );
  // Removing the file proves subsequent imports consume the retained run data.
  await rm(inventory.archivePath);
  const { store, save, prepareAssets } = productImporter();
  const [first, second] = await Promise.all([
    fixtures.importCourse('course-one', store, 'account-one'),
    fixtures.importCourse('Synthetic course', store, 'account-two'),
  ]);
  expect(first).toMatchObject({
    originalProjectId: 'course-one',
    courseId: 'course-one',
    title: 'Synthetic course',
    updatedAt: date,
    sha256: inventory.sha256,
  });
  expect(first?.importedProjectId).not.toBe(second?.importedProjectId);
  expect(first?.importedProjectId).not.toBe('course-one');
  expect(
    save.mock.calls.map(call => call[0]).sort((left, right) => left.localeCompare(right))
  ).toEqual(['account-one', 'account-two']);
  for (const [input] of prepareAssets.mock.calls) {
    expect(input.assets).toEqual([{ bytes: assetBytes, ref: assetRef }]);
    expect(input.snapshot.source).toMatchObject({
      file: { data: Buffer.from('synthetic source').toString('base64') },
    });
    expect(input.snapshot.learningPlan?.modules?.[0].children?.[0].annotations).toEqual([
      expect.objectContaining({ id: 'note', note: 'Synthetic annotation' }),
    ]);
  }
  expect(await fixtures.inventory()).toBe(inventory);
});
it('fails missing, empty and ambiguous selections instead of choosing a course', async () => {
  await backup([course('course-one', 'Duplicate'), course('course-two', 'Duplicate')]);
  const fixtures = new CourseFixtures();
  const { store, save } = productImporter();
  await expect(fixtures.importCourse('missing', store, 'user')).rejects.toThrow('missing');
  await expect(fixtures.importCourse('', store, 'user')).rejects.toThrow('required');
  await expect(fixtures.importCourse('Duplicate', store, 'user')).rejects.toThrow('ambiguous');
  expect(save).not.toHaveBeenCalled();
  expect((await fixtures.importCourse('course-two', store, 'user'))?.courseId).toBe('course-two');
});
it.each([
  'unreadable',
  'invalid-manifest',
  'invalid-course',
])('rejects a %s archive', async kind => {
  await backup();
  const path = join(root, 'fixtures', 'nous-library-backup.nous-library.zip');
  if (kind === 'unreadable') await writeFile(path, 'not a ZIP');
  else {
    const zip = await JSZip.loadAsync(await readFile(path));
    if (kind === 'invalid-manifest') zip.file('library.json', '{}');
    else {
      const entry = zip.file('library.json');
      if (!entry) throw new Error('Synthetic manifest missing.');
      const manifest = JSON.parse(await entry.async('string'));
      zip.remove(manifest.projects[0].path);
    }
    await writeFile(path, await zip.generateAsync({ type: 'uint8array' }));
  }
  await expect(new CourseFixtures().inventory()).rejects.toThrow('Cannot decode');
});
it('keeps accounts and projects separate across stories and cleans up when provenance persistence fails', async () => {
  await backup();
  const fetcher = vi.fn(async (_url: string, _options?: RequestInit) =>
    Response.json({ id: crypto.randomUUID() })
  );
  vi.stubGlobal('fetch', fetcher);
  const { save } = productImporter();
  const deleteProject = vi
    .spyOn(PostgresProjectStore.prototype, 'deleteProject')
    .mockResolvedValue();
  const seeded = { ...story, requires: { course: 'fixture:course-one' } };
  const [first, second] = await withFixtureRun(() =>
    Promise.all([prepare(seeded, 'desktop', status), prepare(seeded, 'mobile', status)])
  );
  expect(first.credentials.email).not.toBe(second.credentials.email);
  expect(save.mock.calls[0][0]).not.toBe(save.mock.calls[1][0]);
  expect(first.fixture?.importedProjectId).not.toBe(second.fixture?.importedProjectId);
  await first.cleanup();
  await second.cleanup();
  vi.mocked(PostgresProjectStore.prototype.listProjects).mockImplementation(async () => {
    const call = save.mock.calls.at(-1);
    if (!call) throw new Error('Synthetic import missing.');
    return [buildProjectMeta(call[1])];
  });
  await expect(
    withFixtureRun(
      () => prepare(seeded, 'desktop', status),
      async () => {
        throw new Error('Provenance write failed');
      }
    )
  ).rejects.toThrow('Provenance write failed');
  const failedImport = save.mock.calls.at(-1);
  if (!failedImport) throw new Error('Synthetic import missing.');
  expect(deleteProject).toHaveBeenCalledWith(failedImport[0], failedImport[1].id);
  expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'DELETE' });
});
it('retries with a new run scope after a malformed backup is replaced', async () => {
  await writeFile(join(root, 'fixtures', 'nous-library-backup.nous-library.zip'), 'broken');
  const { store } = productImporter();
  await expect(withFixtureRun(() => importFixture('course-one', store, 'user'))).rejects.toThrow(
    'Cannot decode'
  );
  await backup();
  expect((await withFixtureRun(() => importFixture('course-one', store, 'user'))).courseId).toBe(
    'course-one'
  );
});

it('uses an explicit environment selection for course-bearing stories and accepts titles ending in a file extension', async () => {
  await backup([course('course-one', 'Synthetic.json')]);
  productImporter();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ id: crypto.randomUUID() }))
  );
  vi.stubEnv('NOUS_E2E_COURSE', 'fixture:Synthetic.json');
  await withFixtureRun(async () => {
    const seeded = await prepare(
      { ...story, requires: { course: 'synthetic-short' } },
      'desktop',
      status
    );
    expect(seeded.fixture?.courseId).toBe('course-one');
    await seeded.cleanup();
    const unseeded = await prepare(story, 'mobile', status);
    expect(unseeded.fixture).toBeUndefined();
    await unseeded.cleanup();
  });
});

it('retains legacy ZIP filenames without an extension and JSON snapshots without an original identity', async () => {
  const snapshot = course('legacy-course', 'Synthetic legacy course');
  const archive = await createProjectArchiveBlob(snapshot, { loadAsset: async () => assetBytes });
  await writeFile(
    join(root, 'fixtures', 'legacy-course'),
    new Uint8Array(await archive.arrayBuffer())
  );
  const { store } = productImporter();
  const fixtures = new CourseFixtures();
  expect(await fixtures.importCourse('legacy-course', store, 'user')).toMatchObject({
    originalProjectId: 'legacy-course',
    title: 'Synthetic legacy course',
  });
  const { id: _id, ...withoutId } = syntheticCourse();
  await writeFile(join(root, 'fixtures', 'legacy.json'), JSON.stringify(withoutId));
  expect(await fixtures.importCourse('legacy.json', store, 'user')).toMatchObject({
    originalProjectId: null,
    courseId: null,
    importedProjectId: expect.any(String),
  });
});

it.each([
  'legacy.json',
  'legacy.zip',
  'legacy-course',
])('imports %s independently of an invalid library backup', async filename => {
  const snapshot = course('legacy-course', 'Synthetic legacy course');
  const bytes = filename.endsWith('.json')
    ? JSON.stringify(snapshot)
    : new Uint8Array(
        await (
          await createProjectArchiveBlob(snapshot, { loadAsset: async () => assetBytes })
        ).arrayBuffer()
      );
  await writeFile(join(root, 'fixtures', filename), bytes);
  await writeFile(join(root, 'fixtures', 'nous-library-backup.nous-library.zip'), 'broken');
  const { store } = productImporter();
  const onImport = vi.fn();
  const fixtures = new CourseFixtures(onImport);
  await expect(fixtures.inventory()).rejects.toThrow('Cannot decode');
  const imported = await fixtures.importCourse(filename, store, 'user');
  expect(imported).toMatchObject({
    originalProjectId: 'legacy-course',
    title: 'Synthetic legacy course',
    archivePath: join(root, 'fixtures', filename),
  });
  expect(onImport).toHaveBeenCalledWith(imported);
});

it('resolves an existing legacy file before a same-named library title', async () => {
  await backup([course('library-course', 'legacy.json')]);
  await writeFile(
    join(root, 'fixtures', 'legacy.json'),
    JSON.stringify(course('legacy-course', 'Legacy file'))
  );
  const { store } = productImporter();
  expect(await new CourseFixtures().importCourse('legacy.json', store, 'user')).toMatchObject({
    originalProjectId: 'legacy-course',
    title: 'Legacy file',
  });
});

it('imports exact course titles that exceed the filesystem filename limit', async () => {
  const title = Array.from({ length: 300 }, () => 'a').join('');
  await backup([course('long-title', title)]);
  const statFile = fixtureFiles.stat;
  vi.spyOn(fixtureFiles, 'stat').mockImplementation(async (...args) => {
    if (args[0] === join(root, 'fixtures', title))
      throw Object.assign(new Error('Filename too long'), { code: 'ENAMETOOLONG' });
    return statFile(...args);
  });
  const { store } = productImporter();
  expect(await new CourseFixtures().importCourse(title, store, 'user')).toMatchObject({
    courseId: 'long-title',
    title,
  });
});

it('reports absent historical schema metadata from the archive while importing its migrated snapshot', async () => {
  await backup([course('historical-course', 'Historical course')]);
  const path = join(root, 'fixtures', 'nous-library-backup.nous-library.zip');
  const library = await JSZip.loadAsync(await readFile(path));
  const manifestEntry = library.file('library.json');
  if (!manifestEntry) throw new Error('Synthetic manifest missing.');
  const manifest = JSON.parse(await manifestEntry.async('string'));
  const archivePath = manifest.projects[0].path;
  const entry = library.file(archivePath);
  if (!entry) throw new Error('Synthetic course archive missing.');
  const archive = await JSZip.loadAsync(await entry.async('uint8array'));
  const projectEntry = archive.file('project.json');
  if (!projectEntry) throw new Error('Synthetic project manifest missing.');
  const projectManifest = JSON.parse(await projectEntry.async('string'));
  delete projectManifest.project.projectFormatVersion;
  archive.file('project.json', JSON.stringify(projectManifest));
  library.file(archivePath, await archive.generateAsync({ type: 'uint8array' }), {
    compression: 'STORE',
  });
  await writeFile(path, await library.generateAsync({ type: 'uint8array' }));
  const fixtures = new CourseFixtures();
  expect((await fixtures.inventory()).courses[0]).toMatchObject({
    id: 'historical-course',
    projectFormatVersion: null,
    lessonCount: 1,
  });
  const { store, save } = productImporter();
  await fixtures.importCourse('historical-course', store, 'user');
  expect(save.mock.calls[0][1].projectFormatVersion).toBe(1);
});
