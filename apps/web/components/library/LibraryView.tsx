import type { UIMessage } from 'ai';
import { Download, HardDrive, Moon, Plus, Server, Settings2, Sun } from 'lucide-react';
import { type ChangeEvent, useState } from 'react';
import logoUrl from '@/assets/logo.png';
import logoDarkModeUrl from '@/assets/logo_darkmode.png';
import type { ProjectRepositoryMode } from '../../services/projects/projectRepositoryFactory';
import type {
  HomeChatMode,
  LibraryContextRef,
  LibraryScopeSummary,
  LibraryTree,
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
  SavedProjectMeta,
} from '../../types';
import { Pressable } from '../../utils/motion/index.ts';
import OpenRouterModelPanel from '../shared/OpenRouterModelPanel';
import HomeChatPanel from './HomeChatPanel';
import LibraryTreeView from './LibraryTreeView.tsx';

const SOURCE_FILE_ACCEPT =
  '.pdf,.zip,.txt,.md,.markdown,.csv,.json,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.html,.css,text/*,application/pdf,application/zip,application/x-zip-compressed';

interface LibraryViewProps {
  assessmentComplete: boolean;
  assessmentMessages: import('../../types').Message[];
  homeChatMode: HomeChatMode;
  openingProjectId: string | null;
  isDarkMode: boolean;
  isLibraryLoading: boolean;
  isLibraryQueryLoading: boolean;
  isNewCourseLoading: boolean;
  libraryAttachedContextRefs: LibraryContextRef[];
  libraryErrorMessage: string | null;
  libraryMessages: UIMessage[];
  libraryScopeSummary: LibraryScopeSummary;
  libraryTree: LibraryTree;
  libraryWebSearch: boolean;
  newCourseLoadingStatus: string;
  modelDefaults: OpenRouterModelDefaults;
  planFileInputId: string;
  preferredModels: OpenRouterModelPreferences;
  projects: SavedProjectMeta[];
  pendingHomeFileName: string | null;
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
  onHomeChatModeChange: (mode: HomeChatMode) => void;
  onLibraryAssistantSend: (message: string) => void | Promise<void>;
  onLibraryWebSearchChange: (value: boolean) => void;
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
  onSetPreferredOpenRouterModel: (slot: OpenRouterModelSlot, value: string) => void;
  onSetProjectRepositoryMode: (mode: ProjectRepositoryMode) => void;
  onOpenProject: (projectId: string) => void;
  onPlanUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveLibraryContextRef: (reference: LibraryContextRef) => void;
  onRenameFolder: (folderId: string, name: string) => Promise<unknown>;
  onTransferFolderToLan: (folderId: string) => Promise<unknown>;
  onTransferProjectToLan: (projectId: string) => Promise<unknown>;
  onSendAssessmentMessage: (message: string) => Promise<void>;
  onToggleDarkMode: () => void;
  onToggleLibraryContextRef: (reference: LibraryContextRef) => void;
  onUploadSourceClick: () => void;
  onSourceFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onImportJsonClick: () => void;
  projectRepositoryMode: ProjectRepositoryMode;
}

const LibraryView = ({
  assessmentComplete,
  assessmentMessages,
  homeChatMode,
  openingProjectId,
  isDarkMode,
  isLibraryLoading,
  isLibraryQueryLoading,
  isNewCourseLoading,
  libraryAttachedContextRefs,
  libraryErrorMessage,
  libraryMessages,
  libraryScopeSummary,
  libraryTree,
  libraryWebSearch,
  newCourseLoadingStatus,
  modelDefaults,
  planFileInputId,
  preferredModels,
  pendingHomeFileName,
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
  onHomeChatModeChange,
  onSetPreferredOpenRouterModel,
  onSetProjectRepositoryMode,
  onLibraryAssistantSend,
  onLibraryWebSearchChange,
  onMoveFolder,
  onMoveProjects,
  onOpenProject,
  onPlanUpload,
  onRemoveLibraryContextRef,
  onRenameFolder,
  onTransferFolderToLan,
  onTransferProjectToLan,
  onSendAssessmentMessage,
  onToggleDarkMode,
  onToggleLibraryContextRef,
  onUploadSourceClick,
  onSourceFileUpload,
  onImportJsonClick,
  projectRepositoryMode,
}: LibraryViewProps) => {
  const [isModelPanelOpen, setIsModelPanelOpen] = useState(false);
  const [newFolderTrigger, setNewFolderTrigger] = useState(0);
  const currentLogoUrl = isDarkMode ? logoDarkModeUrl : logoUrl;

  return (
    <div className="min-h-screen px-4 py-5 transition-colors duration-300 sm:px-6 lg:px-10">
      <input
        id={sourceFileInputId}
        type="file"
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
          <div className="flex items-center gap-1.5 sm:gap-2">
            <img src={currentLogoUrl} alt="Logo Nous" className="h-10 w-10 object-contain" />
            <h1 className="-ml-1 text-2xl font-serif tracking-[-0.02em] text-gray-900 dark:text-zinc-100 sm:text-3xl">
              ous
            </h1>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            <Pressable
              onClick={() =>
                onSetProjectRepositoryMode(projectRepositoryMode === 'lan' ? 'indexeddb' : 'lan')
              }
              className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2.5 text-left transition-colors ${
                projectRepositoryMode === 'lan'
                  ? 'border-cyan-300 bg-cyan-50 text-cyan-800 hover:border-cyan-400 dark:border-cyan-500/40 dark:bg-cyan-500/10 dark:text-cyan-200'
                  : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:text-gray-900 dark:border-zinc-500/60 dark:bg-paper-surface dark:text-zinc-200 dark:hover:border-zinc-400 dark:hover:text-white'
              }`}
              aria-label={
                projectRepositoryMode === 'lan'
                  ? 'Passa alla libreria locale'
                  : 'Passa alla libreria LAN'
              }
              title={
                projectRepositoryMode === 'lan' ? 'Archivio LAN attivo' : 'Archivio locale attivo'
              }
            >
              {projectRepositoryMode === 'lan' ? (
                <Server className="h-4 w-4 flex-shrink-0" />
              ) : (
                <HardDrive className="h-4 w-4 flex-shrink-0" />
              )}
              <span className="hidden text-sm sm:inline">
                {projectRepositoryMode === 'lan' ? 'LAN' : 'Locale'}
              </span>
            </Pressable>
            <div className="relative">
              <Pressable
                onClick={() => setIsModelPanelOpen(currentValue => !currentValue)}
                onPointerDown={e => e.stopPropagation()}
                className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-3.5 py-2.5 text-left text-gray-700 transition-colors hover:border-gray-400 hover:text-gray-900 dark:border-zinc-500/60 dark:bg-paper-surface dark:text-zinc-200 dark:hover:border-zinc-400 dark:hover:text-white"
                aria-label="Apri configurazione modelli AI"
              >
                <Settings2 className="h-4 w-4 flex-shrink-0" />
                <span className="hidden text-sm sm:inline">Modelli</span>
              </Pressable>

              {isModelPanelOpen ? (
                <OpenRouterModelPanel
                  className="model-panel-anchor"
                  defaultModels={modelDefaults}
                  preferredModels={preferredModels}
                  onClose={() => setIsModelPanelOpen(false)}
                  onModelChange={onSetPreferredOpenRouterModel}
                />
              ) : null}
            </div>

            <Pressable
              onClick={onToggleDarkMode}
              className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-900 dark:border-zinc-500/60 dark:bg-paper-surface dark:text-zinc-400 dark:hover:border-zinc-400 dark:hover:text-white"
              aria-label="Cambia tema"
            >
              {isDarkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Pressable>
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
          libraryErrorMessage={libraryErrorMessage}
          libraryMessages={libraryMessages}
          libraryScopeSummary={libraryScopeSummary}
          libraryTree={libraryTree}
          libraryWebSearch={libraryWebSearch}
          newCourseLoadingStatus={newCourseLoadingStatus}
          pendingFileName={pendingHomeFileName}
          onClearPendingFile={onClearPendingHomeFile}
          onClearLibraryMessages={onClearLibraryMessages}
          onContinueAssessment={onContinueAssessment}
          onConfirmGenerate={onConfirmGenerate}
          onHomeChatModeChange={onHomeChatModeChange}
          onLibraryMessageSend={onLibraryAssistantSend}
          onLibraryWebSearchChange={onLibraryWebSearchChange}
          onRemoveLibraryContextRef={onRemoveLibraryContextRef}
          onSendAssessmentMessage={onSendAssessmentMessage}
          onToggleLibraryContextRef={onToggleLibraryContextRef}
          onUploadSourceClick={onUploadSourceClick}
        />

        <section className="mt-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <h2 className="text-2xl font-serif text-gray-900 dark:text-zinc-100">Libreria</h2>
            <div className="flex items-center gap-3">
              <Pressable
                onClick={onImportJsonClick}
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-700 dark:border-zinc-600/50 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
                title="Importa backup Nous (.nous.zip, formato legacy o JSON legacy)"
              >
                <Download className="h-3.5 w-3.5" />
                Importa
              </Pressable>
              <Pressable
                onClick={() => setNewFolderTrigger(n => n + 1)}
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-700 dark:border-zinc-600 dark:bg-[#201917] dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
              >
                <Plus className="h-3.5 w-3.5" />
                Nuova cartella
              </Pressable>
            </div>
          </div>

          {isLibraryLoading ? (
            <div className="rounded-[1.4rem] border border-gray-200/80 bg-white/95 p-8 text-sm text-gray-500 dark:border-white/10 dark:bg-paper-surface/95 dark:text-zinc-400">
              Caricamento libreria...
            </div>
          ) : null}

          {!isLibraryLoading ? (
            <LibraryTreeView
              createRootTrigger={newFolderTrigger}
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
              onTransferFolderToLan={onTransferFolderToLan}
              onTransferProjectToLan={onTransferProjectToLan}
              projectRepositoryMode={projectRepositoryMode}
              tree={libraryTree}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
};

export default LibraryView;
