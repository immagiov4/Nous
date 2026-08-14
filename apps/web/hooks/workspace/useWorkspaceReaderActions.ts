import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type {
  SaveConversationNoteInput,
  SaveConversationNoteResult,
} from '../../components/workspace/shell/types.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type {
  ApplicationExerciseNode,
  ContextMenuState,
  ContextScope,
  LearningPlan,
  LessonNode,
  PdfTextIndex,
  ProjectSource,
  SectionAnnotationArtifactRef,
  StoredLessonVisual,
} from '../../types.ts';
import { buildContextSourceMaterial } from '../../utils/context/sourceMaterial.ts';
import { replaceGeneratedVisualPreservingId } from '../../utils/learning/artifacts.ts';
import { flattenLessons } from '../../utils/learning/pathNodes.ts';
import {
  applySectionAnnotation,
  createLessonSectionAnnotation,
  findSectionAnnotationForSelection,
  getSectionAnnotationText,
  removeSectionAnnotation,
  removeSectionAnnotationArtifactRef,
  updateSectionAnnotationNote,
  upsertSectionAnnotationArtifactRefs,
} from '../../utils/learning/sectionAnnotations.ts';
import type { CreateLessonOutcome } from './controller/types.ts';

interface UseWorkspaceReaderActionsArgs {
  activeSectionId: string | null;
  advanceActiveSection: () => Promise<'journey-complete' | 'noop' | 'opened-next'>;
  askContextQuestion: (args: {
    contextAfter?: string;
    contextBefore?: string;
    question: string;
    selectedText: string;
  }) => Promise<{ answer?: string; errorMessage?: string }>;
  closeContextMenu: () => void;
  completeActiveSection: () => Promise<'journey-complete' | 'noop' | 'opened-next'>;
  contextMenu: ContextMenuState;
  contextMenuScrollTopRef: RefObject<number | null>;
  createLessonFromSelection: (args: {
    annotationNote?: string;
    contextAfter?: string;
    contextBefore?: string;
    instructions: string;
    selectedText: string;
  }) => Promise<{ errorMessage?: string; outcome: CreateLessonOutcome }>;
  documentIndex: PdfTextIndex | null;
  isMobileViewport: boolean;
  learningPlan: LearningPlan | null;
  notify: (message: string) => void;
  openContextAnswer: (args: {
    attachedAnnotationNote?: string;
    attachedAnnotationText?: string;
    contextAfter?: string;
    contextBefore?: string;
    contextScope?: ContextScope;
    initialQuestion: string;
    lessonContent?: string;
    lessonDescription?: string;
    lessonId?: string;
    lessonTitle?: string;
    projectId?: string;
    projectTitle?: string;
    selectedText: string;
    selectedTextStart?: number;
    sourceKind?: ProjectSource['kind'];
    sourceMaterial?: string;
    sourceName?: string;
  }) => void;
  openExercise: (exercise: ApplicationExerciseNode) => Promise<unknown>;
  openSection: (section: LessonNode) => Promise<unknown>;
  patchSectionAnnotations: (
    sectionId: string,
    annotations: unknown,
    content?: string,
    generatedVisuals?: StoredLessonVisual[]
  ) => Promise<boolean>;
  projectId: string | null;
  regenerateActiveSection: () => Promise<unknown>;
  sectionContent: string;
  scrollContainerRef: RefObject<HTMLElement | null>;
  setIsMobileSidebarOpen: (value: boolean) => void;
  source: ProjectSource | null;
  updateSection: (sectionId: string, updater: (section: LessonNode) => LessonNode) => void;
}

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
};

const clearNativeSelection = () => {
  globalThis.getSelection()?.removeAllRanges();
};

const buildWholeLessonContextLabel = (lessonTitle?: string) => {
  return lessonTitle ? `Intera lezione: ${lessonTitle}` : 'Intera lezione corrente';
};

const mergeGeneratedVisuals = (
  existingVisuals: StoredLessonVisual[] | undefined,
  addedVisuals: StoredLessonVisual[] | undefined
): StoredLessonVisual[] | undefined => {
  const visualById = new Map((existingVisuals || []).map(visual => [visual.id, visual]));
  (addedVisuals || []).forEach(visual => {
    if (!visualById.has(visual.id)) {
      visualById.set(visual.id, visual);
    }
  });
  return visualById.size > 0 ? Array.from(visualById.values()) : undefined;
};

export const useWorkspaceReaderActions = ({
  activeSectionId,
  advanceActiveSection,
  askContextQuestion: _askContextQuestion,
  closeContextMenu,
  completeActiveSection,
  contextMenu,
  contextMenuScrollTopRef,
  createLessonFromSelection,
  documentIndex,
  isMobileViewport,
  learningPlan,
  notify,
  openContextAnswer,
  openExercise,
  openSection,
  patchSectionAnnotations,
  projectId,
  regenerateActiveSection,
  sectionContent,
  scrollContainerRef,
  setIsMobileSidebarOpen,
  source,
  updateSection,
}: UseWorkspaceReaderActionsArgs) => {
  const activeSectionIdRef = useRef(activeSectionId);
  useEffect(() => {
    activeSectionIdRef.current = activeSectionId;
  }, [activeSectionId]);

  const updateSectionPreservingReaderScroll = useCallback(
    (sectionId: string, updater: (section: LessonNode) => LessonNode) => {
      const scrollContainer = scrollContainerRef.current;
      const scrollTop = contextMenuScrollTopRef.current ?? scrollContainer?.scrollTop;
      updateSection(sectionId, updater);
      if (!scrollContainer || scrollTop === undefined) {
        return;
      }

      globalThis.requestAnimationFrame(() => {
        if (scrollContainerRef.current === scrollContainer) {
          scrollContainer.scrollTop = scrollTop;
        }
      });
    },
    [contextMenuScrollTopRef, scrollContainerRef, updateSection]
  );
  const persistSectionAnnotationsPreservingReaderScroll = useCallback(
    (sectionId: string, annotations: unknown) => {
      const scrollContainer = scrollContainerRef.current;
      const scrollTop = contextMenuScrollTopRef.current ?? scrollContainer?.scrollTop;
      void patchSectionAnnotations(sectionId, annotations).finally(() => {
        if (!scrollContainer || scrollTop === undefined) {
          return;
        }

        globalThis.requestAnimationFrame(() => {
          if (
            activeSectionIdRef.current === sectionId &&
            scrollContainerRef.current === scrollContainer
          ) {
            scrollContainer.scrollTop = scrollTop;
          }
        });
      });
    },
    [contextMenuScrollTopRef, patchSectionAnnotations, scrollContainerRef]
  );
  const getCurrentSection = useCallback(() => {
    if (!activeSectionId || !learningPlan) {
      return null;
    }

    return (
      flattenLessons(learningPlan.modules).find(section => section.id === activeSectionId) || null
    );
  }, [activeSectionId, learningPlan]);

  const handleContextQuestion = useCallback(
    (question: string) => {
      if (contextMenu.type !== 'lesson' && !contextMenu.selectedText) {
        return;
      }

      const activeSection = getCurrentSection();
      const contextScope = contextMenu.type;
      const selectedText =
        contextScope === 'lesson'
          ? buildWholeLessonContextLabel(activeSection?.title)
          : contextMenu.selectedText;
      const sourceContext = buildContextSourceMaterial({
        activeSection,
        documentIndex,
        source,
      });
      const attachedAnnotationMatch =
        activeSection && contextMenu.type === 'selection'
          ? findSectionAnnotationForSelection({
              annotations: activeSection.annotations,
              content: activeSection.content || sectionContent,
              contextAfter: contextMenu.contextAfter,
              contextBefore: contextMenu.contextBefore,
              selectedText: contextMenu.selectedText,
              selectedTextStart: contextMenu.selectedTextStart,
            })
          : null;
      const clickedAnnotation =
        activeSection && contextMenu.type === 'annotation'
          ? (activeSection.annotations || []).find(
              annotation => annotation.id === contextMenu.annotationId
            )
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
        contextScope,
        initialQuestion: question,
        attachedAnnotationNote:
          clickedAnnotation?.note || attachedAnnotationMatch?.annotation.note || undefined,
        attachedAnnotationText:
          clickedAnnotation && activeSection
            ? getSectionAnnotationText(
                activeSection.content || sectionContent,
                clickedAnnotation.id,
                activeSection.annotations
              )
            : attachedAnnotationMatch?.resolvedText,
        lessonContent: activeSection?.content || sectionContent,
        lessonDescription: activeSection?.description,
        lessonId: activeSection?.id,
        lessonTitle: activeSection?.title,
        projectId: projectId || undefined,
        projectTitle: learningPlan?.title,
        selectedText,
        selectedTextStart:
          contextMenu.type === 'selection' ? contextMenu.selectedTextStart : undefined,
        sourceKind: sourceContext.sourceKind,
        sourceMaterial: sourceContext.sourceMaterial,
        sourceName: sourceContext.sourceName,
      });
    },
    [
      contextMenu,
      documentIndex,
      getCurrentSection,
      isMobileViewport,
      openContextAnswer,
      projectId,
      learningPlan?.title,
      sectionContent,
      source,
    ]
  );

  const handleCreateLesson = useCallback(
    async (instructions: string) => {
      const activeSection = getCurrentSection();
      const selectedText =
        contextMenu.type === 'lesson'
          ? activeSection?.content || sectionContent
          : contextMenu.selectedText;
      if (!selectedText || (contextMenu.type === 'lesson' && !instructions.trim())) {
        return;
      }

      const attachedAnnotation =
        contextMenu.type === 'annotation'
          ? (activeSection?.annotations || []).find(
              annotation => annotation.id === contextMenu.annotationId
            )
          : contextMenu.type === 'selection' && activeSection
            ? findSectionAnnotationForSelection({
                annotations: activeSection.annotations,
                content: activeSection.content || sectionContent,
                contextAfter: contextMenu.contextAfter,
                contextBefore: contextMenu.contextBefore,
                selectedText: contextMenu.selectedText,
                selectedTextStart:
                  contextMenu.type === 'selection' ? contextMenu.selectedTextStart : undefined,
              })?.annotation
            : undefined;
      const result = await createLessonFromSelection({
        annotationNote: attachedAnnotation?.note,
        contextAfter: contextMenu.contextAfter,
        contextBefore: contextMenu.contextBefore,
        instructions,
        selectedText,
      });

      if (result.outcome === 'created') {
        if (isMobileViewport) {
          clearNativeSelection();
        }
        closeContextMenu();
        return;
      }

      if (result.outcome === 'ignored-busy') {
        return;
      }

      notify(
        result.errorMessage ||
          'Questo progetto non ha un file sorgente collegato. Ricollega il PDF o lo ZIP prima di creare una sottolezione.'
      );
    },
    [
      closeContextMenu,
      contextMenu,
      createLessonFromSelection,
      getCurrentSection,
      isMobileViewport,
      notify,
      sectionContent,
    ]
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
      selectedTextStart: contextMenu.selectedTextStart,
    });

    if (!result) {
      notify(
        t(
          'Non sono riuscito a evidenziare questa selezione in modo affidabile. Prova con una selezione leggermente piu corta.'
        )
      );
      return;
    }

    updateSectionPreservingReaderScroll(activeSectionId, section => ({
      ...section,
      annotations: result.annotations,
    }));
    persistSectionAnnotationsPreservingReaderScroll(activeSectionId, result.annotations);
    closeContextMenu();
    clearNativeSelection();
  }, [
    activeSectionId,
    closeContextMenu,
    contextMenu,
    getCurrentSection,
    notify,
    persistSectionAnnotationsPreservingReaderScroll,
    sectionContent,
    updateSectionPreservingReaderScroll,
  ]);

  const handleSaveNote = useCallback(
    (note: string, artifactRefs?: SectionAnnotationArtifactRef[]) => {
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
          artifactRefs,
          note,
          selectedText: contextMenu.selectedText,
          selectedTextStart: contextMenu.selectedTextStart,
        });

        if (!result) {
          notify(
            t(
              'Non sono riuscito a associare la nota a questa selezione. Prova a selezionare un frammento un po più preciso.'
            )
          );
          return;
        }

        updateSectionPreservingReaderScroll(activeSectionId, section => ({
          ...section,
          annotations: result.annotations,
        }));
        persistSectionAnnotationsPreservingReaderScroll(activeSectionId, result.annotations);
        closeContextMenu();
        clearNativeSelection();
        return;
      }

      if (contextMenu.type !== 'annotation') {
        return;
      }

      const result = updateSectionAnnotationNote({
        annotationId: contextMenu.annotationId,
        annotations: currentSection.annotations,
        note,
      });

      if (!result) {
        notify(t('Non ho trovato questa annotazione. Riprova dopo aver ricaricato la sezione.'));
        return;
      }

      updateSectionPreservingReaderScroll(activeSectionId, section => ({
        ...section,
        annotations: result.annotations,
      }));
      persistSectionAnnotationsPreservingReaderScroll(activeSectionId, result.annotations);
      closeContextMenu();
    },
    [
      activeSectionId,
      closeContextMenu,
      contextMenu,
      getCurrentSection,
      notify,
      persistSectionAnnotationsPreservingReaderScroll,
      sectionContent,
      updateSectionPreservingReaderScroll,
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
    });

    if (!result.removed) {
      notify(t('Non sono riuscito a rimuovere questo highlight. Riprova.'));
      return;
    }

    updateSectionPreservingReaderScroll(activeSectionId, section => ({
      ...section,
      annotations: result.annotations,
    }));
    persistSectionAnnotationsPreservingReaderScroll(activeSectionId, result.annotations);
    closeContextMenu();
  }, [
    activeSectionId,
    closeContextMenu,
    contextMenu,
    getCurrentSection,
    notify,
    persistSectionAnnotationsPreservingReaderScroll,
    updateSectionPreservingReaderScroll,
  ]);

  const handleAttachArtifactToAnnotation = useCallback(
    (artifactRef: SectionAnnotationArtifactRef) => {
      if (!activeSectionId || contextMenu.type !== 'annotation') {
        return;
      }

      const currentSection = getCurrentSection();
      if (!currentSection) {
        return;
      }

      const result = upsertSectionAnnotationArtifactRefs({
        annotationId: contextMenu.annotationId,
        annotations: currentSection.annotations,
        artifactRefs: [artifactRef],
      });

      if (!result) {
        notify(t('Non ho trovato questa annotazione. Riprova dopo aver ricaricato la sezione.'));
        return;
      }

      updateSectionPreservingReaderScroll(activeSectionId, section => ({
        ...section,
        annotations: result.annotations,
      }));
      persistSectionAnnotationsPreservingReaderScroll(activeSectionId, result.annotations);
    },
    [
      activeSectionId,
      contextMenu,
      getCurrentSection,
      notify,
      persistSectionAnnotationsPreservingReaderScroll,
      updateSectionPreservingReaderScroll,
    ]
  );

  const handleDetachArtifactFromAnnotation = useCallback(
    (artifactId: string) => {
      if (!activeSectionId || contextMenu.type !== 'annotation') {
        return;
      }

      const currentSection = getCurrentSection();
      if (!currentSection) {
        return;
      }

      const result = removeSectionAnnotationArtifactRef({
        annotationId: contextMenu.annotationId,
        annotations: currentSection.annotations,
        artifactId,
      });

      if (!result) {
        notify(
          t('Non ho trovato questo allegato nella nota. Riprova dopo aver ricaricato la sezione.')
        );
        return;
      }

      updateSectionPreservingReaderScroll(activeSectionId, section => ({
        ...section,
        annotations: result.annotations,
      }));
      persistSectionAnnotationsPreservingReaderScroll(activeSectionId, result.annotations);
    },
    [
      activeSectionId,
      contextMenu,
      getCurrentSection,
      notify,
      persistSectionAnnotationsPreservingReaderScroll,
      updateSectionPreservingReaderScroll,
    ]
  );

  const handleSaveConversationNote = useCallback(
    async ({
      artifactRefs,
      fallbackSelection,
      generatedVisuals,
      contextAfter,
      contextBefore,
      note,
      selectedText,
      selectedTextStart,
    }: SaveConversationNoteInput): Promise<SaveConversationNoteResult> => {
      if (!activeSectionId) {
        return {
          saved: false,
          merged: false,
          error: t('La sezione attiva non e disponibile.'),
        };
      }

      const currentSection = getCurrentSection();
      if (!currentSection) {
        return {
          saved: false,
          merged: false,
          error: t('Non ho trovato la sezione corrente.'),
        };
      }

      const trySave = (input: {
        contextAfter?: string;
        contextBefore?: string;
        selectedText: string;
        selectedTextStart?: number;
      }) =>
        applySectionAnnotation({
          annotations: currentSection.annotations,
          artifactRefs,
          content: currentSection.content || sectionContent,
          contextAfter: input.contextAfter,
          contextBefore: input.contextBefore,
          note,
          selectedText: input.selectedText,
          selectedTextStart: input.selectedTextStart,
        });

      const primaryResult = trySave({
        contextAfter,
        contextBefore,
        selectedText,
        selectedTextStart,
      });

      const fallbackResult =
        !primaryResult && fallbackSelection
          ? trySave({
              contextAfter: fallbackSelection.contextAfter,
              contextBefore: fallbackSelection.contextBefore,
              selectedText: fallbackSelection.selectedText,
              selectedTextStart: fallbackSelection.selectedTextStart,
            })
          : null;

      const result = primaryResult || fallbackResult;

      if (!result) {
        return {
          saved: false,
          merged: false,
          error: t(
            'Non sono riuscito a ritrovare il passaggio da annotare nella lezione corrente.'
          ),
        };
      }

      const nextGeneratedVisuals = mergeGeneratedVisuals(
        currentSection.generatedVisuals,
        generatedVisuals
      );

      updateSection(activeSectionId, section => ({
        ...section,
        annotations: result.annotations,
        generatedVisuals: nextGeneratedVisuals,
      }));
      const persisted = await patchSectionAnnotations(
        activeSectionId,
        result.annotations,
        undefined,
        nextGeneratedVisuals
      );

      if (!persisted) {
        return {
          saved: false,
          merged: result.merged,
          error: t('Non sono riuscito a salvare la nota.'),
        };
      }

      return {
        saved: true,
        annotationId: result.annotationId,
        merged: result.merged,
        resolvedText: result.resolvedText,
      };
    },
    [activeSectionId, getCurrentSection, patchSectionAnnotations, sectionContent, updateSection]
  );

  const handleUpdateConversationNote = useCallback(
    async ({
      artifactRefs,
      fallbackSelection,
      generatedVisuals,
      contextAfter,
      contextBefore,
      note,
      selectedText,
      selectedTextStart,
    }: SaveConversationNoteInput): Promise<SaveConversationNoteResult> => {
      if (!activeSectionId) {
        return {
          saved: false,
          merged: false,
          error: t('La sezione attiva non e disponibile.'),
        };
      }

      const currentSection = getCurrentSection();
      if (!currentSection) {
        return {
          saved: false,
          merged: false,
          error: t('Non ho trovato la sezione corrente.'),
        };
      }

      const resolveMatch = (input: {
        contextAfter?: string;
        contextBefore?: string;
        selectedText: string;
        selectedTextStart?: number;
      }) =>
        findSectionAnnotationForSelection({
          annotations: currentSection.annotations,
          content: currentSection.content || sectionContent,
          contextAfter: input.contextAfter,
          contextBefore: input.contextBefore,
          selectedText: input.selectedText,
          selectedTextStart: input.selectedTextStart,
        });

      const match =
        resolveMatch({ contextAfter, contextBefore, selectedText, selectedTextStart }) ||
        (fallbackSelection
          ? resolveMatch({
              contextAfter: fallbackSelection.contextAfter,
              contextBefore: fallbackSelection.contextBefore,
              selectedText: fallbackSelection.selectedText,
              selectedTextStart: fallbackSelection.selectedTextStart,
            })
          : null);

      if (!match) {
        return {
          saved: false,
          merged: false,
          error: t('Non ho trovato una nota esistente collegata a questo passaggio da aggiornare.'),
        };
      }

      const result = updateSectionAnnotationNote({
        annotationId: match.annotation.id,
        annotations: currentSection.annotations,
        artifactRefs,
        note,
      });

      if (!result) {
        return {
          saved: false,
          merged: false,
          error: t('Non sono riuscito ad aggiornare la nota esistente.'),
        };
      }

      const nextGeneratedVisuals = mergeGeneratedVisuals(
        currentSection.generatedVisuals,
        generatedVisuals
      );

      updateSection(activeSectionId, section => ({
        ...section,
        annotations: result.annotations,
        generatedVisuals: nextGeneratedVisuals,
      }));
      const persisted = await patchSectionAnnotations(
        activeSectionId,
        result.annotations,
        undefined,
        nextGeneratedVisuals
      );

      if (!persisted) {
        return {
          saved: false,
          merged: false,
          error: t('Non sono riuscito a salvare la nota.'),
        };
      }

      return {
        saved: true,
        annotationId: match.annotation.id,
        merged: false,
        resolvedText: match.resolvedText,
      };
    },
    [activeSectionId, getCurrentSection, patchSectionAnnotations, sectionContent, updateSection]
  );

  const handleCompleteSection = useCallback(async () => {
    const result = await completeActiveSection();
    if (result === 'journey-complete') {
      notify('Percorso completato! Ricordati di esportare il tuo progresso.');
    }
  }, [completeActiveSection, notify]);

  const handleAdvanceSection = useCallback(async () => {
    const result = await advanceActiveSection();
    if (result === 'journey-complete') {
      notify("Hai gia raggiunto l'ultima lezione disponibile.");
    }
  }, [advanceActiveSection, notify]);

  const handleSelectSection = useCallback(
    (section: LessonNode) => {
      if (isMobileViewport) {
        setIsMobileSidebarOpen(false);
      }

      void openSection(section).catch(error => {
        notify(getErrorMessage(error));
      });
    },
    [isMobileViewport, notify, openSection, setIsMobileSidebarOpen]
  );

  const handleSelectExercise = useCallback(
    (exercise: ApplicationExerciseNode) => {
      if (isMobileViewport) {
        setIsMobileSidebarOpen(false);
      }

      void openExercise(exercise).catch(error => {
        notify(getErrorMessage(error));
      });
    },
    [isMobileViewport, notify, openExercise, setIsMobileSidebarOpen]
  );

  const handleSaveArtifactToLesson = useCallback(
    async (
      visual: StoredLessonVisual,
      artifactRef: { artifactId: string; kind: 'generated-visual'; title: string }
    ): Promise<void> => {
      if (!activeSectionId) return;

      const currentSection = getCurrentSection();
      if (!currentSection) return;

      const nextGeneratedVisuals = mergeGeneratedVisuals(currentSection.generatedVisuals, [visual]);

      const annotationResult = createLessonSectionAnnotation({
        annotations: currentSection.annotations,
        artifactRefs: [artifactRef],
        note: '',
      });

      updateSection(activeSectionId, section => ({
        ...section,
        annotations: annotationResult.annotations,
        generatedVisuals: nextGeneratedVisuals,
      }));
      await patchSectionAnnotations(
        activeSectionId,
        annotationResult.annotations,
        undefined,
        nextGeneratedVisuals
      );
    },
    [activeSectionId, getCurrentSection, patchSectionAnnotations, updateSection]
  );

  const handleReplaceArtifactInLesson = useCallback(
    async (artifactId: string, visual: StoredLessonVisual): Promise<void> => {
      if (!activeSectionId) return;

      const currentSection = getCurrentSection();
      if (!currentSection) return;

      const nextGeneratedVisuals = replaceGeneratedVisualPreservingId({
        artifactId,
        replacementVisual: visual,
        visuals: currentSection.generatedVisuals,
      });
      if (!nextGeneratedVisuals) return;

      updateSection(activeSectionId, section => ({
        ...section,
        generatedVisuals: nextGeneratedVisuals,
      }));

      await patchSectionAnnotations(
        activeSectionId,
        currentSection.annotations,
        undefined,
        nextGeneratedVisuals
      );
    },
    [activeSectionId, getCurrentSection, patchSectionAnnotations, updateSection]
  );

  return {
    handleAdvanceSection,
    handleAttachArtifactToAnnotation,
    handleCompleteSection,
    handleContextQuestion,
    handleCreateLesson,
    handleDeleteAnnotation,
    handleDetachArtifactFromAnnotation,
    handleHighlight,
    handleRegenerateActiveSection,
    handleSaveConversationNote,
    handleUpdateConversationNote,
    handleSaveNote,
    handleSelectExercise,
    handleSelectSection,
    handleSaveArtifactToLesson,
    handleReplaceArtifactInLesson,
  };
};
