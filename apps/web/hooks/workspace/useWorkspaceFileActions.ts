// fallow-ignore-file unused-files
import type { ChangeEvent } from 'react';
import { useCallback, useId, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { SavedProjectMeta } from '../../types.ts';

type UploadMode = 'new-project' | 'reattach-source';

interface FileActionResult {
  errorMessage?: string;
  sourceWarnings?: Array<{ message: string; name: string }>;
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

// fallow-ignore-next-line unused-exports — used by App.tsx
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
  const [isExportingProject, setIsExportingProject] = useState(false);
  const sourceFileInputId = useId();
  const planFileInputId = useId();

  const handleFileUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(event.target.files || []);
      if (selectedFiles.length === 0) {
        return;
      }

      try {
        const result = await handleSourceUpload(selectedFiles, {
          mode: fileUploadModeRef.current,
        });
        if (result.errorMessage) {
          notify(`Errore nel caricamento del file: ${result.errorMessage}`);
        }
        if (result.sourceWarnings?.length) {
          notify(
            t('Alcune fonti non sono state usate: {sourceNames}. Il corso continua con le altre.', {
              sourceNames: result.sourceWarnings.map(warning => warning.name).join(', '),
            })
          );
        }
      } finally {
        if (event.target) {
          event.target.value = '';
        }
        fileUploadModeRef.current = 'new-project';
      }
    },
    [handleSourceUpload, notify]
  );

  const handlePlanUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFile = event.target.files?.[0];
      if (!selectedFile) {
        return;
      }

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

      await deleteProject(projectId);
    },
    [confirmProjectDelete, deleteProject, savedProjects]
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
    planFileInputId,
    sourceFileInputId,
  };
};
