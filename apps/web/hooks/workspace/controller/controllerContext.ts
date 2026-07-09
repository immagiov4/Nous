import * as OpenRouterService from '../../../services/openrouter/index.ts';
import {
  detectSourceFileKind,
  encodeBytesBase64,
  getProjectSourceFile,
  isPdfFileData,
  normalizeSourceFileMimeType,
} from '../../../services/projects/projectSource.ts';
import { resolveScreenStateForSnapshot } from '../../../services/workspace/controller/snapshotHydration.ts';
import type { FileData, LearningPlan, PdfTextIndex } from '../../../types.ts';
import type { CreateWorkspaceControllerArgs, WorkspaceControllerContext } from './types.ts';

const createSleep = (ms: number) =>
  new Promise<void>(resolve => {
    window.setTimeout(resolve, ms);
  });

const scheduleHydrationWithMicrotask = (callback: () => void) => {
  queueMicrotask(callback);
};

export const loadProjectSourceFile = async (
  context: Pick<WorkspaceControllerContext, 'domain' | 'projectLibrary'>
): Promise<FileData | null> => {
  const currentFile = context.domain.file?.data
    ? context.domain.file
    : getProjectSourceFile(context.domain.source);
  if (currentFile) {
    return currentFile;
  }

  const source = context.domain.source;
  const projectId = context.projectLibrary.currentProjectId;
  if (source?.kind !== 'pdf' || !projectId) {
    return null;
  }

  const loadedFile = await context.projectLibrary.loadStoredProjectSource(projectId);
  if (!loadedFile) {
    return null;
  }

  context.domain.setSource({ ...source, file: loadedFile });
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
