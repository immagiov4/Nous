import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type LearningPlan, type LearningSection } from '../types.ts';

interface UseInitialSectionAutoOpenArgs {
  activeSection: LearningSection | null;
  currentProjectId: string | null;
  isBlocking: boolean;
  learningPlan: LearningPlan | null;
  openSection: (section: LearningSection) => Promise<unknown>;
  screenState: AppState;
}

const getPlanAcknowledgementKey = ({
  currentProjectId,
  learningPlan,
}: Pick<UseInitialSectionAutoOpenArgs, 'currentProjectId' | 'learningPlan'>): string =>
  currentProjectId || learningPlan?.title || '';

export const useInitialSectionAutoOpen = ({
  activeSection,
  currentProjectId,
  isBlocking,
  learningPlan,
  openSection,
  screenState,
}: UseInitialSectionAutoOpenArgs) => {
  const [isNotesDialogOpen, setIsNotesDialogOpen] = useState(false);
  const notesDialogAckedPlanIdsRef = useRef<Set<string>>(new Set());
  const autoOpenAttemptedSectionIdsRef = useRef<Set<string>>(new Set());
  const previousAutoOpenProjectIdRef = useRef(currentProjectId);

  const acknowledgeGenerationNotesDialog = useCallback(() => {
    const ackKey = getPlanAcknowledgementKey({ currentProjectId, learningPlan });
    if (ackKey) {
      notesDialogAckedPlanIdsRef.current.add(ackKey);
    }
    setIsNotesDialogOpen(false);
  }, [currentProjectId, learningPlan]);

  useEffect(() => {
    if (screenState !== AppState.READING || !learningPlan || !activeSection || isBlocking) {
      return;
    }
    if (activeSection.content) {
      return;
    }
    if (autoOpenAttemptedSectionIdsRef.current.has(activeSection.id)) {
      return;
    }

    const planHasGeneratedContent = learningPlan.sections.some(section => Boolean(section.content));
    const notes = learningPlan.generationNotes?.trim() || '';
    const ackKey = getPlanAcknowledgementKey({ currentProjectId, learningPlan });
    const shouldShowDialog =
      !planHasGeneratedContent &&
      !notes &&
      !notesDialogAckedPlanIdsRef.current.has(ackKey) &&
      !isNotesDialogOpen;

    if (shouldShowDialog) {
      setIsNotesDialogOpen(true);
      return;
    }

    autoOpenAttemptedSectionIdsRef.current.add(activeSection.id);
    void openSection(activeSection);
  }, [
    activeSection,
    currentProjectId,
    isBlocking,
    isNotesDialogOpen,
    learningPlan,
    openSection,
    screenState,
  ]);

  useEffect(() => {
    if (previousAutoOpenProjectIdRef.current === currentProjectId) {
      return;
    }

    previousAutoOpenProjectIdRef.current = currentProjectId;
    autoOpenAttemptedSectionIdsRef.current = new Set();
  }, [currentProjectId]);

  return {
    acknowledgeGenerationNotesDialog,
    isNotesDialogOpen,
  };
};
