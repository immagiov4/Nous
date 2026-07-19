import * as OpenRouterService from '../../../services/openrouter/index.ts';
import {
  attachStoredPrimarySource,
  attachStoredSources,
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
  getCourseSourceDescriptors,
  sortSourceFiles,
} from '../../../services/projects/courseSources.ts';
import {
  detectSourceFileKind,
  encodeBytesBase64,
  getProjectSourceFile,
  isPdfFileData,
  normalizeSourceFileMimeType,
} from '../../../services/projects/projectSource.ts';
import { resolveScreenStateForSnapshot } from '../../../services/workspace/controller/snapshotHydration.ts';
import type {
  CourseSourceDescriptor,
  FileData,
  LearningPlan,
  PdfTextIndex,
  ProjectSource,
} from '../../../types.ts';
import type { CreateWorkspaceControllerArgs, WorkspaceControllerContext } from './types.ts';

const createSleep = (ms: number) =>
  new Promise<void>(resolve => {
    window.setTimeout(resolve, ms);
  });

const scheduleHydrationWithMicrotask = (callback: () => void) => {
  queueMicrotask(callback);
};

export const loadProjectSourceFile = async (
  context: Pick<WorkspaceControllerContext, 'domain' | 'projectLibrary' | 'state'>
): Promise<FileData | null> => {
  const currentFile = context.domain.file?.data
    ? context.domain.file
    : getProjectSourceFile(context.domain.source);
  if (currentFile) {
    return currentFile;
  }

  const source = context.domain.source;
  const projectId = context.projectLibrary.currentProjectId;
  if (!source || source.kind === 'archive' || !projectId) {
    return null;
  }

  if (source.sources?.length) {
    const storedSources = await context.projectLibrary.loadStoredProjectSources(projectId);
    if (storedSources.length !== source.sources.length) {
      context.state.setMissingSourceProjectId(projectId);
      return null;
    }
    const hydratedSource = attachStoredSources(
      source,
      storedSources.map(stored => stored.file)
    );
    context.state.setMissingSourceProjectId(null);
    context.domain.setSource(hydratedSource);
    return getProjectSourceFile(hydratedSource);
  }

  const loadedFile = await context.projectLibrary.loadStoredProjectSource(projectId);
  if (!loadedFile) {
    context.state.setMissingSourceProjectId(projectId);
    return null;
  }

  context.state.setMissingSourceProjectId(null);
  context.domain.setSource(attachStoredPrimarySource(source, loadedFile));
  return loadedFile;
};

export const readSourceFileData = async (file: File): Promise<FileData> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detectSourceFileKind({
    name: file.name,
    mimeType: file.type,
    bytes,
  });

  if (kind === 'unsupported') {
    throw new Error('Sono supportati PDF, ZIP o file di testo.');
  }

  return {
    name: file.name,
    mimeType: normalizeSourceFileMimeType(file.name, file.type, kind),
    data: encodeBytesBase64(bytes),
  };
};

export const prepareUploadedCourseSource = async (
  context: Pick<WorkspaceControllerContext, 'openRouter'>,
  selectedFiles: readonly File[],
  onProgress?: (completed: number, total: number) => void
): Promise<{ descriptors: CourseSourceDescriptor[]; source: ProjectSource }> => {
  const sortedFiles = sortSourceFiles(selectedFiles);
  const fileData = await Promise.all(sortedFiles.map(readSourceFileData));
  const descriptors = buildCourseSourceDescriptors(fileData);

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    onProgress?.(index, descriptors.length);
    if (descriptor.kind !== 'pdf') {
      continue;
    }
    try {
      await context.openRouter.validatePdfTextSource(descriptor.file);
      const session = await context.openRouter.getPdfTextSession(descriptor.file);
      if (!session?.extractedText.trim()) {
        throw new Error('No extracted PDF text');
      }
      descriptor.hash = session.sourceHash || descriptor.hash;
      descriptor.outline = session.outline;
      descriptor.outlineOrigin = session.outlineOrigin;
      descriptor.documentIndex = context.openRouter.buildPdfTextIndex(
        session.extractedText,
        descriptor.hash,
        descriptor.name,
        session.pages,
        descriptor.id
      );
    } catch (error) {
      if (descriptors.length === 1) {
        throw error;
      }
      console.warn('[Nous][Sources] A PDF source could not be prepared.', {
        error,
        name: descriptor.name,
      });
      descriptor.status = 'error';
      descriptor.errorMessage = 'Questa fonte non contiene testo PDF utilizzabile.';
    }
  }
  onProgress?.(descriptors.length, descriptors.length);

  if (descriptors.every(descriptor => descriptor.status === 'error')) {
    throw new Error('Nessuna delle fonti selezionate contiene materiale utilizzabile.');
  }

  return {
    descriptors,
    source: createProjectSourceFromDescriptors(descriptors),
  };
};

export const createWorkspaceControllerContext = ({
  domain,
  openRouter = OpenRouterService,
  projectLibrary,
  scheduleHydration = scheduleHydrationWithMicrotask,
  sleep = createSleep,
  state,
  stopAudio,
}: CreateWorkspaceControllerArgs): WorkspaceControllerContext => ({
  domain,
  openRouter,
  persistHydratedSnapshot: snapshot => {
    projectLibrary.setCurrentProjectId(snapshot.id);
    projectLibrary.setProjectHydrated(false);
    domain.hydrateSnapshot(snapshot);
    state.resetSessionState();
    state.setScreenState(resolveScreenStateForSnapshot(snapshot));
    scheduleHydration(() => {
      projectLibrary.setProjectHydrated(true);
    });
  },
  preparePdfLessonPlan: async (
    sourceFile: FileData | null,
    plan: LearningPlan,
    existingIndex?: PdfTextIndex | null,
    sectionIds?: string[]
  ): Promise<{ learningPlan: LearningPlan; documentIndex: PdfTextIndex | null }> => {
    const sources = getCourseSourceDescriptors(domain.source);
    if (sources.length > 1) {
      return openRouter.prepareSourceSetLessonMappings(sources, plan, sectionIds);
    }
    if (!sourceFile || !isPdfFileData(sourceFile)) {
      return { learningPlan: plan, documentIndex: existingIndex ?? null };
    }

    return openRouter.preparePdfLessonMappings(sourceFile, plan, existingIndex, sectionIds);
  },
  projectLibrary,
  scheduleHydration,
  sleep,
  state,
  stopAudio,
});
