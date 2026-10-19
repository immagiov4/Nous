import type { PdfTranscriptionProgress } from '@shared/pdfTranscription';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import * as OpenRouterService from '../../../services/openrouter/index.ts';
import { PdfTranscriptionError } from '../../../services/processingResponse.ts';
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
import type {
  CourseSourceDescriptor,
  FileData,
  ProjectSource,
  ProjectSourceWarning,
} from '../../../types.ts';
import type { CreateWorkspaceControllerArgs, WorkspaceControllerContext } from './types.ts';

const createSleep = (ms: number) =>
  new Promise<void>(resolve => {
    globalThis.setTimeout(resolve, ms);
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

const UNUSABLE_PDF_SOURCE_MESSAGE = 'Questa fonte non contiene testo PDF utilizzabile.';

const getCourseSourceWarnings = (
  sources: readonly CourseSourceDescriptor[]
): ProjectSourceWarning[] =>
  sources
    .filter(descriptor => descriptor.status === 'error')
    .map(descriptor => ({
      message: descriptor.errorMessage || t('Questa fonte non è utilizzabile.'),
      name: descriptor.name,
    }));

export const getProjectSourceWarnings = (source: ProjectSource): ProjectSourceWarning[] => {
  const descriptorWarnings = getCourseSourceWarnings(source.sources || []);
  if (source.kind !== 'archive') {
    return descriptorWarnings;
  }

  const archivePdfWarnings = source.index.entries.flatMap(entry =>
    entry.kind === 'file' &&
    entry.contentKind === 'binary' &&
    entry.path.toLowerCase().endsWith('.pdf')
      ? [
          {
            message: t(UNUSABLE_PDF_SOURCE_MESSAGE),
            name: entry.path,
            reason: entry.warningReason || 'no-usable-text',
          },
        ]
      : []
  );
  return [...descriptorWarnings, ...archivePdfWarnings];
};

export const prepareUploadedCourseSource = async (
  context: Pick<WorkspaceControllerContext, 'openRouter'>,
  selectedFiles: readonly File[],
  onProgress?: (completed: number, total: number, pdfProgress?: PdfTranscriptionProgress) => void
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
      await context.openRouter.validatePdfTextSource(descriptor.file, progress =>
        onProgress?.(index, descriptors.length, progress)
      );
      const session = await context.openRouter.getPdfTextSession(descriptor.file);
      if (!session?.extractedText.trim()) {
        throw new Error('No extracted PDF text');
      }
      descriptor.hash = session.sourceHash || descriptor.hash;
      descriptor.preparedPdfText = toPreparedPdfText(session, descriptor.hash);
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
      descriptor.errorMessage =
        error instanceof PdfTranscriptionError ? error.message : t(UNUSABLE_PDF_SOURCE_MESSAGE);
    }
  }
  onProgress?.(descriptors.length, descriptors.length);

  if (descriptors.every(descriptor => descriptor.status === 'error')) {
    throw new Error(
      [
        t('Nessuna delle fonti selezionate contiene materiale utilizzabile.'),
        ...getCourseSourceWarnings(descriptors).map(
          warning => `${warning.name}: ${warning.message}`
        ),
      ].join('\n')
    );
  }

  return {
    descriptors,
    source: createProjectSourceFromDescriptors(descriptors),
  };
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

export const toPreparedPdfText = (
  session: import('../../../services/openrouter/pdfAssets.ts').PdfAssetSession,
  sourceHash: string
): import('@shared/pdfTranscription').PreparedPdfText => ({
  text: session.extractedText,
  pages: session.pages,
  sourceHash,
  parser: session.parser || 'pdf-parse',
  pageCount: session.pageCount,
  outline: session.outline,
  outlineOrigin: session.outlineOrigin,
  usedFallbackParser: session.parser !== 'pdftotext',
});
