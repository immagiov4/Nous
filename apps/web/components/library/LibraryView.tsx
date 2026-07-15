import type { UIMessage } from 'ai';
import { Download, Moon, Plus, Sun } from 'lucide-react';
import { type ChangeEvent, useState } from 'react';
import logoUrl from '@/assets/logo.svg';
import logoDarkModeUrl from '@/assets/logo_darkmode.svg';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type {
  HomeChatMode,
  LearningArtifactRenderPayload,
  LibraryContextRef,
  LibraryTree,
  SavedProjectMeta,
} from '../../types';
import { Pressable } from '../../utils/motion/index.ts';
import AccountMenu from '../account/AccountMenu.tsx';
import type {
  ChatArtifactActionRequest,
  ChatArtifactRegenerateRequest,
  ChatArtifactReplaceRequest,
} from '../shared/ChatArtifactRenderer.tsx';
import HomeChatPanel from './HomeChatPanel';
import LibraryTreeView from './LibraryTreeView.tsx';

const SOURCE_FILE_ACCEPT =
  '.pdf,.zip,.txt,.md,.markdown,.mdx,.csv,.json,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.html,.css,text/*,application/pdf,application/zip,application/x-zip-compressed';

interface LibraryViewProps {
  assessmentComplete: boolean;
  assessmentMessages: import('../../types').Message[];
  homeChatMode: HomeChatMode;
  openingProjectId: string | null;
  isDarkMode: boolean;
  isExportingProject?: boolean;
  isLibraryLoading: boolean;
  isLibraryQueryLoading: boolean;
  isNewCourseLoading: boolean;
  libraryAttachedContextRefs: LibraryContextRef[];
  libraryArtifactPayloadsByToolCallId: Record<string, LearningArtifactRenderPayload[]>;
  libraryArtifactPreviewIdOverride?: string | null;
  libraryArtifactPortalContainer?: HTMLElement | null;
  libraryFloatingArtifactPayloads: LearningArtifactRenderPayload[];
  libraryErrorMessage: string | null;
  libraryMessages: UIMessage[];
  libraryTree: LibraryTree;
  libraryWebSearch: boolean;
  libraryGenerateArtifacts: boolean;
  newCourseLoadingStatus: string;
  planFileInputId: string;
  projects: SavedProjectMeta[];
  pendingHomeFileName: string | null;
  pendingHomeFileNames?: string[];
  homeChatDraftValue?: string;
  homeChatScrollProgressOverride?: number;
  sourceFileInputId: string;
  storageError: string | null;
  onClearPendingHomeFile: () => void;
  onClearLibraryMessages: () => void;
  onContinueAssessment: () => void;
  onConfirmGenerate: () => void;
  onCreateFolder: (args: { name: string; parentFolderId?: string | null }) => Promise<unknown>;
  onConfirmDeleteFolder: (folderName: string) => Promise<boolean>;
  onDeleteProject: (projectId: string) => void;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onExportProject: (projectId: string) => void;
  onExportLibraryBackup?: () => Promise<number>;
  onHomeChatModeChange: (mode: HomeChatMode) => void;
  onLibraryAssistantSend: (message: string) => void | Promise<void>;
  onLibraryArtifactNoteApprove: (
    toolCallId: string,
    input: {
      artifactIds: string[];
      lessonId: string;
      noteDraft: string;
      projectId: string;
      rationale: string;
    }
  ) => Promise<void>;
  onLibraryArtifactNoteReject: (toolCallId: string) => void;
  onLibraryArtifactDiscard: (request: ChatArtifactActionRequest) => void;
  onLibraryArtifactRegenerate: (
    request: ChatArtifactRegenerateRequest
  ) => Promise<boolean> | boolean;
  onLibraryArtifactReplace: (request: ChatArtifactReplaceRequest) => Promise<void> | void;
  onLibraryWebSearchChange: (value: boolean) => void;
  onLibraryGenerateArtifactsChange: (value: boolean) => void;
  onMoveFolder: (
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ) => Promise<unknown>;
  onMoveProjects: (
    projectIds: string[],
    folderId: string | null,
    targetIndex?: number
  ) => Promise<unknown>;
  onOpenProject: (projectId: string) => void;
  onPlanUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onRenameFolder: (folderId: string, name: string) => Promise<unknown>;
  onSendAssessmentMessage: (message: string) => Promise<void>;
  onToggleDarkMode: () => void;
  onToggleLibraryContextRef: (reference: LibraryContextRef) => void;
  onUploadSourceClick: () => void;
  onSourceFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onImportJsonClick: () => void;
  onImportLibraryBackup?: (file: File) => Promise<number>;
}

const LibraryView = ({
  assessmentComplete,
  assessmentMessages,
  homeChatMode,
  openingProjectId,
  isDarkMode,
  isExportingProject = false,
  isLibraryLoading,
  isLibraryQueryLoading,
  isNewCourseLoading,
  libraryAttachedContextRefs,
  libraryArtifactPayloadsByToolCallId,
  libraryArtifactPreviewIdOverride,
  libraryArtifactPortalContainer,
  libraryFloatingArtifactPayloads,
  libraryErrorMessage,
  libraryMessages,
  libraryTree,
  libraryWebSearch,
  libraryGenerateArtifacts,
  newCourseLoadingStatus,
  planFileInputId,
  homeChatDraftValue,
  homeChatScrollProgressOverride,
  pendingHomeFileName,
  pendingHomeFileNames,
  sourceFileInputId,
  storageError,
  onClearPendingHomeFile,
  onClearLibraryMessages,
  onContinueAssessment,
  onConfirmGenerate,
  onCreateFolder,
  onConfirmDeleteFolder,
  onDeleteProject,
  onDeleteFolder,
  onExportProject,
  onExportLibraryBackup,
  onHomeChatModeChange,
  onLibraryAssistantSend,
  onLibraryArtifactNoteApprove,
  onLibraryArtifactNoteReject,
  onLibraryArtifactDiscard,
  onLibraryArtifactRegenerate,
  onLibraryArtifactReplace,
  onLibraryWebSearchChange,
  onLibraryGenerateArtifactsChange,
  onMoveFolder,
  onMoveProjects,
  onOpenProject,
  onPlanUpload,
  onRenameFolder,
  onSendAssessmentMessage,
  onToggleDarkMode,
  onToggleLibraryContextRef,
  onUploadSourceClick,
  onSourceFileUpload,
  onImportJsonClick,
  onImportLibraryBackup,
}: LibraryViewProps) => {
  const [newFolderTrigger, setNewFolderTrigger] = useState(0);
  const currentLogoUrl = isDarkMode ? logoDarkModeUrl : logoUrl;

  return (
    <div className="min-h-screen px-4 py-5 transition-colors duration-300 sm:px-6 lg:px-10">
      <input
        id={sourceFileInputId}
        type="file"
        multiple
        className="hidden"
        accept={SOURCE_FILE_ACCEPT}
        onChange={onSourceFileUpload}
      />
      <input
        id={planFileInputId}
        type="file"
        className="hidden"
        accept=".nous.zip,.lumina.zip,.zip,.json,.nous,.lumina"
        onChange={onPlanUpload}
      />

      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 sm:gap-3.5">
            <img src={currentLogoUrl} alt="Logo Nous" className="h-10 w-10 object-contain" />
            <h1 className="text-2xl font-serif tracking-[-0.02em] text-gray-900 dark:text-zinc-100 sm:text-3xl">
              Nous
            </h1>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            <Pressable
              onClick={onToggleDarkMode}
              className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-900 dark:border-zinc-500/60 dark:bg-paper-surface dark:text-zinc-400 dark:hover:border-zinc-400 dark:hover:text-white"
              aria-label={t('Cambia tema')}
            >
              {isDarkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Pressable>
            <AccountMenu
              onExportLibraryBackup={onExportLibraryBackup}
              onImportLibraryBackup={onImportLibraryBackup}
            />
          </div>
        </header>

        {storageError ? (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50/90 px-5 py-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
            {storageError}
          </div>
        ) : null}

        <HomeChatPanel
          assessmentComplete={assessmentComplete}
          assessmentMessages={assessmentMessages}
          homeChatMode={homeChatMode}
          isDarkMode={isDarkMode}
          isLibraryLoading={isLibraryLoading}
          isLibraryModeLoading={isLibraryQueryLoading}
          isNewCourseLoading={isNewCourseLoading}
          libraryAttachedContextRefs={libraryAttachedContextRefs}
          libraryArtifactPayloadsByToolCallId={libraryArtifactPayloadsByToolCallId}
          libraryArtifactPreviewIdOverride={libraryArtifactPreviewIdOverride}
          libraryArtifactPortalContainer={libraryArtifactPortalContainer}
          libraryFloatingArtifactPayloads={libraryFloatingArtifactPayloads}
          libraryErrorMessage={libraryErrorMessage}
          libraryMessages={libraryMessages}
          libraryTree={libraryTree}
          libraryWebSearch={libraryWebSearch}
          libraryGenerateArtifacts={libraryGenerateArtifacts}
          newCourseLoadingStatus={newCourseLoadingStatus}
          draftValueOverride={homeChatDraftValue}
          scrollProgressOverride={homeChatScrollProgressOverride}
          pendingFileName={pendingHomeFileName}
          pendingFileNames={pendingHomeFileNames}
          onClearPendingFile={onClearPendingHomeFile}
          onClearLibraryMessages={onClearLibraryMessages}
          onContinueAssessment={onContinueAssessment}
          onConfirmGenerate={onConfirmGenerate}
          onHomeChatModeChange={onHomeChatModeChange}
          onLibraryMessageSend={onLibraryAssistantSend}
          onLibraryArtifactNoteApprove={onLibraryArtifactNoteApprove}
          onLibraryArtifactNoteReject={onLibraryArtifactNoteReject}
          onLibraryArtifactDiscard={onLibraryArtifactDiscard}
          onLibraryArtifactRegenerate={onLibraryArtifactRegenerate}
          onLibraryArtifactReplace={onLibraryArtifactReplace}
          onLibraryWebSearchChange={onLibraryWebSearchChange}
          onLibraryGenerateArtifactsChange={onLibraryGenerateArtifactsChange}
          onSendAssessmentMessage={onSendAssessmentMessage}
          onToggleLibraryContextRef={onToggleLibraryContextRef}
          onUploadSourceClick={onUploadSourceClick}
        />

        <section className="mt-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <h2
              data-library-target="heading"
              className="text-2xl font-serif text-gray-900 dark:text-zinc-100"
            >
              {t('Libreria')}
            </h2>
            <div className="flex items-center gap-3">
              <Pressable
                onClick={onImportJsonClick}
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-700 dark:border-zinc-600/50 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
                title={t('Importa backup Nous (.nous.zip, formato legacy o JSON legacy)')}
              >
                <Download className="h-3.5 w-3.5" />
                {t('Importa')}
              </Pressable>
              <Pressable
                onClick={() => setNewFolderTrigger(n => n + 1)}
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-700 dark:border-zinc-600 dark:bg-[#201917] dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('Nuova cartella')}
              </Pressable>
            </div>
          </div>

          {isLibraryLoading ? (
            <div className="rounded-[1.4rem] border border-gray-200/80 bg-white/95 p-8 text-sm text-gray-500 dark:border-white/10 dark:bg-paper-surface/95 dark:text-zinc-400">
              {t('Caricamento libreria...')}
            </div>
          ) : null}

          {!isLibraryLoading ? (
            <LibraryTreeView
              createRootTrigger={newFolderTrigger}
              isExportingProject={isExportingProject}
              openingProjectId={openingProjectId}
              onCreateFolder={onCreateFolder}
              onConfirmDeleteFolder={onConfirmDeleteFolder}
              onDeleteFolder={onDeleteFolder}
              onDeleteProject={onDeleteProject}
              onExportProject={onExportProject}
              onMoveFolder={onMoveFolder}
              onMoveProjects={onMoveProjects}
              onOpenProject={onOpenProject}
              onRenameFolder={onRenameFolder}
              tree={libraryTree}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
};

export default LibraryView;
