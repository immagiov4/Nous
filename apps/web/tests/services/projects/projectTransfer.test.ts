import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ProjectRepository } from '../../../services/projects/projectRepository.ts';
import { createProjectSnapshot } from '../../../services/projects/projectSnapshot.ts';
import {
  transferFolderToLanRepository,
  transferProjectToLanRepository,
} from '../../../services/projects/projectTransfer.ts';
import type {
  AppState,
  LibraryFolder,
  LibraryPlacement,
  ProjectExportData,
  ProjectId,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../../types.ts';
import { flattenLessons, flattenPathNodes } from '../../../utils/learning/pathNodes.ts';
import { buildLibraryTree } from '../../../utils/library/tree.ts';
import { buildTestLearningPlan, buildTestProjectMeta } from '../../helpers/learningPlan.ts';

class InMemoryProjectRepository implements ProjectRepository {
  private folderCounter = 0;
  folders: LibraryFolder[] = [];
  placements: LibraryPlacement[] = [];
  projects = new Map<ProjectId, ProjectSnapshot>();
  metas = new Map<ProjectId, SavedProjectMeta>();

  createFolder = async ({
    name,
    parentFolderId,
  }: {
    name: string;
    parentFolderId?: string | null;
  }) => {
    const now = new Date().toISOString();
    const folder: LibraryFolder = {
      id: `folder-${++this.folderCounter}`,
      name,
      parentFolderId: parentFolderId ?? null,
      createdAt: now,
      updatedAt: now,
      order: this.folders.length + 1,
    };
    this.folders.push(folder);
    return folder;
  };

  deleteFolder = async (folderId: string) => {
    this.folders = this.folders.filter(folder => folder.id !== folderId);
  };

  listFolders = async () => this.folders;

  listPlacements = async () => this.placements;

  listProjects = async () => Array.from(this.metas.values());

  loadProject = async (id: ProjectId) => this.projects.get(id) || null;

  loadProjectsById = async (ids: ProjectId[]) =>
    ids
      .map(id => this.projects.get(id))
      .filter((snapshot): snapshot is ProjectSnapshot => Boolean(snapshot));

  moveFolder = async () => null;

  moveProjects = async (projectIds: ProjectId[], folderId: string | null) => {
    for (const projectId of projectIds) {
      const existingPlacement = this.placements.find(
        placement => placement.projectId === projectId
      );
      if (existingPlacement) {
        existingPlacement.folderId = folderId;
        continue;
      }

      this.placements.push({
        projectId,
        folderId,
        order: this.placements.length + 1,
        updatedAt: new Date().toISOString(),
      });
    }

    return this.placements.filter(placement => projectIds.includes(placement.projectId));
  };

  renameFolder = async () => null;

  patchProject = async (id: ProjectId, patch: Record<string, unknown>) => {
    const snapshot = this.projects.get(id);
    if (!snapshot) throw new Error(`Not found: ${id}`);
    if (patch.activeSectionId !== undefined)
      snapshot.activeSectionId = patch.activeSectionId as string | null;
    if (patch.state !== undefined) snapshot.state = patch.state as AppState;
    return this.saveProject(snapshot);
  };

  saveProject = async (snapshot: ProjectSnapshot) => {
    this.projects.set(snapshot.id, snapshot);
    const meta: SavedProjectMeta = {
      ...buildTestProjectMeta({
        id: snapshot.id,
        title: snapshot.learningPlan?.title || snapshot.id,
        sourceKind: snapshot.sourceKind,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        lastOpenedAt: snapshot.lastOpenedAt,
        lessonCount: flattenLessons(snapshot.learningPlan?.modules).length,
        completedCount: flattenLessons(snapshot.learningPlan?.modules).filter(
          section => section.isCompleted
        ).length,
        exerciseCount: flattenPathNodes(snapshot.learningPlan?.modules).filter(
          node => node.kind === 'exercise'
        ).length,
        completedExercises: flattenPathNodes(snapshot.learningPlan?.modules).filter(
          node => node.kind === 'exercise' && node.isCompleted
        ).length,
        hasSourceFile: Boolean(snapshot.source),
        coverLabel: flattenLessons(snapshot.learningPlan?.modules).length
          ? `${flattenLessons(snapshot.learningPlan?.modules).length} lezioni`
          : 'Bozza locale',
        syncState: 'local-only',
      }),
    };
    this.metas.set(snapshot.id, meta);
    if (!this.placements.some(placement => placement.projectId === snapshot.id)) {
      this.placements.push({
        projectId: snapshot.id,
        folderId: null,
        order: this.placements.length + 1,
        updatedAt: snapshot.updatedAt,
      });
    }
    return meta;
  };

  deleteProject = async (id: ProjectId) => {
    this.projects.delete(id);
    this.metas.delete(id);
    this.placements = this.placements.filter(placement => placement.projectId !== id);
  };

  importProject = async (): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> => {
    throw new Error('not implemented');
  };

  exportProject = async (): Promise<ProjectExportData | null> => null;

  touchProject = async () => {};
}

const createProjectWithMeta = (id: string, title: string) => {
  const snapshot = createProjectSnapshot({
    id,
    learningPlan: {
      ...buildTestLearningPlan([], { title, summary: '' }),
    },
  });
  const meta: SavedProjectMeta = buildTestProjectMeta({
    id,
    title,
    sourceKind: 'learn-mode',
    createdAt: '2026-03-20T10:00:00.000Z',
    updatedAt: '2026-03-20T10:00:00.000Z',
    lastOpenedAt: '2026-03-20T10:00:00.000Z',
    lessonCount: 0,
    completedCount: 0,
    hasSourceFile: false,
    coverLabel: 'Percorso AI',
  });

  return { meta, snapshot };
};

test('transferProjectToLanRepository copies the project and removes the local copy', async () => {
  const source = new InMemoryProjectRepository();
  const target = new InMemoryProjectRepository();
  const { meta, snapshot } = createProjectWithMeta('project-1', 'Corso 1');
  const parentFolder = await source.createFolder({ name: 'Italiano' });
  await source.saveProject({
    ...snapshot,
    id: 'project-1',
  });
  await source.moveProjects(['project-1'], parentFolder.id);

  const tree = buildLibraryTree({
    folders: await source.listFolders(),
    placements: await source.listPlacements(),
    projects: await source.listProjects(),
  });

  await transferProjectToLanRepository({
    projectId: meta.id,
    sourceRepository: source,
    targetRepository: target,
    tree,
  });

  assert.equal(await source.loadProject('project-1'), null);
  assert.equal((await target.loadProject('project-1')) !== null, true);
  assert.equal(target.placements[0]?.folderId !== null, true);
  assert.equal(target.folders[0]?.name, 'Italiano');
});

test('transferProjectToLanRepository renames copied parent folders on LAN name collision', async () => {
  const source = new InMemoryProjectRepository();
  const target = new InMemoryProjectRepository();
  const { meta, snapshot } = createProjectWithMeta('project-collision', 'Corso collisione');
  const parentFolder = await source.createFolder({ name: 'Italiano' });
  await target.createFolder({ name: 'Italiano' });
  await source.saveProject(snapshot);
  await source.moveProjects(['project-collision'], parentFolder.id);

  const tree = buildLibraryTree({
    folders: await source.listFolders(),
    placements: await source.listPlacements(),
    projects: await source.listProjects(),
  });

  await transferProjectToLanRepository({
    projectId: meta.id,
    sourceRepository: source,
    targetRepository: target,
    tree,
  });

  assert.equal(target.folders[1]?.name, 'Italiano (2)');
});

test('transferProjectToLanRepository keeps the local copy when LAN keeps a different snapshot', async () => {
  const source = new InMemoryProjectRepository();
  const target = new InMemoryProjectRepository();
  const { meta, snapshot } = createProjectWithMeta('project-conflict', 'Corso corretto');
  const conflictingSnapshot = createProjectSnapshot({
    id: 'project-conflict',
    learningPlan: {
      ...buildTestLearningPlan([], { title: 'Corso diverso', summary: '' }),
    },
  });
  await source.saveProject(snapshot);
  await target.saveProject(conflictingSnapshot);
  target.saveProject = async () => target.metas.get('project-conflict') as SavedProjectMeta;

  const tree = buildLibraryTree({
    folders: await source.listFolders(),
    placements: await source.listPlacements(),
    projects: await source.listProjects(),
  });

  await assert.rejects(
    () =>
      transferProjectToLanRepository({
        projectId: meta.id,
        sourceRepository: source,
        targetRepository: target,
        tree,
      }),
    /non ha salvato lo stesso corso/
  );
  assert.equal(
    (await source.loadProject('project-conflict'))?.learningPlan?.title,
    'Corso corretto'
  );
  assert.equal(
    (await target.loadProject('project-conflict'))?.learningPlan?.title,
    'Corso diverso'
  );
});

test('transferFolderToLanRepository copies the whole subtree and clears the source', async () => {
  const source = new InMemoryProjectRepository();
  const target = new InMemoryProjectRepository();
  const rootFolder = await source.createFolder({ name: 'Radice' });
  const nestedFolder = await source.createFolder({ name: 'Sotto', parentFolderId: rootFolder.id });
  const { snapshot } = createProjectWithMeta('project-2', 'Corso 2');
  await source.saveProject({
    ...snapshot,
    id: 'project-2',
  });
  await source.moveProjects(['project-2'], nestedFolder.id);

  const tree = buildLibraryTree({
    folders: await source.listFolders(),
    placements: await source.listPlacements(),
    projects: await source.listProjects(),
  });

  await transferFolderToLanRepository({
    folderId: rootFolder.id,
    sourceRepository: source,
    targetRepository: target,
    tree,
  });

  assert.equal((await source.listFolders()).length, 0);
  assert.equal(await source.loadProject('project-2'), null);
  assert.equal(target.folders.length, 2);
  assert.equal(target.placements[0]?.folderId, 'folder-2');
  assert.equal(target.projects.has('project-2'), true);
});
