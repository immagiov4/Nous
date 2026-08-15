import type {
  LibraryContextRef,
  LibraryFolder,
  LibraryFolderNode,
  LibraryPlacement,
  LibraryProjectNode,
  LibraryTree,
  LibraryTreeNode,
  ProjectId,
  SavedProjectMeta,
} from '../../types.ts';
import { createEntityId } from '../ids.ts';

const compareNumbers = (left: number, right: number) => left - right;

const compareLabels = (left: string, right: string) =>
  left.localeCompare(right, 'it', { sensitivity: 'base' });

const normalizeParentFolderId = (
  folderId: string | null | undefined,
  folderById: Map<string, LibraryFolder>
) => {
  if (!folderId) {
    return null;
  }

  return folderById.has(folderId) ? folderId : null;
};

const sortFolders = (folders: LibraryFolder[]) =>
  folders
    .slice()
    .sort(
      (left, right) =>
        compareNumbers(left.order, right.order) || compareLabels(left.name, right.name)
    );

const sortProjects = (projects: LibraryProjectNode[]) =>
  projects
    .slice()
    .sort(
      (left, right) =>
        compareNumbers(left.order, right.order) ||
        compareLabels(left.project.title, right.project.title)
    );

const sortTreeNodes = (nodes: LibraryTreeNode[]) =>
  nodes.slice().sort((left, right) => {
    if (left.order !== right.order) {
      return compareNumbers(left.order, right.order);
    }

    if (left.kind !== right.kind) {
      return left.kind === 'folder' ? -1 : 1;
    }

    if (left.kind === 'folder' && right.kind === 'folder') {
      return compareLabels(left.folder.name, right.folder.name);
    }

    if (left.kind === 'project' && right.kind === 'project') {
      return compareLabels(left.project.title, right.project.title);
    }

    return 0;
  });

export const createLibraryFolderId = () =>
  createEntityId({ fallbackPrefix: 'folder', uuidPrefix: 'folder' });

export const buildLibraryTree = ({
  folders,
  placements,
  projects,
}: {
  folders: LibraryFolder[];
  placements: LibraryPlacement[];
  projects: SavedProjectMeta[];
}): LibraryTree => {
  const normalizedFolders = sortFolders(folders);
  const folderById = new Map(normalizedFolders.map(folder => [folder.id, folder]));
  const childFoldersByParent = new Map<string | null, LibraryFolder[]>();

  normalizedFolders.forEach(folder => {
    const parentFolderId = normalizeParentFolderId(folder.parentFolderId, folderById);
    const currentChildren = childFoldersByParent.get(parentFolderId) || [];
    currentChildren.push({
      ...folder,
      parentFolderId,
    });
    childFoldersByParent.set(parentFolderId, currentChildren);
  });

  const placementByProjectId = new Map<ProjectId, LibraryPlacement>();
  placements.forEach(placement => {
    placementByProjectId.set(placement.projectId, {
      ...placement,
      folderId: normalizeParentFolderId(placement.folderId, folderById),
    });
  });

  const orderedProjects = projects
    .slice()
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
        compareLabels(left.title, right.title)
    );
  const fallbackProjectOrderById = new Map(
    orderedProjects.map((project, index) => [project.id, (index + 1) * 1024])
  );
  const projectsByFolderId = new Map<string | null, LibraryProjectNode[]>();

  orderedProjects.forEach(project => {
    const placement = placementByProjectId.get(project.id);
    const folderId = normalizeParentFolderId(placement?.folderId, folderById);
    const order = placement?.order ?? fallbackProjectOrderById.get(project.id) ?? 0;
    const currentProjects = projectsByFolderId.get(folderId) || [];
    currentProjects.push({
      id: project.id,
      kind: 'project',
      order,
      project,
    });
    projectsByFolderId.set(folderId, currentProjects);
  });

  const descendantProjectIdsByFolderId = new Map<string, ProjectId[]>();

  const buildFolderNode = (folder: LibraryFolder): LibraryFolderNode => {
    const childFolderNodes = sortFolders(childFoldersByParent.get(folder.id) || []).map(
      buildFolderNode
    );
    const directProjectNodes = sortProjects(projectsByFolderId.get(folder.id) || []);
    const children = sortTreeNodes([...childFolderNodes, ...directProjectNodes]);
    const descendantProjectIds = [
      ...directProjectNodes.map(projectNode => projectNode.id),
      ...childFolderNodes.flatMap(childFolder => childFolder.descendantProjectIds),
    ];

    descendantProjectIdsByFolderId.set(folder.id, descendantProjectIds);

    return {
      id: folder.id,
      kind: 'folder',
      order: folder.order,
      folder,
      children,
      descendantProjectIds,
    };
  };

  const rootNodes = sortTreeNodes([
    ...(sortFolders(childFoldersByParent.get(null) || []).map(buildFolderNode) || []),
    ...sortProjects(projectsByFolderId.get(null) || []),
  ]);

  return {
    descendantProjectIdsByFolderId: Object.fromEntries(descendantProjectIdsByFolderId.entries()),
    folderById: Object.fromEntries(folderById.entries()),
    placementByProjectId: Object.fromEntries(placementByProjectId.entries()) as Record<
      ProjectId,
      LibraryPlacement
    >,
    rootNodes,
  };
};

export const resolveScopedProjectIds = ({
  attachedContextRefs,
  tree,
  allProjectIds,
}: {
  attachedContextRefs: LibraryContextRef[];
  allProjectIds: ProjectId[];
  tree: LibraryTree;
}): ProjectId[] => {
  if (attachedContextRefs.length === 0) {
    return allProjectIds;
  }

  const scopedProjectIds = new Set<ProjectId>();

  attachedContextRefs.forEach(reference => {
    if (reference.kind === 'project') {
      scopedProjectIds.add(reference.id);
      return;
    }

    (tree.descendantProjectIdsByFolderId[reference.id] || []).forEach(projectId => {
      scopedProjectIds.add(projectId);
    });
  });

  return allProjectIds.filter(projectId => scopedProjectIds.has(projectId));
};

export const getFolderPathLabels = (folderId: string, folders: LibraryFolder[]): string[] => {
  const folderById = new Map(folders.map(folder => [folder.id, folder]));
  const pathLabels: string[] = [];
  const visited = new Set<string>();
  let currentFolder = folderById.get(folderId) || null;

  while (currentFolder && !visited.has(currentFolder.id)) {
    pathLabels.unshift(currentFolder.name);
    visited.add(currentFolder.id);
    currentFolder = currentFolder.parentFolderId
      ? folderById.get(currentFolder.parentFolderId) || null
      : null;
  }

  return pathLabels;
};
