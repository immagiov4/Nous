import type {
  LessonNode,
  LibraryContextRef,
  LibraryFolder,
  LibraryScopeSummary,
  LibraryTree,
  ProjectId,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../types.ts';
import { flattenLessons, flattenLessonsWithModuleContext } from '../learning/pathNodes.ts';
import { getSectionAnnotationText } from '../learning/sectionAnnotations.ts';
import { getFolderPathLabels, resolveScopedProjectIds } from './tree.ts';

const normalizeSearchText = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

const buildSnippet = (value: string, query: string, maxLength = 220) => {
  const normalizedValue = normalizeSearchText(value);
  const normalizedQuery = normalizeSearchText(query);
  const hitIndex = normalizedQuery ? normalizedValue.indexOf(normalizedQuery) : -1;

  if (hitIndex < 0 || value.length <= maxLength) {
    return value.slice(0, maxLength).trim();
  }

  const start = Math.max(0, hitIndex - Math.floor(maxLength / 4));
  const end = Math.min(value.length, start + maxLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < value.length ? '...' : '';
  return `${prefix}${value.slice(start, end).trim()}${suffix}`;
};

const countProjectNotes = (snapshot: ProjectSnapshot) =>
  flattenLessons(snapshot.learningPlan?.modules).reduce(
    (total, lesson) =>
      total +
      (lesson.annotations?.filter(annotation => annotation.note.trim().length > 0).length || 0),
    0
  );

const countProjectHighlights = (snapshot: ProjectSnapshot) =>
  flattenLessons(snapshot.learningPlan?.modules).reduce(
    (total, lesson) => total + (lesson.annotations?.length || 0),
    0
  );

const countProjectCompletedLessons = (snapshot: ProjectSnapshot) =>
  flattenLessons(snapshot.learningPlan?.modules).filter(lesson => lesson.isCompleted).length;

const getSectionAnnotations = (section: LessonNode) =>
  (section.annotations || []).map(annotation => {
    const highlightedText =
      section.content && annotation.id
        ? getSectionAnnotationText(section.content, annotation.id, section.annotations)
        : '';

    return {
      annotationId: annotation.id,
      createdAt: annotation.createdAt,
      highlightedText,
      note: annotation.note,
      updatedAt: annotation.updatedAt,
    };
  });

const resolveProjectTitle = ({
  projectId,
  projectMetaById,
  snapshotsById,
}: {
  projectId: ProjectId;
  projectMetaById?: Map<ProjectId, SavedProjectMeta>;
  snapshotsById?: Map<ProjectId, ProjectSnapshot>;
}) =>
  projectMetaById?.get(projectId)?.title ||
  snapshotsById?.get(projectId)?.learningPlan?.title ||
  'Corso';

export const buildLibraryScopeSummary = ({
  attachedContextRefs,
  folders,
  projects,
  tree,
}: {
  attachedContextRefs: LibraryContextRef[];
  folders: LibraryFolder[];
  projects: SavedProjectMeta[];
  tree: LibraryTree;
}): LibraryScopeSummary => {
  const repositoryLabel = 'archivio server';
  const allProjectIds = projects.map(project => project.id);
  const scopeProjectIds = resolveScopedProjectIds({
    attachedContextRefs,
    allProjectIds,
    tree,
  });
  const attachedFolderIds = attachedContextRefs
    .filter(reference => reference.kind === 'folder')
    .map(reference => reference.id);
  const attachedProjectIds = attachedContextRefs
    .filter(reference => reference.kind === 'project')
    .map(reference => reference.id);
  const contextLabels = attachedContextRefs.map(reference => {
    if (reference.kind === 'project') {
      return reference.label;
    }

    const pathLabels = getFolderPathLabels(reference.id, folders);
    return pathLabels.length > 0 ? pathLabels.join(' / ') : reference.label;
  });
  const isWholeLibraryScope = attachedContextRefs.length === 0;

  return {
    attachedFolderIds,
    attachedProjectIds,
    contextLabels,
    isWholeLibraryScope,
    scopeProjectIds,
    scopeSummary: isWholeLibraryScope
      ? `Intero ${repositoryLabel} (${projects.length} corsi disponibili).`
      : `${scopeProjectIds.length} corsi nello scope allegato: ${contextLabels.join(', ') || 'nessun contesto'}.`,
  };
};

export const buildScopedLibraryTreePayload = ({
  includeProjects = true,
  projects,
  scopeProjectIds,
  tree,
}: {
  includeProjects?: boolean;
  projects: SavedProjectMeta[];
  scopeProjectIds: ProjectId[];
  tree: LibraryTree;
}) => {
  const allowedProjectIds = new Set(scopeProjectIds);

  const mapNode = (node: (typeof tree.rootNodes)[number]): Record<string, unknown> | null => {
    if (node.kind === 'project') {
      if (!includeProjects) {
        return null;
      }

      if (!allowedProjectIds.has(node.id)) {
        return null;
      }

      return {
        id: node.id,
        kind: node.kind,
        projectTitle: node.project.title,
        title: node.project.title,
      };
    }

    const children = node.children.map(mapNode).filter(Boolean);
    if (children.length === 0) {
      return null;
    }

    return {
      children,
      id: node.id,
      kind: node.kind,
      name: node.folder.name,
      path: getFolderPathLabels(node.id, Object.values(tree.folderById)),
      projectCount: node.descendantProjectIds.filter(projectId => allowedProjectIds.has(projectId))
        .length,
    };
  };

  return {
    projectCount: scopeProjectIds.length,
    projects: projects
      .filter(project => allowedProjectIds.has(project.id))
      .map(project => ({
        id: project.id,
        lessonCount: project.lessonCount,
        title: project.title,
      })),
    tree: tree.rootNodes.map(mapNode).filter(Boolean),
  };
};

export const buildProjectOverviewPayload = ({
  projectIds,
  projectMetaById,
  snapshotsById,
}: {
  projectIds: ProjectId[];
  projectMetaById: Map<ProjectId, SavedProjectMeta>;
  snapshotsById: Map<ProjectId, ProjectSnapshot>;
}) =>
  projectIds.map(projectId => {
    const meta = projectMetaById.get(projectId);
    const snapshot = snapshotsById.get(projectId);

    return {
      completedCount: countProjectCompletedLessons(snapshot || ({} as ProjectSnapshot)),
      coverLabel: meta?.coverLabel || '',
      highlightCount: snapshot ? countProjectHighlights(snapshot) : 0,
      id: projectId,
      lessonCount: meta?.lessonCount || flattenLessons(snapshot?.learningPlan?.modules).length || 0,
      noteCount: snapshot ? countProjectNotes(snapshot) : 0,
      sourceKind: meta?.sourceKind || snapshot?.sourceKind || 'document',
      title: meta?.title || snapshot?.learningPlan?.title || 'Corso',
      createdAt: meta?.createdAt || snapshot?.createdAt || '',
      updatedAt: meta?.updatedAt || snapshot?.updatedAt || '',
      lastOpenedAt: meta?.lastOpenedAt || snapshot?.lastOpenedAt || '',
    };
  });

export const buildProjectStructurePayload = ({
  projectIds,
  projectMetaById,
  snapshotsById,
}: {
  projectIds: ProjectId[];
  projectMetaById: Map<ProjectId, SavedProjectMeta>;
  snapshotsById: Map<ProjectId, ProjectSnapshot>;
}) =>
  projectIds.map(projectId => {
    const snapshot = snapshotsById.get(projectId);
    const meta = projectMetaById.get(projectId);

    return {
      id: projectId,
      noteCount: snapshot ? countProjectNotes(snapshot) : 0,
      highlightCount: snapshot ? countProjectHighlights(snapshot) : 0,
      activeSectionId: snapshot?.activeSectionId || null,
      sections:
        flattenLessonsWithModuleContext(snapshot?.learningPlan?.modules).map(
          ({ lesson, moduleTitle }) => {
            const annotations = lesson.annotations || [];
            const notesWithTimestamp = annotations.filter(a => a.note.trim().length > 0);
            const latestNote =
              notesWithTimestamp.length > 0
                ? notesWithTimestamp.reduce<(typeof notesWithTimestamp)[number] | null>(
                    (best, annotation) => {
                      if (best === null) {
                        return annotation;
                      }

                      return (annotation.updatedAt || annotation.createdAt) >
                        (best.updatedAt || best.createdAt)
                        ? annotation
                        : best;
                    },
                    null
                  )
                : null;
            const latestAnnotation =
              annotations.length > 0
                ? annotations.reduce<(typeof annotations)[number] | null>((best, annotation) => {
                    if (best === null) {
                      return annotation;
                    }

                    return (annotation.updatedAt || annotation.createdAt) >
                      (best.updatedAt || best.createdAt)
                      ? annotation
                      : best;
                  }, null)
                : null;

            return {
              highlightCount: annotations.length,
              hasContent: Boolean(lesson.content?.trim()),
              id: lesson.id,
              isCompleted: lesson.isCompleted,
              learningAidCount: lesson.learningAids?.length || 0,
              moduleTitle: moduleTitle || '',
              noteCount: notesWithTimestamp.length,
              parentId: lesson.parentId || null,
              title: lesson.title,
              description: lesson.description,
              type: lesson.type,
              latestNoteAt: latestNote ? latestNote.updatedAt || latestNote.createdAt : null,
              latestAnnotationAt: latestAnnotation
                ? latestAnnotation.updatedAt || latestAnnotation.createdAt
                : null,
            };
          }
        ) || [],
      title: meta?.title || snapshot?.learningPlan?.title || 'Corso',
    };
  });

export const buildLessonDetailPayload = ({
  projectMetaById,
  requests,
  snapshotsById,
}: {
  projectMetaById?: Map<ProjectId, SavedProjectMeta>;
  requests: Array<{ lessonIds: string[]; projectId: ProjectId }>;
  snapshotsById: Map<ProjectId, ProjectSnapshot>;
}) =>
  requests.map(({ lessonIds, projectId }) => {
    const snapshot = snapshotsById.get(projectId);
    const lessonsWithModule = flattenLessonsWithModuleContext(snapshot?.learningPlan?.modules);
    const allowedSectionIds = new Set(lessonIds);

    return {
      lessons: lessonsWithModule
        .filter(({ lesson }) => allowedSectionIds.has(lesson.id))
        .map(({ lesson, moduleTitle }) => ({
          annotations: getSectionAnnotations(lesson),
          content: lesson.content || '',
          description: lesson.description,
          id: lesson.id,
          isCompleted: lesson.isCompleted,
          learningAids: lesson.learningAids || [],
          moduleTitle: moduleTitle || '',
          noteCount:
            lesson.annotations?.filter(annotation => annotation.note.trim().length > 0).length || 0,
          parentId: lesson.parentId || null,
          title: lesson.title,
          type: lesson.type,
        })),
      projectId,
      projectTitle: resolveProjectTitle({
        projectId,
        projectMetaById,
        snapshotsById,
      }),
    };
  });

export const searchLibraryContent = ({
  maxResults,
  projectMetaById,
  query,
  scopeProjectIds,
  snapshotsById,
}: {
  maxResults: number;
  projectMetaById: Map<ProjectId, SavedProjectMeta>;
  query: string;
  scopeProjectIds: ProjectId[];
  snapshotsById: Map<ProjectId, ProjectSnapshot>;
}) => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  const hits: Array<Record<string, unknown>> = [];

  scopeProjectIds.forEach(projectId => {
    const snapshot = snapshotsById.get(projectId);
    const meta = projectMetaById.get(projectId);

    if (!snapshot || !meta) {
      return;
    }

    const projectHaystack = normalizeSearchText(
      `${meta.title}\n${meta.coverLabel}\n${snapshot.learningPlan?.summary || ''}`
    );
    if (projectHaystack.includes(normalizedQuery)) {
      hits.push({
        kind: 'project',
        projectId,
        projectTitle: meta.title,
        snippet: buildSnippet(
          `${meta.title}\n${snapshot.learningPlan?.summary || meta.coverLabel || ''}`,
          query
        ),
      });
    }

    flattenLessons(snapshot.learningPlan?.modules).forEach(section => {
      const sectionBody = `${section.title}\n${section.description}\n${section.content || ''}`;
      if (normalizeSearchText(sectionBody).includes(normalizedQuery)) {
        hits.push({
          kind: 'lesson',
          lessonId: section.id,
          lessonTitle: section.title,
          projectId,
          projectTitle: meta.title,
          snippet: buildSnippet(
            section.content || `${section.title}\n${section.description}`,
            query
          ),
        });
      }

      getSectionAnnotations(section).forEach(annotation => {
        const annotationBody = `${annotation.highlightedText}\n${annotation.note}`;
        if (!normalizeSearchText(annotationBody).includes(normalizedQuery)) {
          return;
        }

        hits.push({
          annotationId: annotation.annotationId,
          highlightedText: annotation.highlightedText,
          kind: 'annotation',
          lessonId: section.id,
          lessonTitle: section.title,
          note: annotation.note,
          projectId,
          projectTitle: meta.title,
          snippet: buildSnippet(annotationBody, query),
        });
      });

      (section.learningAids || []).forEach(learningAid => {
        const learningAidBody = `${learningAid.title}\n${learningAid.content}`;
        if (!normalizeSearchText(learningAidBody).includes(normalizedQuery)) {
          return;
        }

        hits.push({
          kind: 'learning-aid',
          learningAidId: learningAid.id,
          learningAidKind: learningAid.kind,
          lessonId: section.id,
          lessonTitle: section.title,
          projectId,
          projectTitle: meta.title,
          snippet: buildSnippet(learningAidBody, query),
          title: learningAid.title,
        });
      });
    });
  });

  return hits.slice(0, maxResults);
};

export const getOutOfScopeProjectIds = ({
  requestedProjectIds,
  scopeProjectIds,
}: {
  requestedProjectIds: ProjectId[];
  scopeProjectIds: ProjectId[];
}) => {
  const allowedProjectIds = new Set(scopeProjectIds);
  return requestedProjectIds.filter(projectId => !allowedProjectIds.has(projectId));
};
