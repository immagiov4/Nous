import type {
  LibraryContextRef,
  LibraryFolder,
  LibraryScopeSummary,
  LibraryTree,
  ProjectId,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../types.ts';
import {
  buildLessonDetailPayload,
  buildProjectOverviewPayload,
  buildProjectStructurePayload,
  buildScopedLibraryTreePayload,
  buildLibraryScopeSummary,
  getOutOfScopeProjectIds,
  searchLibraryContent,
} from '../../utils/library/assistant.ts';

export const LIBRARY_ASSISTANT_TOOL_NAMES = [
  'listLibraryTree',
  'getProjectOverviews',
  'getProjectStructures',
  'getLessonDetails',
  'searchLibrary',
] as const;

export type LibraryAssistantToolName =
  (typeof LIBRARY_ASSISTANT_TOOL_NAMES)[number];

interface LibraryAssistantDataSource {
  attachedContextRefs: LibraryContextRef[];
  folders: LibraryFolder[];
  loadProjectsById: (ids: ProjectId[]) => Promise<ProjectSnapshot[]>;
  projects: SavedProjectMeta[];
  scopeSummary?: LibraryScopeSummary;
  tree: LibraryTree;
}

export interface ExecutedLibraryToolResult {
  output?: Record<string, unknown>;
  outputError?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

const formatProjectList = (
  projectIds: string[],
  projects: SavedProjectMeta[]
) => {
  const titleById = new Map(projects.map(project => [project.id, project.title]));
  return projectIds.map(projectId => titleById.get(projectId) || projectId).join(', ');
};

const buildScopeViolationError = ({
  outOfScopeProjectIds,
  projects,
  scopeSummary,
}: {
  outOfScopeProjectIds: string[];
  projects: SavedProjectMeta[];
  scopeSummary: LibraryScopeSummary;
}) => {
  const projectList = formatProjectList(outOfScopeProjectIds, projects);

  if (scopeSummary.isWholeLibraryScope) {
    return `${outOfScopeProjectIds.length > 1 ? 'Corsi non presenti nella libreria corrente' : 'Corso non presente nella libreria corrente'}: ${projectList}`;
  }

  return `Corsi fuori dallo scope allegato: ${projectList}`;
};

const resolveScopeSummary = (
  dataSource: Pick<
    LibraryAssistantDataSource,
    'attachedContextRefs' | 'folders' | 'projects' | 'scopeSummary' | 'tree'
  >
) =>
  dataSource.scopeSummary ||
  buildLibraryScopeSummary({
    attachedContextRefs: dataSource.attachedContextRefs,
    folders: dataSource.folders,
    projects: dataSource.projects,
    tree: dataSource.tree,
  });

const resolveRequestedProjectIds = ({
  requestedProjectIds,
  scopeProjectIds,
}: {
  requestedProjectIds?: string[];
  scopeProjectIds: ProjectId[];
}) => {
  if (!requestedProjectIds || requestedProjectIds.length === 0) {
    return {
      outOfScopeProjectIds: [],
      resolvedProjectIds: scopeProjectIds,
    };
  }

  return {
    outOfScopeProjectIds: getOutOfScopeProjectIds({
      requestedProjectIds,
      scopeProjectIds,
    }),
    resolvedProjectIds: scopeProjectIds.filter(projectId =>
      requestedProjectIds.includes(projectId)
    ),
  };
};

const loadSnapshotsById = async (
  loadProjectsById: (ids: ProjectId[]) => Promise<ProjectSnapshot[]>,
  ids: ProjectId[]
) => {
  const snapshots = await loadProjectsById(ids);
  return new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
};

const executeListLibraryTree = async (
  input: unknown,
  dataSource: LibraryAssistantDataSource
): Promise<ExecutedLibraryToolResult> => {
  const includeProjects =
    !isRecord(input) || typeof input.includeProjects !== 'boolean'
      ? true
      : input.includeProjects;
  const scopeSummary = resolveScopeSummary(dataSource);

  return {
    output: {
      ...buildScopedLibraryTreePayload({
        includeProjects,
        projects: dataSource.projects,
        scopeProjectIds: scopeSummary.scopeProjectIds,
        tree: dataSource.tree,
      }),
      includeProjects,
      scopeSummary: scopeSummary.scopeSummary,
    },
  };
};

const executeProjectOverviewTool = async (
  input: unknown,
  dataSource: LibraryAssistantDataSource
): Promise<ExecutedLibraryToolResult> => {
  const scopeSummary = resolveScopeSummary(dataSource);
  const requestedProjectIds =
    isRecord(input) && isStringArray(input.projectIds) ? input.projectIds : undefined;
  const { outOfScopeProjectIds, resolvedProjectIds } = resolveRequestedProjectIds({
    requestedProjectIds,
    scopeProjectIds: scopeSummary.scopeProjectIds,
  });

  if (outOfScopeProjectIds.length > 0) {
    return {
      output: {
        error: buildScopeViolationError({
          outOfScopeProjectIds,
          projects: dataSource.projects,
          scopeSummary,
        }),
      },
    };
  }

  const projectMetaById = new Map(dataSource.projects.map(project => [project.id, project]));
  const snapshotsById = await loadSnapshotsById(
    dataSource.loadProjectsById,
    resolvedProjectIds
  );

  return {
    output: {
      projects: buildProjectOverviewPayload({
        projectIds: resolvedProjectIds,
        projectMetaById,
        snapshotsById,
      }),
    },
  };
};

const executeProjectStructureTool = async (
  input: unknown,
  dataSource: LibraryAssistantDataSource
): Promise<ExecutedLibraryToolResult> => {
  if (!isRecord(input) || !isStringArray(input.projectIds) || input.projectIds.length === 0) {
    return {
      outputError: 'La richiesta delle strutture corso richiede `projectIds` non vuoti.',
    };
  }

  const scopeSummary = resolveScopeSummary(dataSource);
  const { outOfScopeProjectIds, resolvedProjectIds } = resolveRequestedProjectIds({
    requestedProjectIds: input.projectIds,
    scopeProjectIds: scopeSummary.scopeProjectIds,
  });

  if (outOfScopeProjectIds.length > 0) {
    return {
      output: {
        error: buildScopeViolationError({
          outOfScopeProjectIds,
          projects: dataSource.projects,
          scopeSummary,
        }),
      },
    };
  }

  const projectMetaById = new Map(dataSource.projects.map(project => [project.id, project]));
  const snapshotsById = await loadSnapshotsById(
    dataSource.loadProjectsById,
    resolvedProjectIds
  );

  return {
    output: {
      projects: buildProjectStructurePayload({
        projectIds: resolvedProjectIds,
        projectMetaById,
        snapshotsById,
      }),
    },
  };
};

const executeLessonDetailsTool = async (
  input: unknown,
  dataSource: LibraryAssistantDataSource
): Promise<ExecutedLibraryToolResult> => {
  if (!isRecord(input) || !Array.isArray(input.requests) || input.requests.length === 0) {
    return {
      outputError:
        'La richiesta delle lezioni richiede `requests` con almeno un corso e una lista di lezioni.',
    };
  }

  const normalizedRequests = input.requests
    .filter(isRecord)
    .map(request => ({
      lessonIds: isStringArray(request.lessonIds) ? request.lessonIds : [],
      projectId: typeof request.projectId === 'string' ? request.projectId : '',
    }))
    .filter(request => request.projectId && request.lessonIds.length > 0);

  if (normalizedRequests.length === 0) {
    return {
      outputError:
        'La richiesta delle lezioni richiede `projectId` e `lessonIds` validi per ogni elemento.',
    };
  }

  const scopeSummary = resolveScopeSummary(dataSource);
  const requestedProjectIds = normalizedRequests.map(request => request.projectId);
  const outOfScopeProjectIds = getOutOfScopeProjectIds({
    requestedProjectIds,
    scopeProjectIds: scopeSummary.scopeProjectIds,
  });

  if (outOfScopeProjectIds.length > 0) {
    return {
      output: {
        error: buildScopeViolationError({
          outOfScopeProjectIds,
          projects: dataSource.projects,
          scopeSummary,
        }),
      },
    };
  }

  const projectMetaById = new Map(dataSource.projects.map(project => [project.id, project]));
  const snapshotsById = await loadSnapshotsById(
    dataSource.loadProjectsById,
    Array.from(new Set(requestedProjectIds))
  );

  return {
    output: {
      lessonsByProject: buildLessonDetailPayload({
        projectMetaById,
        requests: normalizedRequests,
        snapshotsById,
      }),
    },
  };
};

const executeSearchTool = async (
  input: unknown,
  dataSource: LibraryAssistantDataSource
): Promise<ExecutedLibraryToolResult> => {
  if (!isRecord(input) || typeof input.query !== 'string' || input.query.trim().length === 0) {
    return {
      outputError: 'La ricerca libreria richiede una query testuale non vuota.',
    };
  }

  const scopeSummary = resolveScopeSummary(dataSource);
  const requestedProjectIds =
    isStringArray(input.projectIds) && input.projectIds.length > 0 ? input.projectIds : undefined;
  const { outOfScopeProjectIds, resolvedProjectIds } = resolveRequestedProjectIds({
    requestedProjectIds,
    scopeProjectIds: scopeSummary.scopeProjectIds,
  });

  if (outOfScopeProjectIds.length > 0) {
    return {
      output: {
        error: buildScopeViolationError({
          outOfScopeProjectIds,
          projects: dataSource.projects,
          scopeSummary,
        }),
      },
    };
  }

  const snapshotsById = await loadSnapshotsById(
    dataSource.loadProjectsById,
    resolvedProjectIds
  );
  const projectMetaById = new Map(dataSource.projects.map(project => [project.id, project]));

  return {
    output: {
      hits: searchLibraryContent({
        maxResults:
          typeof input.maxResults === 'number'
            ? Math.max(1, Math.min(20, Math.trunc(input.maxResults)))
            : 8,
        projectMetaById,
        query: input.query,
        scopeProjectIds: resolvedProjectIds,
        snapshotsById,
      }),
      query: input.query,
    },
  };
};

export const executeLibraryAssistantTool = async ({
  dataSource,
  input,
  toolName,
}: {
  dataSource: LibraryAssistantDataSource;
  input: unknown;
  toolName: LibraryAssistantToolName;
}): Promise<ExecutedLibraryToolResult> => {
  switch (toolName) {
    case 'listLibraryTree':
      return executeListLibraryTree(input, dataSource);
    case 'getProjectOverviews':
      return executeProjectOverviewTool(input, dataSource);
    case 'getProjectStructures':
      return executeProjectStructureTool(input, dataSource);
    case 'getLessonDetails':
      return executeLessonDetailsTool(input, dataSource);
    case 'searchLibrary':
      return executeSearchTool(input, dataSource);
  }
};
