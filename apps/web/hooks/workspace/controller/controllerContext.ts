import * as OpenRouterService from '../../../services/openrouter/index.ts';
import {
  detectSourceFileKind,
  encodeBytesBase64,
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
    state.resetRuntimeState();
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
