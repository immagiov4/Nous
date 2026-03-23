import { useCallback } from 'react';
import type { ContextMenuState, LearningPlan, LearningSection } from '../types.ts';
import { toggleHighlightInContent } from '../utils/highlightSelection.ts';

interface UseWorkspaceReaderActionsArgs {
  activeSectionId: string | null;
  askContextQuestion: (args: {
    contextAfter?: string;
    contextBefore?: string;
    question: string;
    selectedText: string;
  }) => Promise<{ answer?: string; errorMessage?: string }>;
  closeContextMenu: () => void;
  completeActiveSection: () => Promise<'journey-complete' | 'noop' | 'opened-next'>;
  contextMenu: ContextMenuState;
  createLessonFromSelection: (args: {
    instructions: string;
    selectedText: string;
  }) => Promise<{ errorMessage?: string; outcome: 'blocked-missing-source' | 'created' | 'failed' }>;
  isMobileViewport: boolean;
  learningPlan: LearningPlan | null;
  notify: (message: string) => void;
  openContextAnswer: (question: string, answer: string) => void;
  openSection: (section: LearningSection) => Promise<unknown>;
  regenerateActiveSection: () => Promise<unknown>;
  sectionContent: string;
  setIsMobileSidebarOpen: (value: boolean) => void;
  updateActiveSectionContent: (content: string) => void;
}

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
};

export const useWorkspaceReaderActions = ({
  activeSectionId,
  askContextQuestion,
  closeContextMenu,
  completeActiveSection,
  contextMenu,
  createLessonFromSelection,
  isMobileViewport,
  learningPlan,
  notify,
  openContextAnswer,
  openSection,
  regenerateActiveSection,
  sectionContent,
  setIsMobileSidebarOpen,
  updateActiveSectionContent,
}: UseWorkspaceReaderActionsArgs) => {
  const handleContextQuestion = useCallback(
    async (question: string) => {
      const result = await askContextQuestion({
        contextAfter: contextMenu.contextAfter,
        contextBefore: contextMenu.contextBefore,
        question,
        selectedText: contextMenu.selectedText,
      });

      if (result.errorMessage) {
        notify(result.errorMessage);
        return;
      }

      if (result.answer) {
        openContextAnswer(question, result.answer);
        closeContextMenu();
      }
    },
    [askContextQuestion, closeContextMenu, contextMenu, notify, openContextAnswer]
  );

  const handleCreateLesson = useCallback(
    async (instructions: string) => {
      const result = await createLessonFromSelection({
        instructions,
        selectedText: contextMenu.selectedText,
      });

      if (result.outcome === 'created') {
        closeContextMenu();
        return;
      }

      notify(
        result.errorMessage ||
          'Questo progetto non ha un file sorgente collegato. Ricollega il PDF o lo ZIP prima di creare una sottolezione.'
      );
    },
    [closeContextMenu, contextMenu.selectedText, createLessonFromSelection, notify]
  );

  const handleRegenerateActiveSection = useCallback(() => {
    void regenerateActiveSection().catch(error => {
      notify(getErrorMessage(error));
    });
  }, [notify, regenerateActiveSection]);

  const handleHighlight = useCallback(() => {
    if (!activeSectionId || !learningPlan || !contextMenu.selectedText) {
      return;
    }

    const currentSection = learningPlan.sections.find(section => section.id === activeSectionId);
    const sourceContent = currentSection?.content || sectionContent;
    const newContent = toggleHighlightInContent({
      content: sourceContent,
      selectedText: contextMenu.selectedText,
      contextBefore: contextMenu.contextBefore,
      contextAfter: contextMenu.contextAfter,
    });
    if (!newContent) {
      notify('Non sono riuscito a evidenziare questa selezione in modo affidabile. Prova con una selezione leggermente piu corta.');
      return;
    }

    updateActiveSectionContent(newContent);
    closeContextMenu();
    window.getSelection()?.removeAllRanges();
  }, [
    activeSectionId,
    closeContextMenu,
    contextMenu.contextAfter,
    contextMenu.contextBefore,
    contextMenu.selectedText,
    learningPlan,
    sectionContent,
    updateActiveSectionContent,
  ]);

  const handleCompleteSection = useCallback(async () => {
    const result = await completeActiveSection();
    if (result === 'journey-complete') {
      notify('Percorso completato! Ricordati di esportare il tuo progresso.');
    }
  }, [completeActiveSection, notify]);

  const handleSelectSection = useCallback(
    (section: LearningSection) => {
      if (isMobileViewport) {
        setIsMobileSidebarOpen(false);
      }

      void openSection(section).catch(error => {
        notify(getErrorMessage(error));
      });
    },
    [isMobileViewport, notify, openSection, setIsMobileSidebarOpen]
  );

  return {
    handleCompleteSection,
    handleContextQuestion,
    handleCreateLesson,
    handleHighlight,
    handleRegenerateActiveSection,
    handleSelectSection,
  };
};
