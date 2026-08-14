import { useCallback, useEffect, useMemo, useState } from 'react';
import { ensureProjectCover } from '../../services/projects/courseCover.ts';
import { getCourseSourceDescriptors } from '../../services/projects/courseSources.ts';
import type {
  CourseSourceDescriptor,
  FileData,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../types.ts';

const SOURCE_LIBRARY_BATCH_SIZE = 4;
const COURSE_COVER_GENERATION_CONCURRENCY = 3;

export interface SourceLibraryItem {
  file: FileData;
  id: string;
  kind: CourseSourceDescriptor['kind'] | 'archive';
  projectId: string;
  projectTitle: string;
  requiresPrimarySourceLoad: boolean;
}

export const useFavoriteProjectIds = (
  projects: SavedProjectMeta[],
  setProjectFavorite?: (projectId: string, isFavorite: boolean) => Promise<unknown>
) => {
  const favoriteIds = useMemo(
    () => projects.filter(project => project.isFavorite).map(project => project.id),
    [projects]
  );

  const toggleFavoriteProject = useCallback(
    (projectId: string) => {
      const project = projects.find(candidate => candidate.id === projectId);
      if (!project || !setProjectFavorite) return;
      void setProjectFavorite(projectId, !project.isFavorite).catch(() => undefined);
    },
    [projects, setProjectFavorite]
  );

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
            const projectTitle = projectById.get(snapshot.id)?.title || 'Corso senza titolo';
            const archiveSource = snapshot.source?.kind === 'archive' ? snapshot.source : null;
            if (archiveSource) {
              const isAvailable = Boolean(archiveSource.file.data || archiveSource.ref);
              if (!isAvailable) {
                continue;
              }
              collectedItems.push({
                file: archiveSource.file,
                id: `${snapshot.id}:${archiveSource.ref?.id || archiveSource.file.sourceId || archiveSource.name}`,
                kind: 'archive',
                projectId: snapshot.id,
                projectTitle,
                requiresPrimarySourceLoad: !archiveSource.file.data,
              });
              continue;
            }

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
              if (!isAvailable) {
                continue;
              }
              const requiresPrimarySourceLoad = isPrimaryPdfSource && !descriptor.file.data;
              collectedItems.push({
                file: descriptor.file,
                id: `${snapshot.id}:${descriptor.id}`,
                kind: descriptor.kind,
                projectId: snapshot.id,
                projectTitle,
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

export const decodeSourceText = (file: FileData): string => {
  if (!file.data) return '';
  const binary = globalThis.window.atob(file.data);
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
};
