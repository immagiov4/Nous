import type { ChangeEvent } from 'react';
import { useCallback, useId, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { ProjectStorageError } from '../../services/projects/projectRepository.ts';
import { inspectSourceSelection } from '../../services/projects/sourceFileSelection.ts';
import { formatSourceWarningSummary } from '../../services/projects/sourceWarningSummary.ts';
import type { ProjectSourceWarning, SavedProjectMeta } from '../../types.ts';

type UploadMode = 'new-project' | 'reattach-source';

interface FileActionResult {
  errorMessage?: string;
  sourceWarnings?: ProjectSourceWarning[];
}

interface UseWorkspaceFileActionsArgs {
  confirmProjectDelete: (projectTitle: string) => Promise<boolean>;
  deleteProject: (projectId: string) => Promise<void>;
  exportProject: (projectId?: string) => Promise<void>;
  handleSourceUpload: (
    files: File | File[],
    options: { mode: UploadMode }
  ) => Promise<FileActionResult>;
  importProjectFile: (file: File) => Promise<FileActionResult>;
  notify: (message: string, kind?: 'error' | 'success') => void;
  savedProjects: SavedProjectMeta[];
}

const clickInputById = (inputId: string) => {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  input?.click();
};

export const useWorkspaceFileActions = ({
  confirmProjectDelete,
  deleteProject,
  exportProject,
  handleSourceUpload,
  importProjectFile,
  notify,
  savedProjects,
}: UseWorkspaceFileActionsArgs) => {
  const fileUploadModeRef = useRef<UploadMode>('new-project');
  const exportPendingRef = useRef(false);
  const importPendingRef = useRef(false);
  const [isExportingProject, setIsExportingProject] = useState(false);
  const [isImportingProject, setIsImportingProject] = useState(false);
  const sourceFileInputId = useId();
  const planFileInputId = useId();

  const handleFileUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(event.target.files || []);
      if (selectedFiles.length === 0) {
        return;
      }

      const uploadMode = fileUploadModeRef.current;
      fileUploadModeRef.current = 'new-project';
      try {
        const inspected = await inspectSourceSelection(selectedFiles);
        if (inspected.warnings.length)
          notify(
            inspected.warnings.map(warning => `${warning.name}: ${warning.message}`).join('\n')
          );
        if (inspected.files.length === 0) return;
        const result = await handleSourceUpload(inspected.files, {
          mode: uploadMode,
        });
        if (result.errorMessage) {
          notify(`Errore nel caricamento del file: ${result.errorMessage}`);
        }
        if (result.sourceWarnings?.length) {
          notify(
            formatSourceWarningSummary(result.sourceWarnings, {
              continues: !result.errorMessage,
            })
          );
        }
      } finally {
        if (event.target) {
          event.target.value = '';
        }
      }
    },
    [handleSourceUpload, notify]
  );

  const handlePlanUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFile = event.target.files?.[0];
      if (!selectedFile || importPendingRef.current) {
        return;
      }

      importPendingRef.current = true;
      setIsImportingProject(true);
      try {
        const result = await importProjectFile(selectedFile);
        if (result.errorMessage) {
          notify(
            result.errorMessage === 'Unknown error'
              ? 'Il file di backup non è valido.'
              : result.errorMessage
          );
        }
      } finally {
        importPendingRef.current = false;
        setIsImportingProject(false);
        if (event.target) {
          event.target.value = '';
        }
      }
    },
    [importProjectFile, notify]
  );

  const handleExportProject = useCallback(
    async (projectId?: string) => {
      if (exportPendingRef.current) {
        return;
      }

      exportPendingRef.current = true;
      setIsExportingProject(true);
      try {
        await exportProject(projectId);
        notify(t('Corso esportato. Il download è iniziato.'), 'success');
      } catch (error) {
        console.error('[Nous][Export] Project export failed.', error);
        notify(t('Esportazione non riuscita. Riprova.'));
      } finally {
        exportPendingRef.current = false;
        setIsExportingProject(false);
      }
    },
    [exportProject, notify]
  );

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      const targetProject = savedProjects.find(project => project.id === projectId);
      const shouldDelete = await confirmProjectDelete(targetProject?.title || 'questo progetto');
      if (!shouldDelete) {
        return;
      }

      try {
        await deleteProject(projectId);
      } catch (error) {
        const storageError = error instanceof ProjectStorageError ? error : undefined;
        console.error('[Nous][Delete] Course deletion could not be confirmed.', {
          errorType: error instanceof Error ? error.name : typeof error,
          code: storageError?.code ?? 'unknown',
          httpStatus: storageError?.httpStatus,
        });
        notify(t('Eliminazione del corso non confermata. Ricarica la pagina.'));
      }
    },
    [confirmProjectDelete, deleteProject, notify, savedProjects]
  );

  const handleAttachSourceFile = useCallback(() => {
    fileUploadModeRef.current = 'reattach-source';
    clickInputById(sourceFileInputId);
  }, [sourceFileInputId]);

  const handleUploadSourceClick = useCallback(() => {
    fileUploadModeRef.current = 'new-project';
    clickInputById(sourceFileInputId);
  }, [sourceFileInputId]);

  const handleImportJsonClick = useCallback(() => {
    clickInputById(planFileInputId);
  }, [planFileInputId]);

  return {
    handleAttachSourceFile,
    handleDeleteProject,
    handleExportProject,
    handleFileUpload,
    handleImportJsonClick,
    handlePlanUpload,
    handleUploadSourceClick,
    isExportingProject,
    isImportingProject,
    planFileInputId,
    sourceFileInputId,
  };
};
