import type {
  LearningArtifactRenderPayload,
  LibraryContextRef,
  LibraryFolder,
  LibraryScopeSummary,
  LibraryTree,
  ProjectId,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../types.ts';
import {
  collectLearningArtifactPayloads,
  filterLearningArtifactPayloads,
  summarizeLearningArtifacts,
} from '../../utils/learning/artifacts.ts';
import { flattenLessons } from '../../utils/learning/pathNodes.ts';
import {
  buildLessonDetailPayload,
  buildLibraryScopeSummary,
  buildProjectOverviewPayload,
  buildProjectStructurePayload,
  buildScopedLibraryTreePayload,
  getOutOfScopeProjectIds,
  searchLibraryContent,
} from '../../utils/library/assistant.ts';
import { isRecord } from '../../utils/records.ts';

export const LIBRARY_ASSISTANT_TOOL_NAMES = [
  'listLibraryTree',
  'getProjectOverviews',
  'getProjectStructures',
  'getLearningArtifacts',
  'getLessonDetails',
  'searchLibrary',
] as const;
const DEFAULT_LIBRARY_SEARCH_RESULTS = 8;
const MAX_LIBRARY_SEARCH_RESULTS = 20;

export type LibraryAssistantToolName = (typeof LIBRARY_ASSISTANT_TOOL_NAMES)[number];

export const isLibraryAssistantToolName = (value: string): value is LibraryAssistantToolName =>
  (LIBRARY_ASSISTANT_TOOL_NAMES as readonly string[]).includes(value);

export interface LibraryAssistantDataSource {
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
  renderPayloads?: LearningArtifactRenderPayload[];
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

const formatUnknownProjectCount = (unknownProjectCount: number): string => {
  if (unknownProjectCount === 0) {
    return '';
  }

  if (unknownProjectCount === 1) {
    return '1 corso non riconosciuto';
  }

  return `${unknownProjectCount} corsi non riconosciuti`;
};

const formatProjectList = (projectIds: string[], projects: SavedProjectMeta[]) => {
  const titleById = new Map(projects.map(project => [project.id, project.title]));
  const knownProjectTitles = projectIds.flatMap(projectId => {
    const title = titleById.get(projectId);
    return title ? [title] : [];
  });
  const unknownProjectCount = projectIds.length - knownProjectTitles.length;

  if (knownProjectTitles.length === 0) {
    return formatUnknownProjectCount(unknownProjectCount);
  }

  if (unknownProjectCount === 0) {
    return knownProjectTitles.join(', ');
  }

  return `${knownProjectTitles.join(', ')} e ${
    unknownProjectCount === 1
      ? '1 altro corso non riconosciuto'
      : `${unknownProjectCount} altri corsi non riconosciuti`
  }`;
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
  const isOnlyUnknownProjectList =
    projectList === '1 corso non riconosciuto' || /^\d+ corsi non riconosciuti$/.test(projectList);

  if (scopeSummary.isWholeLibraryScope) {
    if (!projectList || isOnlyUnknownProjectList) {
      return outOfScopeProjectIds.length > 1
        ? 'I corsi richiesti non sono presenti nella libreria corrente.'
        : 'Il corso richiesto non e presente nella libreria corrente.';
    }

    return `${outOfScopeProjectIds.length > 1 ? 'Corsi non presenti nella libreria corrente' : 'Corso non presente nella libreria corrente'}: ${projectList}`;
  }

  if (!projectList || isOnlyUnknownProjectList) {
    return outOfScopeProjectIds.length > 1
      ? 'I corsi richiesti non rientrano nello scope allegato.'
      : 'Il corso richiesto non rientra nello scope allegato.';
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
    !isRecord(input) || typeof input.includeProjects !== 'boolean' ? true : input.includeProjects;
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
  const snapshotsById = await loadSnapshotsById(dataSource.loadProjectsById, resolvedProjectIds);

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
  if (isRecord(input) && 'projectIds' in input && !isStringArray(input.projectIds)) {
    return {
      outputError:
        'La richiesta delle strutture corso accetta `projectIds` solo come array di stringhe.',
    };
  }

  const scopeSummary = resolveScopeSummary(dataSource);
  const requestedProjectIds =
    isRecord(input) && isStringArray(input.projectIds) && input.projectIds.length > 0
      ? input.projectIds
      : undefined;
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
  const snapshotsById = await loadSnapshotsById(dataSource.loadProjectsById, resolvedProjectIds);

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

const readArtifactRequests = (
  input: unknown
): Array<{ lessonIds?: string[]; projectId: string }> =>
  isRecord(input) && Array.isArray(input.requests)
    ? input.requests
        .filter(isRecord)
        .map(request => ({
          lessonIds: isStringArray(request.lessonIds) ? request.lessonIds : undefined,
          projectId: typeof request.projectId === 'string' ? request.projectId : '',
        }))
        .filter(request => request.projectId)
    : [];

const readArtifactKinds = (input: unknown): LearningArtifactRenderPayload['summary']['kind'][] =>
  isRecord(input) && Array.isArray(input.kinds)
    ? input.kinds.filter(
        (kind): kind is LearningArtifactRenderPayload['summary']['kind'] =>
          kind === 'generated-visual' || kind === 'pdf-image' || kind === 'future-asset'
      )
    : [];

const shouldRenderLearningArtifacts = (input: unknown): boolean =>
  isRecord(input) && input.renderMode === 'attachments';

const executeLearningArtifactsTool = async (
  input: unknown,
  dataSource: LibraryAssistantDataSource
): Promise<ExecutedLibraryToolResult> => {
  if (isRecord(input) && 'projectIds' in input && !isStringArray(input.projectIds)) {
    return {
      outputError: 'La richiesta degli artefatti accetta `projectIds` solo come array di stringhe.',
    };
  }

  const scopeSummary = resolveScopeSummary(dataSource);
  const requestedProjectIds =
    isRecord(input) && isStringArray(input.projectIds) && input.projectIds.length > 0
      ? input.projectIds
      : undefined;
  const artifactRequests = readArtifactRequests(input);
  const requestProjectIds =
    artifactRequests.length > 0
      ? Array.from(new Set(artifactRequests.map(request => request.projectId)))
      : requestedProjectIds;
  const { outOfScopeProjectIds, resolvedProjectIds } = resolveRequestedProjectIds({
    requestedProjectIds: requestProjectIds,
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
  const snapshotsById = await loadSnapshotsById(dataSource.loadProjectsById, resolvedProjectIds);
  const lessonIdsByProjectId = new Map(
    artifactRequests.map(request => [request.projectId, request.lessonIds || []])
  );
  const projectArtifacts = resolvedProjectIds.flatMap(projectId => {
    const snapshot = snapshotsById.get(projectId);
    if (!snapshot) {
      return [];
    }

    const lessonIds = lessonIdsByProjectId.get(projectId);
    return filterLearningArtifactPayloads(
      collectLearningArtifactPayloads({
        projectTitle: projectMetaById.get(projectId)?.title,
        snapshot,
      }),
      {
        lessonIds: lessonIds && lessonIds.length > 0 ? lessonIds : undefined,
      }
    );
  });
  const filteredArtifacts = filterLearningArtifactPayloads(projectArtifacts, {
    artifactIds:
      isRecord(input) && isStringArray(input.artifactIds) ? input.artifactIds : undefined,
    kinds: readArtifactKinds(input),
    lessonQuery:
      isRecord(input) && typeof input.lessonQuery === 'string' ? input.lessonQuery : undefined,
    maxResults:
      isRecord(input) && typeof input.maxResults === 'number' ? input.maxResults : undefined,
    query: isRecord(input) && typeof input.query === 'string' ? input.query : undefined,
  });
  const renderPayloads = shouldRenderLearningArtifacts(input) ? filteredArtifacts : undefined;
  const lessonContentAvailabilityByProject = new Map(
    resolvedProjectIds.map(projectId => [
      projectId,
      new Map(
        flattenLessons(snapshotsById.get(projectId)?.learningPlan?.modules).map(lesson => [
          lesson.id,
          Boolean(lesson.content?.trim()),
        ])
      ),
    ])
  );

  return {
    output: {
      artifactCount: filteredArtifacts.length,
      artifacts: summarizeLearningArtifacts(filteredArtifacts).map(artifact => ({
        ...artifact,
        hasContent:
          lessonContentAvailabilityByProject.get(artifact.projectId)?.get(artifact.lessonId) ??
          false,
      })),
      query: isRecord(input) && typeof input.query === 'string' ? input.query : undefined,
      renderMode: renderPayloads ? 'attachments' : 'metadata-only',
      renderedArtifactCount: renderPayloads?.length ?? 0,
    },
    renderPayloads,
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

  const snapshotsById = await loadSnapshotsById(dataSource.loadProjectsById, resolvedProjectIds);
  const projectMetaById = new Map(dataSource.projects.map(project => [project.id, project]));

  return {
    output: {
      hits: searchLibraryContent({
        maxResults:
          typeof input.maxResults === 'number'
            ? Math.max(1, Math.min(MAX_LIBRARY_SEARCH_RESULTS, Math.trunc(input.maxResults)))
            : DEFAULT_LIBRARY_SEARCH_RESULTS,
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
    case 'getLearningArtifacts':
      return executeLearningArtifactsTool(input, dataSource);
    case 'getLessonDetails':
      return executeLessonDetailsTool(input, dataSource);
    case 'searchLibrary':
      return executeSearchTool(input, dataSource);
  }
};
