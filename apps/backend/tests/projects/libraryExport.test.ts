import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIBRARY_ARCHIVE_FORMAT,
  LIBRARY_ARCHIVE_MANIFEST_PATH,
  LIBRARY_ARCHIVE_VERSION,
} from '@shared/libraryExportContract';
import {
  decodeProjectBackupArchive,
  PROJECT_BACKUP_MAX_ENTRIES,
  PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
} from '@shared/projectBackupArchive';
import JSZip from 'jszip';
import request from 'supertest';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/index.js';
import {
  createLibraryExportApi as createExportApi,
  type LibraryExportApi,
} from '../../src/projects/libraryExport.js';
import { readLibraryExportConfig } from '../../src/projects/libraryExportConfig.js';
import { LibraryExportWorkspace } from '../../src/projects/libraryExportWorkspace.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import { signSupabaseJwt } from '../helpers/auth.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';

import { MemoryLibraryExportRunStore } from '../helpers/memoryLibraryExportRunStore.js';

const userId = 'local-user';
const exportApis = new Set<LibraryExportApi>();
const createLibraryExportApi = (...args: Parameters<typeof createExportApi>) => {
  const api = createExportApi(...args);
  exportApis.add(api);
  return api;
};
const createSnapshot = (id: string): ProjectSnapshot => ({
  activeSectionId: null,
  createdAt: '2026-09-04T00:00:00.000Z',
  id,
  isLearnMode: false,
  lastOpenedAt: '2026-09-04T00:00:00.000Z',
  learningPlan: { sections: [], title: `Corso ${id}` },
  source: null,
  sourceKind: 'document',
  state: 'READING',
  syllabus: [],
  updatedAt: '2026-09-04T00:00:00.000Z',
  userProfile: null,
  version: '4.1',
});

test('stops a pending project read and recovers active and queued users after shutdown', async () => {
  const projectStore = new InMemoryProjectStore();
  const owners = ['before-shutdown', 'queued-first', 'queued-second'];
  for (const owner of owners) await projectStore.saveProject(owner, createSnapshot(owner));
  const runStore = new MemoryLibraryExportRunStore();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const exported: string[] = [];
  const exportProject = projectStore.exportProject.bind(projectStore);
  vi.spyOn(projectStore, 'exportProject').mockImplementation(async (owner, id) => {
    exported.push(owner);
    if (owner === owners[0]) {
      entered.resolve();
      await release.promise;
      throw new Error('Interrupted project read.');
    }
    return exportProject(owner, id);
  });
  const dependencies = {
    archiveWorkspace: new LibraryExportWorkspace(temporaryRoot),
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  };
  const firstProcess = createLibraryExportApi(dependencies);
  const first = await firstProcess.startOrResume(owners[0], 'before-shutdown');
  await entered.promise;
  const second = await firstProcess.startOrResume(owners[1], 'queued-first');
  const third = await firstProcess.startOrResume(owners[2], 'queued-second');
  const closing = firstProcess.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  try {
    await vi.waitFor(() => expect(closed).toBe(true));
  } finally {
    release.resolve();
    await closing;
  }
  expect(exported).toEqual([owners[0]]);
  expect(runStore.runs.get(first.runId)?.status).toBe('running');
  expect(runStore.runs.get(second.runId)?.status).toBe('running');
  vi.mocked(projectStore.exportProject).mockImplementation(async (owner, id) => {
    exported.push(owner);
    return exportProject(owner, id);
  });
  const restarted = createLibraryExportApi(dependencies);
  await restarted.recoverPendingRuns();
  await vi.waitFor(() =>
    expect([first, second, third].map(run => runStore.runs.get(run.runId)?.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ])
  );
  expect(exported).toEqual([owners[0], ...owners]);
});

test('rejects pending and queued admission during shutdown without creating another run', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('retained-project'));
  const runStore = new MemoryLibraryExportRunStore();
  const workspace = new LibraryExportWorkspace(temporaryRoot);
  const config = readLibraryExportConfig({});
  const api = createLibraryExportApi({
    archiveWorkspace: workspace,
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
    config,
  });
  const first = await api.startOrResume(userId, 'first-request');
  await vi.waitFor(() => expect(runStore.runs.get(first.runId)?.status).toBe('completed'));
  runStore.terminalTimes.set(first.runId, Date.now() - config.retentionMs);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cancelExpiredRun = runStore.cancelExpiredRun.bind(runStore);
  vi.spyOn(runStore, 'cancelExpiredRun').mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return cancelExpiredRun(...args);
  });
  const createRun = vi.spyOn(runStore, 'createRun');
  const readSnapshot = vi.spyOn(projectStore, 'readLibraryExportSnapshot');
  const removeRun = vi.spyOn(workspace, 'removeRun');
  const pending = api.startOrResume(userId, 'pending-request');
  const queued = api.startOrResume(userId, 'queued-request');
  let settled: PromiseSettledResult<unknown>[] | undefined;
  const admissions = Promise.allSettled([pending, queued]).then(results => {
    settled = results;
  });
  await entered.promise;
  await api.close();
  try {
    await vi.waitFor(() =>
      expect(settled?.map(result => result.status)).toEqual(['rejected', 'rejected'])
    );
  } finally {
    release.resolve();
    await admissions;
  }
  await expect(api.startOrResume(userId, 'after-shutdown')).rejects.toThrow();
  expect(createRun).not.toHaveBeenCalled();
  expect(readSnapshot).not.toHaveBeenCalled();
  expect(removeRun).not.toHaveBeenCalled();
});

test('starts a fresh library snapshot after the previous completed export expires', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('old-project'));
  const runStore = new MemoryLibraryExportRunStore();
  const config = readLibraryExportConfig({});
  const api = createLibraryExportApi({
    archiveWorkspace: new LibraryExportWorkspace(temporaryRoot),
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
    config,
  });
  const first = await api.startOrResume(userId, 'first-request');
  await vi.waitFor(() => expect(runStore.runs.get(first.runId)?.status).toBe('completed'));
  runStore.terminalTimes.set(first.runId, Date.now() - config.retentionMs);
  await projectStore.saveProject(userId, createSnapshot('new-project'));
  const second = await api.startOrResume(userId, 'fresh-request');
  expect(second.runId).not.toBe(first.runId);
  expect(runStore.runs.get(first.runId)?.status).toBe('cancelled');
  await vi.waitFor(() => expect(runStore.runs.get(second.runId)?.status).toBe('completed'));
  expect(runStore.runs.get(second.runId)?.expectedProjects.map(project => project.id)).toEqual([
    'old-project',
    'new-project',
  ]);
});

test('reclaims completed archives after retention during startup', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('retained-project'));
  const runStore = new MemoryLibraryExportRunStore();
  const workspace = new LibraryExportWorkspace(temporaryRoot);
  const api = createLibraryExportApi({
    archiveWorkspace: workspace,
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  });
  const started = await api.startOrResume(userId, 'retention-request');
  await vi.waitFor(() => expect(runStore.run?.status).toBe('completed'));
  const retentionMs = 24 * 60 * 60_000;
  runStore.terminalTimes.set(started.runId, Date.now() - retentionMs);
  const removeRun = vi.spyOn(workspace, 'removeRun');
  await api.recoverPendingRuns();
  await api.close();
  expect(runStore.run?.status).toBe('cancelled');
  expect(removeRun).toHaveBeenCalledWith(started.runId);
  expect(runStore.cleanupCompleted).toBe(true);
});

let temporaryRoot: string;

const parseBinaryResponse = (
  response: NodeJS.ReadableStream,
  callback: (error: Error | null, body?: Buffer) => void
) => {
  const chunks: Buffer[] = [];
  response.on('data', chunk => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', callback);
};

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-library-export-test-'));
});

afterEach(async () => {
  for (const api of exportApis) await api.close();
  exportApis.clear();
  vi.restoreAllMocks();
  await rm(temporaryRoot, { force: true, recursive: true });
});

test('creates an import-compatible library archive while only one project export is active', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('project-1'));
  await projectStore.saveProject(userId, createSnapshot('project-2'));
  const originalExportProject = projectStore.exportProject.bind(projectStore);
  let activeExports = 0;
  let maximumActiveExports = 0;
  vi.spyOn(projectStore, 'exportProject').mockImplementation(async (...args) => {
    activeExports += 1;
    maximumActiveExports = Math.max(maximumActiveExports, activeExports);
    try {
      return await originalExportProject(...args);
    } finally {
      activeExports -= 1;
    }
  });
  const runStore = new MemoryLibraryExportRunStore();
  const workspace = new LibraryExportWorkspace(temporaryRoot);
  const api = createLibraryExportApi({
    archiveWorkspace: workspace,
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  });

  const started = await api.startOrResume(userId, '550e8400-e29b-41d4-a716-446655440000');
  await vi.waitFor(async () => {
    expect((await api.getStatus(userId, started.runId))?.status).toBe('completed');
  });

  const downloadToken = await api.createDownloadAccess(userId, started.runId);
  if (!downloadToken) throw new Error('Library download token is missing.');
  const download = await api.getDownload(started.runId, downloadToken);
  expect(download).not.toBeNull();
  expect(await api.getDownload(started.runId, downloadToken)).toBeNull();
  expect(maximumActiveExports).toBe(1);
  const archive = await JSZip.loadAsync(await readFile(download?.archivePath ?? ''));
  const manifestEntry = archive.file(LIBRARY_ARCHIVE_MANIFEST_PATH);
  if (!manifestEntry) throw new Error('Library archive manifest is missing.');
  const manifest = JSON.parse(await manifestEntry.async('string')) as {
    archiveVersion: number;
    format: string;
    projects: Array<{ id: string; path: string }>;
  };
  expect(manifest).toMatchObject({
    archiveVersion: LIBRARY_ARCHIVE_VERSION,
    format: LIBRARY_ARCHIVE_FORMAT,
  });
  expect(manifest.projects.map(project => project.id)).toEqual(['project-1', 'project-2']);
  expect(manifest.projects.every(project => !('revision' in project))).toBe(true);
  expect(manifest.projects.every(project => !('incarnationId' in project))).toBe(true);
  expect(manifest.projects.every(project => archive.file(project.path) !== null)).toBe(true);
  for (const project of manifest.projects) {
    const entry = archive.file(project.path);
    if (!entry) throw new Error(`Project archive ${project.path} is missing.`);
    const decoded = await decodeProjectBackupArchive(await entry.async('uint8array'), {
      invalidArchiveMessage: 'Invalid project archive.',
      maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
      maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
      maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
    });
    expect(decoded.project.id).toBe(project.id);
  }
  expect(projectStore.exportProject).toHaveBeenCalledTimes(2);
});

test.each([
  1, 2,
])('admits distinct users with %i slots without treating queued polling as an interruption', async capacity => {
  const projectStore = new InMemoryProjectStore();
  const owners = ['first-user', 'second-user', 'third-user'];
  for (const owner of owners) await projectStore.saveProject(owner, createSnapshot(owner));
  const runStore = new MemoryLibraryExportRunStore();
  const originalExport = projectStore.exportProject.bind(projectStore);
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const exported: string[] = [];
  vi.spyOn(projectStore, 'exportProject').mockImplementation(async (owner, id) => {
    exported.push(owner);
    if (owners.indexOf(owner) < capacity) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    return originalExport(owner, id);
  });
  const api = createLibraryExportApi({
    config: { ...readLibraryExportConfig({}), executionsGlobal: capacity },
    archiveWorkspace: new LibraryExportWorkspace(temporaryRoot),
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  });
  const first = await api.startOrResume(owners[0], 'first-request');
  await firstStarted.promise;
  const second = await api.startOrResume(owners[1], 'second-request');
  const third = await api.startOrResume(owners[2], 'third-request');
  const markFailed = vi.spyOn(runStore, 'markFailed');
  const queued = await api.getStatus(owners[1], second.runId);
  await api.startOrResume(owners[1], 'duplicate-request');
  try {
    expect(exported).toEqual(owners.slice(0, capacity));
    expect(queued).toMatchObject({ status: 'running', completedProjectCount: 0 });
    expect(markFailed).not.toHaveBeenCalled();
  } finally {
    releaseFirst.resolve();
    await vi.waitFor(() =>
      expect([first, second, third].map(run => runStore.runs.get(run.runId)?.status)).toEqual([
        'completed',
        'completed',
        'completed',
      ])
    );
  }
  expect(exported).toEqual(owners);
});

test('resumes from a durable project checkpoint after an interrupted process', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('project-1'));
  await projectStore.saveProject(userId, createSnapshot('project-2'));
  const originalExportProject = projectStore.exportProject.bind(projectStore);
  const callsByProject = new Map<string, number>();
  let failSecondProject = true;
  vi.spyOn(projectStore, 'exportProject').mockImplementation(async (requestUserId, projectId) => {
    callsByProject.set(projectId, (callsByProject.get(projectId) ?? 0) + 1);
    if (projectId === 'project-2' && failSecondProject) {
      failSecondProject = false;
      throw new Error('simulated process stop');
    }
    return originalExportProject(requestUserId, projectId);
  });
  const runStore = new MemoryLibraryExportRunStore();
  const dependencies = {
    archiveWorkspace: new LibraryExportWorkspace(temporaryRoot),
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  };
  const firstProcess = createLibraryExportApi(dependencies);
  const started = await firstProcess.startOrResume(userId, '550e8400-e29b-41d4-a716-446655440000');
  await vi.waitFor(async () => {
    expect((await firstProcess.getStatus(userId, started.runId))?.status).toBe('failed');
  });
  expect(runStore.run?.checkpoints.map(checkpoint => checkpoint.projectId)).toEqual(['project-1']);
  await runStore.markRunning(started.runId, 'project-archive', 'project-2');

  const restartedProcess = createLibraryExportApi(dependencies);
  await restartedProcess.recoverPendingRuns();
  await vi.waitFor(async () => {
    expect((await restartedProcess.getStatus(userId, started.runId))?.status).toBe('completed');
  });

  expect(callsByProject.get('project-1')).toBe(1);
  expect(callsByProject.get('project-2')).toBe(2);
  expect(runStore.run?.checkpoints).toHaveLength(2);
  expect(runStore.run?.errorCode).toBe('LIBRARY_EXPORT_PROCESS_INTERRUPTED');
});

test('replaces a failed run when a checkpointed project revision changed', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('project-1'));
  await projectStore.saveProject(userId, createSnapshot('project-2'));
  const originalExportProject = projectStore.exportProject.bind(projectStore);
  const callsByProject = new Map<string, number>();
  let failSecondProject = true;
  vi.spyOn(projectStore, 'exportProject').mockImplementation(async (requestUserId, projectId) => {
    callsByProject.set(projectId, (callsByProject.get(projectId) ?? 0) + 1);
    if (projectId === 'project-2' && failSecondProject) {
      failSecondProject = false;
      throw new Error('simulated process stop');
    }
    return originalExportProject(requestUserId, projectId);
  });
  const runStore = new MemoryLibraryExportRunStore();
  const dependencies = {
    archiveWorkspace: new LibraryExportWorkspace(temporaryRoot),
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  };
  const firstProcess = createLibraryExportApi(dependencies);
  const failedRun = await firstProcess.startOrResume(
    userId,
    '550e8400-e29b-41d4-a716-446655440000'
  );
  await vi.waitFor(async () => {
    expect((await firstProcess.getStatus(userId, failedRun.runId))?.status).toBe('failed');
  });
  expect(runStore.run?.checkpoints).toEqual([
    expect.objectContaining({
      projectId: 'project-1',
      projectIncarnationId: expect.any(String),
      projectRevision: 1,
    }),
  ]);

  await projectStore.saveProject(userId, {
    ...createSnapshot('project-1'),
    updatedAt: '2026-09-04T01:00:00.000Z',
  });
  const markCancelled = vi.spyOn(runStore, 'markCancelled');
  const restartedProcess = createLibraryExportApi(dependencies);
  const replacementRun = await restartedProcess.startOrResume(
    userId,
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
  );

  expect(replacementRun.runId).not.toBe(failedRun.runId);
  await vi.waitFor(async () => {
    expect((await restartedProcess.getStatus(userId, replacementRun.runId))?.status).toBe(
      'completed'
    );
  });
  expect(markCancelled).toHaveBeenCalledWith(
    failedRun.runId,
    expect.objectContaining({ code: 'LIBRARY_EXPORT_EXPECTED_PROJECT_CHANGED' })
  );
  expect(callsByProject.get('project-1')).toBe(2);
  expect(runStore.run?.checkpoints).toEqual([
    expect.objectContaining({
      projectId: 'project-1',
      projectIncarnationId: expect.any(String),
      projectRevision: 2,
    }),
    expect.objectContaining({
      projectId: 'project-2',
      projectIncarnationId: expect.any(String),
      projectRevision: 1,
    }),
  ]);
});

test('replaces a failed run when a checkpointed project cover changed', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('project-1'));
  await projectStore.saveProject(userId, createSnapshot('project-2'));
  const oldCover = {
    data: Buffer.from('old cover').toString('base64'),
    mimeType: 'image/png' as const,
    name: 'old-cover.png',
  };
  const newCover = {
    data: Buffer.from('new cover').toString('base64'),
    mimeType: 'image/png' as const,
    name: 'new-cover.png',
  };
  await projectStore.saveProjectCover(userId, 'project-1', oldCover);
  const originalExportProject = projectStore.exportProject.bind(projectStore);
  let failSecondProject = true;
  vi.spyOn(projectStore, 'exportProject').mockImplementation(async (requestUserId, projectId) => {
    if (projectId === 'project-2' && failSecondProject) {
      failSecondProject = false;
      throw new Error('simulated process stop');
    }
    return originalExportProject(requestUserId, projectId);
  });
  const runStore = new MemoryLibraryExportRunStore();
  const workspace = new LibraryExportWorkspace(temporaryRoot);
  const dependencies = {
    archiveWorkspace: workspace,
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  };
  const firstProcess = createLibraryExportApi(dependencies);
  const failedRun = await firstProcess.startOrResume(
    userId,
    '550e8400-e29b-41d4-a716-446655440000'
  );
  await vi.waitFor(async () => {
    expect((await firstProcess.getStatus(userId, failedRun.runId))?.status).toBe('failed');
  });
  expect(runStore.run?.checkpoints).toEqual([
    expect.objectContaining({ projectId: 'project-1', projectRevision: 2 }),
  ]);

  const savedCoverMeta = await projectStore.saveProjectCover(userId, 'project-1', newCover);
  expect(savedCoverMeta?.revision).toBe(3);
  const markCancelled = vi.spyOn(runStore, 'markCancelled');
  const restartedProcess = createLibraryExportApi(dependencies);
  const replacementRun = await restartedProcess.startOrResume(
    userId,
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
  );

  expect(replacementRun.runId).not.toBe(failedRun.runId);
  await vi.waitFor(async () => {
    expect((await restartedProcess.getStatus(userId, replacementRun.runId))?.status).toBe(
      'completed'
    );
  });
  expect(markCancelled).toHaveBeenCalledWith(
    failedRun.runId,
    expect.objectContaining({ code: 'LIBRARY_EXPORT_EXPECTED_PROJECT_CHANGED' })
  );
  const replacementProject = runStore.run?.expectedProjects.find(
    project => project.id === 'project-1'
  );
  expect(replacementProject).toMatchObject({ revision: 3 });

  const archive = await JSZip.loadAsync(
    await readFile(workspace.getLibraryArchivePath(replacementRun.runId))
  );
  const projectEntry = replacementProject ? archive.file(replacementProject.path) : null;
  if (!projectEntry) throw new Error('Project archive with the new cover is missing.');
  const decoded = await decodeProjectBackupArchive(await projectEntry.async('uint8array'), {
    invalidArchiveMessage: 'Invalid project archive.',
    maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
    maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
    maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
  });
  expect(decoded.cover).toEqual(newCover);
});

test('replaces a failed run when a project is deleted and recreated with the same id', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('project-1'));
  await projectStore.saveProject(userId, createSnapshot('project-2'));
  const originalExportProject = projectStore.exportProject.bind(projectStore);
  let failSecondProject = true;
  vi.spyOn(projectStore, 'exportProject').mockImplementation(async (requestUserId, projectId) => {
    if (projectId === 'project-2' && failSecondProject) {
      failSecondProject = false;
      throw new Error('simulated process stop');
    }
    return originalExportProject(requestUserId, projectId);
  });
  const runStore = new MemoryLibraryExportRunStore();
  const workspace = new LibraryExportWorkspace(temporaryRoot);
  const dependencies = {
    archiveWorkspace: workspace,
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  };
  const firstProcess = createLibraryExportApi(dependencies);
  const failedRun = await firstProcess.startOrResume(
    userId,
    '550e8400-e29b-41d4-a716-446655440000'
  );
  await vi.waitFor(async () => {
    expect((await firstProcess.getStatus(userId, failedRun.runId))?.status).toBe('failed');
  });
  const originalIncarnationId = runStore.run?.expectedProjects.find(
    project => project.id === 'project-1'
  )?.incarnationId;

  await projectStore.deleteProject(userId, 'project-1');
  await projectStore.saveProject(userId, {
    ...createSnapshot('project-1'),
    title: 'Corso ricreato con contenuto nuovo',
  });
  const markCancelled = vi.spyOn(runStore, 'markCancelled');
  const restartedProcess = createLibraryExportApi(dependencies);
  const replacementRun = await restartedProcess.startOrResume(
    userId,
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
  );

  expect(replacementRun.runId).not.toBe(failedRun.runId);
  await vi.waitFor(async () => {
    expect((await restartedProcess.getStatus(userId, replacementRun.runId))?.status).toBe(
      'completed'
    );
  });
  expect(markCancelled).toHaveBeenCalledWith(
    failedRun.runId,
    expect.objectContaining({ code: 'LIBRARY_EXPORT_EXPECTED_PROJECT_CHANGED' })
  );
  const replacementProject = runStore.run?.expectedProjects.find(
    project => project.id === 'project-1'
  );
  expect(replacementProject).toMatchObject({ revision: 1 });
  expect(replacementProject?.incarnationId).not.toBe(originalIncarnationId);

  const archive = await JSZip.loadAsync(
    await readFile(workspace.getLibraryArchivePath(replacementRun.runId))
  );
  const projectEntry = replacementProject ? archive.file(replacementProject.path) : null;
  if (!projectEntry) throw new Error('Recreated project archive is missing.');
  const decoded = await decodeProjectBackupArchive(await projectEntry.async('uint8array'), {
    invalidArchiveMessage: 'Invalid project archive.',
    maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
    maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
    maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
  });
  expect(decoded.project.title).toBe('Corso ricreato con contenuto nuovo');
});

test('cancels a pre-identity run instead of restarting it', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('legacy-project'));
  const exportProject = vi.spyOn(projectStore, 'exportProject');
  const runStore = new MemoryLibraryExportRunStore();
  const legacyRunId = '550e8400-e29b-41d4-a716-446655440000';
  runStore.run = {
    bytesWritten: 0,
    checkpoints: [],
    correlationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    expectedProjects: [
      {
        id: 'legacy-project',
        path: 'projects/legacy-project.nous.zip',
        title: 'Corso precedente alla migrazione',
      },
    ],
    folders: [],
    id: legacyRunId,
    phase: 'project-archive',
    placements: [
      {
        folderId: null,
        order: 0,
        projectId: 'legacy-project',
        updatedAt: '2026-09-04T00:00:00.000Z',
      },
    ],
    status: 'running',
    userId,
  };
  const markCancelled = vi.spyOn(runStore, 'markCancelled');
  const api = createLibraryExportApi({
    archiveWorkspace: new LibraryExportWorkspace(temporaryRoot),
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  });

  await api.recoverPendingRuns();

  expect(exportProject).not.toHaveBeenCalled();
  expect(markCancelled).toHaveBeenCalledWith(
    legacyRunId,
    expect.objectContaining({ code: 'LIBRARY_EXPORT_LEGACY_RUN_UNRESUMABLE' })
  );
  expect(runStore.run?.status).toBe('cancelled');

  const replacement = await api.startOrResume(userId, '92b5e8d4-8384-4d25-8745-728e2ad0f02f');
  expect(replacement.runId).not.toBe(legacyRunId);
  await vi.waitFor(async () => {
    expect((await api.getStatus(userId, replacement.runId))?.status).toBe('completed');
  });
});

test('refuses finalization when a project changes after archive verification', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('project-1'));
  await projectStore.saveProject(userId, createSnapshot('project-2'));
  const runStore = new MemoryLibraryExportRunStore();
  const workspace = new LibraryExportWorkspace(temporaryRoot);
  const createLibraryArchive = vi.spyOn(workspace, 'createLibraryArchive');
  const originalVerifyLibraryArchive = workspace.verifyLibraryArchive.bind(workspace);
  vi.spyOn(workspace, 'verifyLibraryArchive').mockImplementation(async (...args) => {
    const matches = await originalVerifyLibraryArchive(...args);
    await projectStore.saveProject(userId, {
      ...createSnapshot('project-1'),
      updatedAt: '2026-09-04T01:00:00.000Z',
    });
    return matches;
  });
  const markCompleted = vi.spyOn(runStore, 'markCompleted');
  const api = createLibraryExportApi({
    archiveWorkspace: workspace,
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  });

  const started = await api.startOrResume(userId, '550e8400-e29b-41d4-a716-446655440000');
  await vi.waitFor(async () => {
    expect((await api.getStatus(userId, started.runId))?.status).toBe('failed');
  });

  expect(runStore.run?.checkpoints).toHaveLength(2);
  expect(createLibraryArchive).toHaveBeenCalledOnce();
  expect(markCompleted).not.toHaveBeenCalled();
});

test('cancels an irrecoverable failed run before exporting the current library', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('project-1'));
  await projectStore.saveProject(userId, createSnapshot('project-2'));
  const originalExportProject = projectStore.exportProject.bind(projectStore);
  vi.spyOn(projectStore, 'exportProject').mockImplementation(async (requestUserId, projectId) => {
    if (projectId === 'project-2') throw new Error('simulated unavailable project');
    return originalExportProject(requestUserId, projectId);
  });
  const runStore = new MemoryLibraryExportRunStore();
  const workspace = new LibraryExportWorkspace(temporaryRoot);
  const dependencies = {
    archiveWorkspace: workspace,
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  };
  const firstProcess = createLibraryExportApi(dependencies);
  const failedRun = await firstProcess.startOrResume(
    userId,
    '550e8400-e29b-41d4-a716-446655440000'
  );
  await vi.waitFor(async () => {
    expect((await firstProcess.getStatus(userId, failedRun.runId))?.status).toBe('failed');
  });
  await projectStore.deleteProject(userId, 'project-2');
  const markCancelled = vi.spyOn(runStore, 'markCancelled');

  const restartedProcess = createLibraryExportApi(dependencies);
  const replacementRun = await restartedProcess.startOrResume(
    userId,
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
  );
  expect(replacementRun.runId).not.toBe(failedRun.runId);
  await vi.waitFor(async () => {
    expect((await restartedProcess.getStatus(userId, replacementRun.runId))?.status).toBe(
      'completed'
    );
  });
  expect(markCancelled).toHaveBeenCalledWith(
    failedRun.runId,
    expect.objectContaining({ code: 'LIBRARY_EXPORT_EXPECTED_PROJECT_UNAVAILABLE' })
  );
  expect(runStore.run?.expectedProjects.map(project => project.id)).toEqual(['project-1']);
});

test('serves only the completed backend archive through the library export routes', async () => {
  const projectStore = new InMemoryProjectStore();
  await projectStore.saveProject(userId, createSnapshot('route-project'));
  const runStore = new MemoryLibraryExportRunStore();
  const getRun = vi.spyOn(runStore, 'getRun');
  const getRunProgress = vi.spyOn(runStore, 'getRunProgress');
  const api = createLibraryExportApi({
    archiveWorkspace: new LibraryExportWorkspace(temporaryRoot),
    assetReader: { readActive: () => Promise.reject(new Error('Unexpected asset read.')) },
    projectStore,
    runStore,
  });
  const app = createApp({ libraryExportApi: api });

  const startResponse = await request(app).post('/api/projects/library-exports');
  expect(startResponse.status).toBe(202);
  const runId = startResponse.body.run.runId as string;
  await vi.waitFor(async () => {
    const statusResponse = await request(app).get(`/api/projects/library-exports/${runId}`);
    expect(statusResponse.body.run).toMatchObject({
      completedProjectCount: 1,
      projectCount: 1,
      status: 'completed',
    });
  });
  getRun.mockClear();
  getRunProgress.mockClear();
  const completedStatusResponse = await request(app).get(`/api/projects/library-exports/${runId}`);
  expect(completedStatusResponse.status).toBe(200);
  expect(getRunProgress).toHaveBeenCalledWith(userId, runId);
  expect(getRun).not.toHaveBeenCalled();

  const downloadAccess = await api.createDownloadAccess(userId, runId);
  if (!downloadAccess) throw new Error('Library download token is missing.');
  const downloadResponse = await request(app)
    .post(`/api/projects/library-exports/${runId}/download`)
    .type('form')
    .send({ downloadToken: downloadAccess })
    .buffer(true)
    .parse(parseBinaryResponse);
  expect(downloadResponse.status).toBe(200);
  expect(downloadResponse.headers['content-type']).toContain('application/zip');
  const archive = await JSZip.loadAsync(downloadResponse.body as Buffer);
  expect(archive.file(LIBRARY_ARCHIVE_MANIFEST_PATH)).not.toBeNull();
  await vi.waitFor(async () => {
    expect((await api.getStatus(userId, runId))?.status).toBe('downloaded');
  });
  expect(await api.createDownloadAccess(userId, runId)).toBeNull();
  await vi.waitFor(() => expect(runStore.cleanupCompleted).toBe(true));
});

test('authorizes a native cross-origin download with a one-time form token', async () => {
  const previousAuthMode = process.env.AUTH_MODE;
  const previousJwtSecret = process.env.SUPABASE_JWT_SECRET;
  const previousSupabaseUrl = process.env.SUPABASE_URL;
  process.env.AUTH_MODE = 'supabase';
  process.env.SUPABASE_JWT_SECRET = 'library-export-test-secret';
  process.env.SUPABASE_URL = 'http://supabase.test';
  const runId = '3207883a-862a-447f-b9ed-6148effeb8ea';
  const archivePath = join(temporaryRoot, 'native-download.zip');
  await writeFile(archivePath, 'native archive');
  const finishDownload = vi.fn(() => Promise.resolve());
  const progress = {
    archiveBytes: 14,
    bytesWritten: 14,
    completedProjectCount: 1,
    correlationId: '98de2539-25d9-497a-b612-49fa7813cb50',
    phase: 'ready' as const,
    projectCount: 1,
    runId,
    status: 'completed' as const,
  };
  const api: LibraryExportApi = {
    close: vi.fn(() => Promise.resolve()),
    createDownloadAccess: vi.fn(async () => 'one-time-download-token'),
    getDownload: vi.fn(async () => ({
      archiveBytes: 14,
      archivePath,
      filename: 'nous-library-backup.nous-library.zip',
      finish: finishDownload,
      userId,
    })),
    getStatus: vi.fn(async () => progress),
    recoverPendingRuns: vi.fn(() => Promise.resolve()),
    startOrResume: vi.fn(async () => progress),
  };
  const accessToken = signSupabaseJwt(
    {
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: 'http://supabase.test/auth/v1',
      sub: userId,
    },
    'library-export-test-secret'
  );

  try {
    const app = createApp({ libraryExportApi: api });
    const accessResponse = await request(app)
      .post(`/api/projects/library-exports/${runId}/download-access`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(accessResponse.status).toBe(200);
    expect(accessResponse.body).toEqual({
      downloadToken: 'one-time-download-token',
      success: true,
    });

    const downloadResponse = await request(app)
      .post(`/api/projects/library-exports/${runId}/download`)
      .type('form')
      .send({ downloadToken: 'one-time-download-token' })
      .buffer(true)
      .parse(parseBinaryResponse);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.body.toString()).toBe('native archive');
    expect(api.getDownload).toHaveBeenCalledWith(runId, 'one-time-download-token');
    await vi.waitFor(() => expect(finishDownload).toHaveBeenCalledWith(true));
  } finally {
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
    if (previousJwtSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = previousJwtSecret;
    if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousSupabaseUrl;
  }
});
