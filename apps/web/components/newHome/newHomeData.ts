import { useCallback, useEffect, useMemo, useState } from 'react';
import { ensureProjectCover } from '../../services/projects/courseCover.ts';
import { getCourseSourceDescriptors } from '../../services/projects/courseSources.ts';
import type {
  CourseSourceDescriptor,
  FileData,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../types.ts';

const FAVORITE_PROJECTS_STORAGE_KEY = 'nous-favorite-projects-v1';
const SOURCE_LIBRARY_BATCH_SIZE = 4;
const COURSE_COVER_GENERATION_CONCURRENCY = 3;

export interface SourceLibraryItem {
  file: FileData;
  id: string;
  isAvailable: boolean;
  kind: CourseSourceDescriptor['kind'];
  projectId: string;
  projectTitle: string;
  requiresPrimarySourceLoad: boolean;
}

const readFavoriteProjectIds = (): string[] => {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FAVORITE_PROJECTS_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [];
  } catch {
    return [];
  }
};

export const useFavoriteProjectIds = (projects: SavedProjectMeta[]) => {
  const [favoriteProjectIds, setFavoriteProjectIds] = useState<string[]>(readFavoriteProjectIds);
  const validProjectIds = useMemo(() => new Set(projects.map(project => project.id)), [projects]);
  const favoriteIds = useMemo(
    () => favoriteProjectIds.filter(projectId => validProjectIds.has(projectId)),
    [favoriteProjectIds, validProjectIds]
  );

  const toggleFavoriteProject = useCallback((projectId: string) => {
    setFavoriteProjectIds(currentIds => {
      const nextIds = currentIds.includes(projectId)
        ? currentIds.filter(currentId => currentId !== projectId)
        : [...currentIds, projectId];
      try {
        window.localStorage.setItem(FAVORITE_PROJECTS_STORAGE_KEY, JSON.stringify(nextIds));
      } catch {
        // Favorites remain available for the current session when storage is unavailable.
      }
      return nextIds;
    });
  }, []);

  return { favoriteIds, toggleFavoriteProject };
};

export const useCourseCoverImages = ({
  loadProjectCover,
  projects,
  saveProjectCover,
}: {
  loadProjectCover: (projectId: string) => Promise<FileData | null>;
  projects: SavedProjectMeta[];
  saveProjectCover: (projectId: string, cover: FileData) => Promise<void>;
}) => {
  const [coverImagesByProjectId, setCoverImagesByProjectId] = useState<Record<string, string>>({});
  const projectIds = useMemo(() => projects.map(project => project.id), [projects]);

  useEffect(() => {
    if (projectIds.length === 0) {
      return;
    }

    let isCurrent = true;
    const projectsById = new Map(projects.map(project => [project.id, project]));

    let nextProjectIndex = 0;
    const processNextProject = async (): Promise<void> => {
      const projectId = projectIds[nextProjectIndex];
      nextProjectIndex += 1;
      if (!projectId) return;
      try {
        const project = projectsById.get(projectId);
        if (project) {
          const coverUrl = await ensureProjectCover({
            context: `Source: ${project.coverLabel}. Source kind: ${project.sourceKind}.`,
            loadCover: loadProjectCover,
            projectId,
            saveCover: saveProjectCover,
            title: project.title,
          });
          if (isCurrent) {
            setCoverImagesByProjectId(current => ({ ...current, [projectId]: coverUrl }));
          }
        }
      } catch {
        // Keep the PDF-derived or neutral fallback when storage or generation is unavailable.
      }
      await processNextProject();
    };

    void Promise.all(
      Array.from({ length: Math.min(COURSE_COVER_GENERATION_CONCURRENCY, projectIds.length) }, () =>
        processNextProject()
      )
    );

    return () => {
      isCurrent = false;
    };
  }, [loadProjectCover, projectIds, projects, saveProjectCover]);

  return coverImagesByProjectId;
};

const buildFallbackDescriptor = (snapshot: ProjectSnapshot): CourseSourceDescriptor[] => {
  const source = snapshot.source;
  if (!source) {
    return [];
  }
  return getCourseSourceDescriptors(source);
};

export const useSourceLibrary = ({
  enabled,
  loadProjectsById,
  projects,
}: {
  enabled: boolean;
  loadProjectsById: (ids: string[]) => Promise<ProjectSnapshot[]>;
  projects: SavedProjectMeta[];
}) => {
  const [items, setItems] = useState<SourceLibraryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const projectIds = useMemo(() => projects.map(project => project.id), [projects]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (projectIds.length === 0) {
      return;
    }

    let isCurrent = true;
    queueMicrotask(() => {
      if (isCurrent) {
        setIsLoading(true);
        setItems([]);
      }
    });
    void (async () => {
      try {
        const projectById = new Map(projects.map(project => [project.id, project]));
        const collectedItems: SourceLibraryItem[] = [];
        for (let index = 0; index < projectIds.length; index += SOURCE_LIBRARY_BATCH_SIZE) {
          const snapshots = await loadProjectsById(
            projectIds.slice(index, index + SOURCE_LIBRARY_BATCH_SIZE)
          );
          if (!isCurrent) return;
          for (const snapshot of snapshots) {
            const descriptors = buildFallbackDescriptor(snapshot);
            const pdfSource = snapshot.source?.kind === 'pdf' ? snapshot.source : null;
            const primarySourceId = pdfSource?.file.sourceId || '';
            for (const descriptor of descriptors) {
              const isPrimaryPdfSource =
                Boolean(pdfSource) &&
                (descriptor.id === primarySourceId || descriptors[0]?.id === descriptor.id);
              const isAvailable = Boolean(
                descriptor.file.data || (isPrimaryPdfSource && pdfSource?.ref)
              );
              const requiresPrimarySourceLoad =
                isAvailable && isPrimaryPdfSource && !descriptor.file.data;
              collectedItems.push({
                file: descriptor.file,
                id: `${snapshot.id}:${descriptor.id}`,
                isAvailable,
                kind: descriptor.kind,
                projectId: snapshot.id,
                projectTitle: projectById.get(snapshot.id)?.title || 'Corso senza titolo',
                requiresPrimarySourceLoad,
              });
            }
          }
          collectedItems.sort(
            (left, right) =>
              left.file.name.localeCompare(right.file.name, 'it', { sensitivity: 'base' }) ||
              left.projectTitle.localeCompare(right.projectTitle, 'it', { sensitivity: 'base' })
          );
          setItems([...collectedItems]);
        }
      } catch {
        if (isCurrent) {
          setItems([]);
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      isCurrent = false;
    };
  }, [enabled, loadProjectsById, projectIds, projects]);

  return { isLoading, items: projectIds.length === 0 ? [] : items };
};

export const resolveSourceLibraryItemFile = async (
  item: SourceLibraryItem,
  loadProjectSource: (projectId: string) => Promise<FileData | null>
) =>
  item.file.data
    ? item.file
    : item.requiresPrimarySourceLoad
      ? loadProjectSource(item.projectId)
      : null;

export const createSourceObjectUrl = (file: FileData): string | null => {
  if (!file.data) {
    return null;
  }
  const binary = window.atob(file.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(
    new Blob([bytes], { type: file.mimeType || 'application/octet-stream' })
  );
};

export const decodeSourceText = (file: FileData): string => {
  if (!file.data) return '';
  const binary = window.atob(file.data);
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
};
