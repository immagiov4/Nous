import type { ChangeEvent } from 'react';
import { useCallback, useId, useRef } from 'react';
import type { SavedProjectMeta } from '../../types.ts';

type UploadMode = 'new-project' | 'reattach-source';

interface FileActionResult {
  errorMessage?: string;
}

interface UseWorkspaceFileActionsArgs {
  deleteProject: (projectId: string) => Promise<void>;
  exportProject: (projectId?: string) => Promise<void>;
  handleSourceUpload: (file: File, options: { mode: UploadMode }) => Promise<FileActionResult>;
  importProjectFile: (file: File) => Promise<FileActionResult>;
  notifyError: (message: string) => void;
  savedProjects: SavedProjectMeta[];
}

const clickInputById = (inputId: string) => {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  input?.click();
};

export const useWorkspaceFileActions = ({
  deleteProject,
  exportProject,
  handleSourceUpload,
  importProjectFile,
  notifyError,
  savedProjects,
}: UseWorkspaceFileActionsArgs) => {
  const fileUploadModeRef = useRef<UploadMode>('new-project');
  const sourceFileInputId = useId();
  const planFileInputId = useId();

  const handleFileUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFile = event.target.files?.[0];
      if (!selectedFile) {
        return;
      }

      try {
        const result = await handleSourceUpload(selectedFile, {
          mode: fileUploadModeRef.current,
        });
        if (result.errorMessage) {
          notifyError(`Errore nel caricamento del file: ${result.errorMessage}`);
        }
      } finally {
        if (event.target) {
          event.target.value = '';
        }
        fileUploadModeRef.current = 'new-project';
      }
    },
    [handleSourceUpload, notifyError]
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
          notifyError(
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
    [importProjectFile, notifyError]
  );

  const handleExportProject = useCallback(
    async (projectId?: string) => {
      await exportProject(projectId);
    },
    [exportProject]
  );

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      const targetProject = savedProjects.find(project => project.id === projectId);
      const shouldDelete = window.confirm(
        `Eliminare "${targetProject?.title || 'questo progetto'}" dalla libreria locale?`
      );
      if (!shouldDelete) {
        return;
      }

      await deleteProject(projectId);
    },
    [deleteProject, savedProjects]
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
    planFileInputId,
    sourceFileInputId,
  };
};
