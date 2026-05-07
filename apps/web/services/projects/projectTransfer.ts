import type {
  LibraryFolderNode,
  LibraryTree,
  LibraryTreeNode,
  ProjectId,
  ProjectSnapshot,
} from '../../types.ts';
import { resolveAvailableFolderName } from '../../utils/library/folderNames.ts';
import { buildPersistenceSignature } from './persistenceSignature.ts';
import type { ProjectRepository } from './projectRepository.ts';
import { ProjectStorageError } from './projectRepository.ts';

const PROJECT_TRANSFER_ERROR_MESSAGE =
  'Impossibile spostare il contenuto in LAN. Verifica che il backend sia raggiungibile.';

const createTransferError = (message = PROJECT_TRANSFER_ERROR_MESSAGE) =>
  new ProjectStorageError(message, 'persistence-failed');

const assertTransferredSnapshotMatchesSource = async (
  projectId: ProjectId,
  snapshot: ProjectSnapshot,
  targetRepository: ProjectRepository
) => {
  const targetSnapshot = await targetRepository.loadProject(projectId);

  if (
    !snapshot ||
    !targetSnapshot ||
    buildPersistenceSignature(targetSnapshot) !== buildPersistenceSignature(snapshot)
  ) {
    throw createTransferError(
      'Il trasferimento LAN non ha salvato lo stesso corso nel repository di destinazione. Il corso locale e stato conservato.'
    );
  }
};

const findFolderNode = (nodes: LibraryTreeNode[], folderId: string): LibraryFolderNode | null => {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      if (node.id === folderId) {
        return node;
      }

      const nestedNode = findFolderNode(node.children, folderId);
      if (nestedNode) {
        return nestedNode;
      }
    }
  }

  return null;
};

const getFolderTargetIdMap = async (
  folderId: string | null,
  targetRepository: ProjectRepository,
  tree: LibraryTree,
  folderTargetIdBySourceId: Map<string, string>
): Promise<string | null> => {
  if (!folderId) {
    return null;
  }

  const cachedTargetId = folderTargetIdBySourceId.get(folderId);
  if (cachedTargetId) {
    return cachedTargetId;
  }

  const sourceFolder = tree.folderById[folderId];
  if (!sourceFolder) {
    throw createTransferError('La cartella di origine non e stata trovata.');
  }

  const targetParentId = await getFolderTargetIdMap(
    sourceFolder.parentFolderId,
    targetRepository,
    tree,
    folderTargetIdBySourceId
  );
  const targetFolders = await targetRepository.listFolders();
  const clonedFolder = await targetRepository.createFolder({
    name: resolveAvailableFolderName(sourceFolder.name, targetFolders, targetParentId),
    parentFolderId: targetParentId,
  });
  folderTargetIdBySourceId.set(folderId, clonedFolder.id);
  return clonedFolder.id;
};

const copyProjectToTargetRepository = async ({
  projectId,
  sourceRepository,
  targetRepository,
  targetFolderId,
}: {
  projectId: ProjectId;
  sourceRepository: ProjectRepository;
  targetRepository: ProjectRepository;
  targetFolderId: string | null;
}) => {
  const snapshot = await sourceRepository.loadProject(projectId);
  if (!snapshot) {
    throw createTransferError('Il corso da spostare non e stato trovato.');
  }

  await targetRepository.saveProject(snapshot);
  await assertTransferredSnapshotMatchesSource(projectId, snapshot, targetRepository);
  if (targetFolderId !== null) {
    await targetRepository.moveProjects([projectId], targetFolderId);
  }
};

const collectFolderDeletionOrder = (folderNode: LibraryFolderNode) => {
  const projectIds: ProjectId[] = [];
  const folderIds: string[] = [];

  const walk = (node: LibraryFolderNode) => {
    for (const child of node.children) {
      if (child.kind === 'folder') {
        walk(child);
        folderIds.push(child.id);
        continue;
      }

      projectIds.push(child.id);
    }
  };

  walk(folderNode);
  folderIds.push(folderNode.id);

  return { folderIds, projectIds };
};

const copyFolderSubtreeToTargetRepository = async ({
  folderNode,
  sourceRepository,
  targetRepository,
  parentTargetFolderId,
  folderTargetIdBySourceId,
}: {
  folderNode: LibraryFolderNode;
  folderTargetIdBySourceId: Map<string, string>;
  parentTargetFolderId: string | null;
  sourceRepository: ProjectRepository;
  targetRepository: ProjectRepository;
}) => {
  const targetFolders = await targetRepository.listFolders();
  const clonedFolder = await targetRepository.createFolder({
    name: resolveAvailableFolderName(folderNode.folder.name, targetFolders, parentTargetFolderId),
    parentFolderId: parentTargetFolderId,
  });
  folderTargetIdBySourceId.set(folderNode.id, clonedFolder.id);

  for (const child of folderNode.children) {
    if (child.kind === 'folder') {
      await copyFolderSubtreeToTargetRepository({
        folderNode: child,
        sourceRepository,
        targetRepository,
        parentTargetFolderId: clonedFolder.id,
        folderTargetIdBySourceId,
      });
      continue;
    }

    await copyProjectToTargetRepository({
      projectId: child.id,
      sourceRepository,
      targetRepository,
      targetFolderId: clonedFolder.id,
    });
  }
};

export const transferProjectToLanRepository = async ({
  projectId,
  sourceRepository,
  targetRepository,
  tree,
}: {
  projectId: ProjectId;
  sourceRepository: ProjectRepository;
  targetRepository: ProjectRepository;
  tree: LibraryTree;
}) => {
  const sourceFolderId = tree.placementByProjectId[projectId]?.folderId ?? null;
  const folderTargetIdBySourceId = new Map<string, string>();
  const targetFolderId = await getFolderTargetIdMap(
    sourceFolderId,
    targetRepository,
    tree,
    folderTargetIdBySourceId
  );

  await copyProjectToTargetRepository({
    projectId,
    sourceRepository,
    targetRepository,
    targetFolderId,
  });
  await sourceRepository.deleteProject(projectId);
};

export const transferFolderToLanRepository = async ({
  folderId,
  sourceRepository,
  targetRepository,
  tree,
}: {
  folderId: string;
  sourceRepository: ProjectRepository;
  targetRepository: ProjectRepository;
  tree: LibraryTree;
}) => {
  const folderNode = findFolderNode(tree.rootNodes, folderId);
  if (!folderNode) {
    throw createTransferError('La cartella da spostare non e stata trovata.');
  }

  const folderTargetIdBySourceId = new Map<string, string>();
  await copyFolderSubtreeToTargetRepository({
    folderNode,
    sourceRepository,
    targetRepository,
    parentTargetFolderId: null,
    folderTargetIdBySourceId,
  });

  const { folderIds, projectIds } = collectFolderDeletionOrder(folderNode);
  for (const projectId of projectIds) {
    await sourceRepository.deleteProject(projectId);
  }

  for (const nestedFolderId of folderIds) {
    await sourceRepository.deleteFolder(nestedFolderId);
  }
};
