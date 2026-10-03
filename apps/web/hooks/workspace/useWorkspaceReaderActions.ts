import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type {
  ContextLessonMutationTarget,
  SaveConversationNoteInput,
  SaveConversationNoteResult,
} from '../../components/workspace/shell/types.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  LESSON_SOURCE_UNAVAILABLE_MESSAGE,
  LessonSourceUnavailableError,
} from '../../services/openrouter/lessonGenerationClient.ts';
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
import type { ResolvedLessonSourceReference } from '../../utils/context/sourceMaterial.ts';
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
import type { CreateLessonOutcome, OpenSectionOutcome } from './controller/types.ts';

interface UseWorkspaceReaderActionsArgs {
  activeSectionId: string | null;
  advanceActiveSection: () => Promise<'journey-complete' | 'noop' | 'opened-next'>;
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
    documentSourceReferences?: ResolvedLessonSourceReference[];
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
  regenerateActiveSection: () => Promise<OpenSectionOutcome>;
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

  // Re-renders after an annotation change can move the reader; restore the offset the
  // user saw when the context menu opened.
  const captureReaderScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    const scrollTop = contextMenuScrollTopRef.current ?? scrollContainer?.scrollTop;
    return (onlyWhileActiveSectionId?: string) => {
      if (!scrollContainer || scrollTop === undefined) return;
      globalThis.requestAnimationFrame(() => {
        if (
          scrollContainerRef.current === scrollContainer &&
          (onlyWhileActiveSectionId === undefined ||
            activeSectionIdRef.current === onlyWhileActiveSectionId)
        ) {
          scrollContainer.scrollTop = scrollTop;
        }
      });
    };
  }, [contextMenuScrollTopRef, scrollContainerRef]);
  const updateSectionPreservingReaderScroll = useCallback(
    (sectionId: string, updater: (section: LessonNode) => LessonNode) => {
      const restoreScroll = captureReaderScroll();
      updateSection(sectionId, updater);
      restoreScroll();
    },
    [captureReaderScroll, updateSection]
  );
  /**
   * Applies an annotation change to a section and persists it. The active section keeps
   * the reader's scroll position across both steps.
   */
  const commitSectionAnnotations = useCallback(
    (
      sectionId: string,
      change: Pick<LessonNode, 'annotations' | 'generatedVisuals'>
    ): Promise<boolean> => {
      const persist = () =>
        patchSectionAnnotations(sectionId, change.annotations, undefined, change.generatedVisuals);
      if (sectionId !== activeSectionIdRef.current) {
        updateSection(sectionId, section => ({ ...section, ...change }));
        return persist();
      }
      updateSectionPreservingReaderScroll(sectionId, section => ({ ...section, ...change }));
      const restoreScroll = captureReaderScroll();
      return persist().finally(() => restoreScroll(sectionId));
    },
    [
      captureReaderScroll,
      patchSectionAnnotations,
      updateSection,
      updateSectionPreservingReaderScroll,
    ]
  );
  const getSectionById = useCallback(
    (sectionId: string | undefined) => {
      if (!sectionId || !learningPlan) {
        return null;
      }

      return flattenLessons(learningPlan.modules).find(section => section.id === sectionId) || null;
    },
    [learningPlan]
  );
  const getCurrentSection = useCallback(() => {
    if (!activeSectionId) {
      return null;
    }

    return getSectionById(activeSectionId);
  }, [activeSectionId, getSectionById]);

  const resolveMutationSection = useCallback(
    ({ lessonId, projectId: targetProjectId }: ContextLessonMutationTarget) => {
      if (!lessonId || !projectId) {
        return { error: t('Non ho trovato la sezione corrente.') } as const;
      }
      if (targetProjectId && targetProjectId !== projectId) {
        return { error: t('Il corso originale non è più attivo.') } as const;
      }

      const section = getSectionById(lessonId);
      return section
        ? ({ lessonId, section } as const)
        : ({ error: t('Non ho trovato la sezione corrente.') } as const);
    },
    [getSectionById, projectId]
  );

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
        documentSourceReferences: sourceContext.documentSourceReferences,
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
      notify(
        error instanceof LessonSourceUnavailableError
          ? t(LESSON_SOURCE_UNAVAILABLE_MESSAGE)
          : getErrorMessage(error)
      );
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

    void commitSectionAnnotations(activeSectionId, { annotations: result.annotations });
    closeContextMenu();
    clearNativeSelection();
  }, [
    activeSectionId,
    closeContextMenu,
    contextMenu,
    getCurrentSection,
    notify,
    commitSectionAnnotations,
    sectionContent,
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

        void commitSectionAnnotations(activeSectionId, { annotations: result.annotations });
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

      void commitSectionAnnotations(activeSectionId, { annotations: result.annotations });
      closeContextMenu();
    },
    [
      activeSectionId,
      closeContextMenu,
      contextMenu,
      getCurrentSection,
      notify,
      commitSectionAnnotations,
      sectionContent,
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

    void commitSectionAnnotations(activeSectionId, { annotations: result.annotations });
    closeContextMenu();
  }, [
    activeSectionId,
    closeContextMenu,
    contextMenu,
    getCurrentSection,
    notify,
    commitSectionAnnotations,
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

      void commitSectionAnnotations(activeSectionId, { annotations: result.annotations });
    },
    [activeSectionId, contextMenu, getCurrentSection, notify, commitSectionAnnotations]
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

      void commitSectionAnnotations(activeSectionId, { annotations: result.annotations });
    },
    [activeSectionId, contextMenu, getCurrentSection, notify, commitSectionAnnotations]
  );

  const handleSaveConversationNote = useCallback(
    async (
      target: ContextLessonMutationTarget,
      {
        artifactRefs,
        fallbackSelection,
        generatedVisuals,
        contextAfter,
        contextBefore,
        note,
        selectedText,
        selectedTextStart,
      }: SaveConversationNoteInput
    ): Promise<SaveConversationNoteResult> => {
      const resolution = resolveMutationSection(target);
      if ('error' in resolution) {
        return {
          saved: false,
          merged: false,
          error: resolution.error,
        };
      }
      const { lessonId, section } = resolution;

      const trySave = (input: {
        contextAfter?: string;
        contextBefore?: string;
        preferredSelection?: SaveConversationNoteInput['fallbackSelection'];
        selectedText: string;
        selectedTextStart?: number;
      }) =>
        applySectionAnnotation({
          annotations: section.annotations,
          artifactRefs,
          content: section.content || (lessonId === activeSectionId ? sectionContent : ''),
          contextAfter: input.contextAfter,
          contextBefore: input.contextBefore,
          note,
          preferredSelection: input.preferredSelection,
          selectedText: input.selectedText,
          selectedTextStart: input.selectedTextStart,
        });

      const primaryResult = trySave({
        contextAfter,
        contextBefore,
        preferredSelection: fallbackSelection,
        selectedText,
        selectedTextStart,
      });

      const fallbackResult =
        !primaryResult && fallbackSelection
          ? trySave({
              contextAfter: fallbackSelection.contextAfter,
              contextBefore: fallbackSelection.contextBefore,
              preferredSelection: fallbackSelection,
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
        section.generatedVisuals,
        generatedVisuals
      );

      const persisted = await commitSectionAnnotations(lessonId, {
        annotations: result.annotations,
        generatedVisuals: nextGeneratedVisuals,
      });

      if (!persisted) {
        (lessonId === activeSectionIdRef.current
          ? updateSectionPreservingReaderScroll
          : updateSection)(lessonId, currentLesson => ({
          ...currentLesson,
          annotations:
            currentLesson.annotations === result.annotations
              ? section.annotations
              : currentLesson.annotations,
          generatedVisuals:
            currentLesson.generatedVisuals === nextGeneratedVisuals
              ? section.generatedVisuals
              : currentLesson.generatedVisuals,
        }));
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
    [
      activeSectionId,
      commitSectionAnnotations,
      resolveMutationSection,
      sectionContent,
      updateSection,
      updateSectionPreservingReaderScroll,
    ]
  );

  const handleUpdateConversationNote = useCallback(
    async (
      target: ContextLessonMutationTarget,
      {
        artifactRefs,
        fallbackSelection,
        generatedVisuals,
        contextAfter,
        contextBefore,
        note,
        selectedText,
        selectedTextStart,
      }: SaveConversationNoteInput
    ): Promise<SaveConversationNoteResult> => {
      const resolution = resolveMutationSection(target);
      if ('error' in resolution) {
        return {
          saved: false,
          merged: false,
          error: resolution.error,
        };
      }
      const { lessonId, section } = resolution;

      const resolveMatch = (input: {
        contextAfter?: string;
        contextBefore?: string;
        preferredSelection?: SaveConversationNoteInput['fallbackSelection'];
        selectedText: string;
        selectedTextStart?: number;
      }) =>
        findSectionAnnotationForSelection({
          annotations: section.annotations,
          content: section.content || (lessonId === activeSectionId ? sectionContent : ''),
          contextAfter: input.contextAfter,
          contextBefore: input.contextBefore,
          preferredSelection: input.preferredSelection,
          selectedText: input.selectedText,
          selectedTextStart: input.selectedTextStart,
        });

      const match =
        resolveMatch({
          contextAfter,
          contextBefore,
          preferredSelection: fallbackSelection,
          selectedText,
          selectedTextStart,
        }) ||
        (fallbackSelection
          ? resolveMatch({
              contextAfter: fallbackSelection.contextAfter,
              contextBefore: fallbackSelection.contextBefore,
              preferredSelection: fallbackSelection,
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
        annotations: section.annotations,
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
        section.generatedVisuals,
        generatedVisuals
      );

      const persisted = await commitSectionAnnotations(lessonId, {
        annotations: result.annotations,
        generatedVisuals: nextGeneratedVisuals,
      });

      if (!persisted) {
        (lessonId === activeSectionIdRef.current
          ? updateSectionPreservingReaderScroll
          : updateSection)(lessonId, currentLesson => ({
          ...currentLesson,
          annotations:
            currentLesson.annotations === result.annotations
              ? section.annotations
              : currentLesson.annotations,
          generatedVisuals:
            currentLesson.generatedVisuals === nextGeneratedVisuals
              ? section.generatedVisuals
              : currentLesson.generatedVisuals,
        }));
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
    [
      activeSectionId,
      commitSectionAnnotations,
      resolveMutationSection,
      sectionContent,
      updateSection,
      updateSectionPreservingReaderScroll,
    ]
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
      target: ContextLessonMutationTarget,
      visual: StoredLessonVisual,
      artifactRef: { artifactId: string; kind: 'generated-visual'; title: string }
    ) => {
      const resolution = resolveMutationSection(target);
      if ('error' in resolution) {
        return { error: resolution.error, succeeded: false };
      }
      const { lessonId, section } = resolution;

      const nextGeneratedVisuals = mergeGeneratedVisuals(section.generatedVisuals, [visual]);

      const annotationResult = createLessonSectionAnnotation({
        annotations: section.annotations,
        artifactRefs: [artifactRef],
        note: '',
      });

      updateSection(lessonId, currentLesson => ({
        ...currentLesson,
        annotations: annotationResult.annotations,
        generatedVisuals: nextGeneratedVisuals,
      }));
      const persisted = await patchSectionAnnotations(
        lessonId,
        annotationResult.annotations,
        undefined,
        nextGeneratedVisuals
      );
      if (!persisted) {
        updateSection(lessonId, currentLesson => ({
          ...currentLesson,
          annotations:
            currentLesson.annotations === annotationResult.annotations
              ? section.annotations
              : currentLesson.annotations,
          generatedVisuals:
            currentLesson.generatedVisuals === nextGeneratedVisuals
              ? section.generatedVisuals
              : currentLesson.generatedVisuals,
        }));
      }
      return persisted
        ? { succeeded: true }
        : { error: t("Non sono riuscito a salvare l'artefatto."), succeeded: false };
    },
    [patchSectionAnnotations, resolveMutationSection, updateSection]
  );

  const handleReplaceArtifactInLesson = useCallback(
    async (target: ContextLessonMutationTarget, artifactId: string, visual: StoredLessonVisual) => {
      const resolution = resolveMutationSection(target);
      if ('error' in resolution) {
        return { error: resolution.error, succeeded: false };
      }
      const { lessonId, section } = resolution;

      const nextGeneratedVisuals = replaceGeneratedVisualPreservingId({
        artifactId,
        contentBlocks: section.contentBlocks,
        replacementVisual: visual,
        visuals: section.generatedVisuals,
      });
      if (!nextGeneratedVisuals) {
        return { error: t("Non ho trovato l'artefatto da sostituire."), succeeded: false };
      }

      updateSection(lessonId, currentLesson => ({
        ...currentLesson,
        generatedVisuals: nextGeneratedVisuals,
      }));

      const persisted = await patchSectionAnnotations(
        lessonId,
        undefined,
        undefined,
        nextGeneratedVisuals
      );
      if (!persisted) {
        updateSection(lessonId, currentLesson => ({
          ...currentLesson,
          generatedVisuals:
            currentLesson.generatedVisuals === nextGeneratedVisuals
              ? section.generatedVisuals
              : currentLesson.generatedVisuals,
        }));
      }
      return persisted
        ? { succeeded: true }
        : { error: t("Non sono riuscito a sostituire l'artefatto."), succeeded: false };
    },
    [patchSectionAnnotations, resolveMutationSection, updateSection]
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
