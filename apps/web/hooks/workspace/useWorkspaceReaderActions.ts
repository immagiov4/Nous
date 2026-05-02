// fallow-ignore-file unused-file
import { useCallback } from 'react';
import type {
  SaveConversationNoteInput,
  SaveConversationNoteResult,
} from '../../components/workspace/shell/types.ts';
import type {
  ContextMenuState,
  LearningPlan,
  LearningSection,
  PdfTextIndex,
  ProjectSource,
} from '../../types.ts';
import { buildContextSourceMaterial } from '../../utils/context/sourceMaterial.ts';
import {
  applySectionAnnotation,
  findSectionAnnotationForSelection,
  removeSectionAnnotation,
  updateSectionAnnotationNote,
} from '../../utils/learning/sectionAnnotations.ts';

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
  createLessonFromSelection: (args: { instructions: string; selectedText: string }) => Promise<{
    errorMessage?: string;
    outcome: 'blocked-missing-source' | 'created' | 'failed';
  }>;
  documentIndex: PdfTextIndex | null;
  isMobileViewport: boolean;
  learningPlan: LearningPlan | null;
  notify: (message: string) => void;
  openContextAnswer: (args: {
    attachedAnnotationNote?: string;
    attachedAnnotationText?: string;
    contextAfter?: string;
    contextBefore?: string;
    initialQuestion: string;
    lessonContent?: string;
    lessonDescription?: string;
    lessonTitle?: string;
    selectedText: string;
    sourceKind?: ProjectSource['kind'];
    sourceMaterial?: string;
    sourceName?: string;
  }) => void;
  openSection: (section: LearningSection) => Promise<unknown>;
  regenerateActiveSection: () => Promise<unknown>;
  sectionContent: string;
  setIsMobileSidebarOpen: (value: boolean) => void;
  source: ProjectSource | null;
  updateSection: (
    sectionId: string,
    updater: (section: LearningSection) => LearningSection
  ) => void;
}

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
};

const clearNativeSelection = () => {
  window.getSelection()?.removeAllRanges();
};

// fallow-ignore-next-line unused-export — used by App.tsx
export const useWorkspaceReaderActions = ({
  activeSectionId,
  askContextQuestion: _askContextQuestion,
  closeContextMenu,
  completeActiveSection,
  contextMenu,
  createLessonFromSelection,
  documentIndex,
  isMobileViewport,
  learningPlan,
  notify,
  openContextAnswer,
  openSection,
  regenerateActiveSection,
  sectionContent,
  setIsMobileSidebarOpen,
  source,
  updateSection,
}: UseWorkspaceReaderActionsArgs) => {
  const getCurrentSection = useCallback(() => {
    if (!activeSectionId || !learningPlan) {
      return null;
    }

    return learningPlan.sections.find(section => section.id === activeSectionId) || null;
  }, [activeSectionId, learningPlan]);

  const handleContextQuestion = useCallback(
    (question: string) => {
      if (contextMenu.type !== 'selection') {
        return;
      }

      const activeSection = getCurrentSection();
      const sourceContext = buildContextSourceMaterial({
        activeSection,
        documentIndex,
        source,
      });
      const attachedAnnotationMatch =
        activeSection && contextMenu.selectedText
          ? findSectionAnnotationForSelection({
              annotations: activeSection.annotations,
              content: activeSection.content || sectionContent,
              contextAfter: contextMenu.contextAfter,
              contextBefore: contextMenu.contextBefore,
              selectedText: contextMenu.selectedText,
            })
          : null;

      if (isMobileViewport && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      if (isMobileViewport) {
        clearNativeSelection();
      }

      openContextAnswer({
        contextAfter: contextMenu.contextAfter,
        contextBefore: contextMenu.contextBefore,
        initialQuestion: question,
        attachedAnnotationNote: attachedAnnotationMatch?.annotation.note || undefined,
        attachedAnnotationText: attachedAnnotationMatch?.resolvedText,
        lessonContent: activeSection?.content || sectionContent,
        lessonDescription: activeSection?.description,
        lessonTitle: activeSection?.title,
        selectedText: contextMenu.selectedText,
        sourceKind: sourceContext.sourceKind,
        sourceMaterial: sourceContext.sourceMaterial,
        sourceName: sourceContext.sourceName,
      });
      closeContextMenu();
    },
    [
      closeContextMenu,
      contextMenu,
      documentIndex,
      getCurrentSection,
      isMobileViewport,
      openContextAnswer,
      sectionContent,
      source,
    ]
  );

  const handleCreateLesson = useCallback(
    async (instructions: string) => {
      if (contextMenu.type !== 'selection') {
        return;
      }

      const result = await createLessonFromSelection({
        instructions,
        selectedText: contextMenu.selectedText,
      });

      if (result.outcome === 'created') {
        if (isMobileViewport) {
          clearNativeSelection();
        }
        closeContextMenu();
        return;
      }

      notify(
        result.errorMessage ||
          'Questo progetto non ha un file sorgente collegato. Ricollega il PDF o lo ZIP prima di creare una sottolezione.'
      );
    },
    [closeContextMenu, contextMenu, createLessonFromSelection, isMobileViewport, notify]
  );

  const handleRegenerateActiveSection = useCallback(() => {
    void regenerateActiveSection().catch(error => {
      notify(getErrorMessage(error));
    });
  }, [notify, regenerateActiveSection]);

  const handleHighlight = useCallback(() => {
    if (!activeSectionId || contextMenu.type !== 'selection' || !contextMenu.selectedText) {
      return;
    }

    const currentSection = getCurrentSection();
    if (!currentSection) {
      return;
    }

    const result = applySectionAnnotation({
      annotations: currentSection.annotations,
      content: currentSection.content || sectionContent,
      contextAfter: contextMenu.contextAfter,
      contextBefore: contextMenu.contextBefore,
      selectedText: contextMenu.selectedText,
    });

    if (!result) {
      notify(
        'Non sono riuscito a evidenziare questa selezione in modo affidabile. Prova con una selezione leggermente piu corta.'
      );
      return;
    }

    updateSection(activeSectionId, section => ({
      ...section,
      content: result.content,
      annotations: result.annotations,
    }));
    closeContextMenu();
    clearNativeSelection();
  }, [
    activeSectionId,
    closeContextMenu,
    contextMenu,
    getCurrentSection,
    notify,
    sectionContent,
    updateSection,
  ]);

  const handleSaveNote = useCallback(
    (note: string) => {
      if (!activeSectionId) {
        return;
      }

      const currentSection = getCurrentSection();
      if (!currentSection) {
        return;
      }

      if (contextMenu.type === 'selection') {
        const result = applySectionAnnotation({
          annotations: currentSection.annotations,
          content: currentSection.content || sectionContent,
          contextAfter: contextMenu.contextAfter,
          contextBefore: contextMenu.contextBefore,
          note,
          selectedText: contextMenu.selectedText,
        });

        if (!result) {
          notify(
            "Non sono riuscito ad associare la nota a questa selezione. Prova a selezionare un frammento un po' piu preciso."
          );
          return;
        }

        updateSection(activeSectionId, section => ({
          ...section,
          content: result.content,
          annotations: result.annotations,
        }));
        closeContextMenu();
        clearNativeSelection();
        return;
      }

      const result = updateSectionAnnotationNote({
        annotationId: contextMenu.annotationId,
        annotations: currentSection.annotations,
        note,
      });

      if (!result) {
        notify('Non ho trovato questa annotazione. Riprova dopo aver ricaricato la sezione.');
        return;
      }

      updateSection(activeSectionId, section => ({
        ...section,
        annotations: result.annotations,
      }));
      closeContextMenu();
    },
    [
      activeSectionId,
      closeContextMenu,
      contextMenu,
      getCurrentSection,
      notify,
      sectionContent,
      updateSection,
    ]
  );

  const handleDeleteAnnotation = useCallback(() => {
    if (!activeSectionId || contextMenu.type !== 'annotation') {
      return;
    }

    const currentSection = getCurrentSection();
    if (!currentSection) {
      return;
    }

    const result = removeSectionAnnotation({
      annotationId: contextMenu.annotationId,
      annotations: currentSection.annotations,
      content: currentSection.content || sectionContent,
    });

    if (!result.removed) {
      notify('Non sono riuscito a rimuovere questo highlight. Riprova.');
      return;
    }

    updateSection(activeSectionId, section => ({
      ...section,
      content: result.content,
      annotations: result.annotations,
    }));
    closeContextMenu();
  }, [
    activeSectionId,
    closeContextMenu,
    contextMenu,
    getCurrentSection,
    notify,
    sectionContent,
    updateSection,
  ]);

  const handleSaveConversationNote = useCallback(
    async ({
      fallbackSelection,
      contextAfter,
      contextBefore,
      note,
      selectedText,
    }: SaveConversationNoteInput): Promise<SaveConversationNoteResult> => {
      if (!activeSectionId) {
        return {
          saved: false,
          merged: false,
          error: 'La sezione attiva non e disponibile.',
        };
      }

      const currentSection = getCurrentSection();
      if (!currentSection) {
        return {
          saved: false,
          merged: false,
          error: 'Non ho trovato la sezione corrente.',
        };
      }

      const trySave = (input: {
        contextAfter?: string;
        contextBefore?: string;
        selectedText: string;
      }) =>
        applySectionAnnotation({
          annotations: currentSection.annotations,
          content: currentSection.content || sectionContent,
          contextAfter: input.contextAfter,
          contextBefore: input.contextBefore,
          note,
          selectedText: input.selectedText,
        });

      const primaryResult = trySave({ contextAfter, contextBefore, selectedText });

      const fallbackResult =
        !primaryResult && fallbackSelection
          ? trySave({
              contextAfter: fallbackSelection.contextAfter,
              contextBefore: fallbackSelection.contextBefore,
              selectedText: fallbackSelection.selectedText,
            })
          : null;

      const result = primaryResult || fallbackResult;

      if (!result) {
        return {
          saved: false,
          merged: false,
          error: 'Non sono riuscito a ritrovare il passaggio da annotare nella lezione corrente.',
        };
      }

      updateSection(activeSectionId, section => ({
        ...section,
        content: result.content,
        annotations: result.annotations,
      }));

      return {
        saved: true,
        annotationId: result.annotationId,
        merged: result.merged,
        resolvedText: result.resolvedText,
      };
    },
    [activeSectionId, getCurrentSection, sectionContent, updateSection]
  );

  const handleUpdateConversationNote = useCallback(
    async ({
      fallbackSelection,
      contextAfter,
      contextBefore,
      note,
      selectedText,
    }: SaveConversationNoteInput): Promise<SaveConversationNoteResult> => {
      if (!activeSectionId) {
        return {
          saved: false,
          merged: false,
          error: 'La sezione attiva non e disponibile.',
        };
      }

      const currentSection = getCurrentSection();
      if (!currentSection) {
        return {
          saved: false,
          merged: false,
          error: 'Non ho trovato la sezione corrente.',
        };
      }

      const resolveMatch = (input: {
        contextAfter?: string;
        contextBefore?: string;
        selectedText: string;
      }) =>
        findSectionAnnotationForSelection({
          annotations: currentSection.annotations,
          content: currentSection.content || sectionContent,
          contextAfter: input.contextAfter,
          contextBefore: input.contextBefore,
          selectedText: input.selectedText,
        });

      const match =
        resolveMatch({ contextAfter, contextBefore, selectedText }) ||
        (fallbackSelection
          ? resolveMatch({
              contextAfter: fallbackSelection.contextAfter,
              contextBefore: fallbackSelection.contextBefore,
              selectedText: fallbackSelection.selectedText,
            })
          : null);

      if (!match) {
        return {
          saved: false,
          merged: false,
          error: 'Non ho trovato una nota esistente collegata a questo passaggio da aggiornare.',
        };
      }

      const result = updateSectionAnnotationNote({
        annotationId: match.annotation.id,
        annotations: currentSection.annotations,
        note,
      });

      if (!result) {
        return {
          saved: false,
          merged: false,
          error: 'Non sono riuscito ad aggiornare la nota esistente.',
        };
      }

      updateSection(activeSectionId, section => ({
        ...section,
        annotations: result.annotations,
      }));

      return {
        saved: true,
        annotationId: match.annotation.id,
        merged: false,
        resolvedText: match.resolvedText,
      };
    },
    [activeSectionId, getCurrentSection, sectionContent, updateSection]
  );

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
    handleDeleteAnnotation,
    handleHighlight,
    handleRegenerateActiveSection,
    handleSaveConversationNote,
    handleUpdateConversationNote,
    handleSaveNote,
    handleSelectSection,
  };
};
