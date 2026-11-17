export { getProjectSourceWarnings } from '../../../services/projects/courseSources.ts';

import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import type { SourcePreparationProgress } from '@shared/sourcePreparation';
import { translateUiMessage as t } from '../../../i18n/uiMessages';
import * as OpenRouterService from '../../../services/openrouter/index.ts';
import {
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
  sortSourceFiles,
} from '../../../services/projects/courseSources.ts';
import {
  detectSourceFileKind,
  encodeBytesBase64,
  normalizeSourceFileMimeType,
} from '../../../services/projects/projectSource.ts';
import { resolveScreenStateForSnapshot } from '../../../services/workspace/controller/snapshotHydration.ts';
import type { CourseSourceDescriptor, FileData, ProjectSource } from '../../../types.ts';
import type { CreateWorkspaceControllerArgs, WorkspaceControllerContext } from './types.ts';

export const formatSourcePreparationProgress = (progress: SourcePreparationProgress): string => {
  if (progress.step === 'upload')
    return t('Caricamento fonti... {percent}%', {
      percent: Math.round(progress.total ? (progress.completed / progress.total) * 100 : 0),
    });
  const labels = {
    expansion: 'Estrazione archivio',
    extraction: 'Lettura fonti',
    'pdf-transcription': 'Trascrizione pagine',
    persistence: 'Salvataggio fonti',
  } as const;
  const message = t('{step}: {completed}/{total}', {
    step: t(labels[progress.step]),
    completed: progress.completed,
    total: progress.total,
  });
  const namedMessage =
    progress.step !== 'pdf-transcription' && progress.documentName
      ? `${message} · ${progress.documentName}`
      : message;
  return progress.reducedQuality
    ? `${namedMessage} · ${t('Pagine {from}–{to} trascritte in qualità ridotta.', progress.reducedQuality)}`
    : namedMessage;
};

const createSleep = (ms: number) =>
  new Promise<void>(resolve => {
    globalThis.setTimeout(resolve, ms);
  });

const scheduleHydrationWithMicrotask = (callback: () => void) => {
  queueMicrotask(callback);
};

export const readSourceFileData = async (file: File): Promise<FileData> => {
  if (file.size > COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes)
    throw new Error(`Il file ${file.name} supera il limite di 32 MB.`);
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

/** Creates pending descriptors only; ingestion prepares bytes and indexes on the server. */
export const prepareUploadedCourseSource = async (
  _context: Pick<WorkspaceControllerContext, 'openRouter'>,
  selectedFiles: readonly File[],
  onProgress?: (completed: number, total: number) => void
): Promise<{ descriptors: CourseSourceDescriptor[]; source: ProjectSource }> => {
  onProgress?.(0, selectedFiles.length);
  const descriptors = buildCourseSourceDescriptors(
    sortSourceFiles(selectedFiles).map(file => ({
      name: file.name,
      mimeType:
        file.type ||
        normalizeSourceFileMimeType(
          file.name,
          file.type,
          detectSourceFileKind({ name: file.name, mimeType: file.type })
        ),
      data: '',
    }))
  );
  return { descriptors, source: createProjectSourceFromDescriptors(descriptors) };
};

export const createWorkspaceControllerContext = ({
  assessmentSession,
  domain,
  openRouter = OpenRouterService,
  projectLibrary,
  scheduleHydration = scheduleHydrationWithMicrotask,
  sleep = createSleep,
  state,
  stopAudio,
}: CreateWorkspaceControllerArgs): WorkspaceControllerContext => ({
  assessmentSession,
  domain,
  openRouter,
  persistHydratedSnapshot: (snapshot, revision) => {
    projectLibrary.setCurrentProjectId(snapshot.id);
    projectLibrary.setProjectHydrated(false);
    domain.hydrateSnapshot(snapshot);
    state.resetSessionState();
    state.setScreenState(resolveScreenStateForSnapshot(snapshot));
    scheduleHydration(() => {
      if (revision === undefined) {
        projectLibrary.setProjectHydrated(true);
      } else {
        projectLibrary.completeProjectHydration({ revision, snapshot });
      }
    });
  },
  projectLibrary,
  scheduleHydration,
  sleep,
  state,
  stopAudio,
});
