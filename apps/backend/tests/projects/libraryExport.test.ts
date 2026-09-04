import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIBRARY_ARCHIVE_FORMAT,
  LIBRARY_ARCHIVE_MANIFEST_PATH,
  LIBRARY_ARCHIVE_VERSION,
  type LibraryExportPhase,
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
import { createLibraryExportApi, type LibraryExportApi } from '../../src/projects/libraryExport.js';
import type {
  LibraryExportProjectCheckpoint,
  LibraryExportRunRecord,
  LibraryExportRunStore,
} from '../../src/projects/libraryExportRunStore.js';
import { LibraryExportWorkspace } from '../../src/projects/libraryExportWorkspace.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import { signSupabaseJwt } from '../helpers/auth.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';

class MemoryLibraryExportRunStore implements LibraryExportRunStore {
  cleanupCompleted = false;
  downloadTokenSha256: string | null = null;
  run: LibraryExportRunRecord | null = null;

  async createRun(input: Omit<LibraryExportRunRecord, 'checkpoints'>) {
    if (
      this.run?.userId === input.userId &&
      this.run.status !== 'cancelled' &&
      this.run.status !== 'downloaded'
    ) {
      return structuredClone(this.run);
    }
    this.cleanupCompleted = false;
    this.downloadTokenSha256 = null;
    this.run = structuredClone({ ...input, checkpoints: [] });
    return structuredClone(this.run);
  }

  async findUndeliveredRun(userId: string) {
    return this.run?.userId === userId &&
      this.run.status !== 'cancelled' &&
      this.run.status !== 'downloaded'
      ? structuredClone(this.run)
      : null;
  }

  async getRun(userId: string, runId: string) {
    return this.run?.userId === userId && this.run.id === runId ? structuredClone(this.run) : null;
  }

  async authorizeDownload(userId: string, runId: string, tokenSha256: string) {
    if (this.run?.userId !== userId || this.run.id !== runId || this.run.status !== 'completed') {
      return false;
    }
    this.downloadTokenSha256 = tokenSha256;
    return true;
  }

  async claimDownload(runId: string, tokenSha256: string) {
    if (
      this.run?.id !== runId ||
      this.run.status !== 'completed' ||
      this.downloadTokenSha256 !== tokenSha256
    ) {
      return null;
    }
    this.downloadTokenSha256 = null;
    return structuredClone(this.run);
  }

  async listPendingCleanupRunIds() {
    return this.run?.status === 'downloaded' && !this.cleanupCompleted ? [this.run.id] : [];
  }

  async listRunningRuns() {
    return this.run?.status === 'running' ? [structuredClone(this.run)] : [];
  }

  async markRunning(runId: string, phase: LibraryExportPhase, currentProjectId?: string) {
    if (!this.run || this.run.id !== runId) throw new Error('Run not found.');
    this.run.status = 'running';
    this.run.phase = phase;
    this.run.currentProjectId = currentProjectId;
  }

  async checkpointProject(runId: string, checkpoint: LibraryExportProjectCheckpoint) {
    if (!this.run || this.run.id !== runId) throw new Error('Run not found.');
    this.run.checkpoints = [
      ...this.run.checkpoints.filter(entry => entry.projectId !== checkpoint.projectId),
      structuredClone(checkpoint),
    ];
    this.run.bytesWritten = this.run.checkpoints.reduce(
      (total, entry) => total + entry.archiveBytes,
      0
    );
  }

  async markCompleted(runId: string, archive: { bytes: number; sha256: string }) {
    if (!this.run || this.run.id !== runId) throw new Error('Run not found.');
    this.run.status = 'completed';
    this.run.phase = 'ready';
    this.run.currentProjectId = undefined;
    this.run.archiveBytes = archive.bytes;
    this.run.archiveSha256 = archive.sha256;
  }

  async markCancelled(
    runId: string,
    error: { code: string; detail: string; phase: LibraryExportPhase }
  ) {
    if (!this.run || this.run.id !== runId) throw new Error('Run not found.');
    this.run.status = 'cancelled';
    this.run.phase = 'failed';
    this.run.errorCode = error.code;
    this.run.errorDetail = error.detail;
    this.run.errorPhase = error.phase;
  }

  async markDownloaded(runId: string) {
    if (!this.run || this.run.id !== runId) throw new Error('Run not found.');
    this.run.status = 'downloaded';
    this.downloadTokenSha256 = null;
  }

  async markCleanupCompleted(runId: string) {
    if (!this.run || this.run.id !== runId) throw new Error('Run not found.');
    this.cleanupCompleted = true;
  }

  async markFailed(
    runId: string,
    error: { code: string; detail: string; phase: LibraryExportPhase }
  ) {
    if (!this.run || this.run.id !== runId) throw new Error('Run not found.');
    this.run.status = 'failed';
    this.run.phase = 'failed';
    this.run.errorCode = error.code;
    this.run.errorDetail = error.detail;
    this.run.errorPhase = error.phase;
    this.downloadTokenSha256 = null;
  }
}

const userId = 'local-user';
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
  const completeDownload = vi.fn(() => Promise.resolve());
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
    completeDownload,
    createDownloadAccess: vi.fn(async () => 'one-time-download-token'),
    getDownload: vi.fn(async () => ({
      archiveBytes: 14,
      archivePath,
      filename: 'nous-library-backup.nous-library.zip',
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
    await vi.waitFor(() => expect(completeDownload).toHaveBeenCalledWith(userId, runId));
  } finally {
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previousAuthMode;
    if (previousJwtSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = previousJwtSecret;
    if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousSupabaseUrl;
  }
});
