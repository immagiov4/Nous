// fallow-ignore-file unused-files
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type LearningPlan, type LessonNode } from '../types.ts';
import { flattenLessons } from '../utils/learning/pathNodes.ts';

interface UseInitialSectionAutoOpenArgs {
  activeSection: LessonNode | null;
  currentProjectId: string | null;
  isBlocking: boolean;
  learningPlan: LearningPlan | null;
  openSection: (section: LessonNode) => Promise<unknown>;
  screenState: AppState;
}

const getPlanAcknowledgementKey = ({
  currentProjectId,
  learningPlan,
}: Pick<UseInitialSectionAutoOpenArgs, 'currentProjectId' | 'learningPlan'>): string =>
  currentProjectId || learningPlan?.title || '';

// fallow-ignore-next-line unused-exports — used by App.tsx
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

    const planHasGeneratedContent = flattenLessons(learningPlan.modules).some(section =>
      Boolean(section.content)
    );
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
