import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  type LearningPlan,
  type LessonNode,
  type PdfTextIndex,
  type ProjectSource,
} from '../types.ts';
import { flattenLessons } from '../utils/learning/pathNodes.ts';
import { needsPdfProjectHydration } from '../utils/pdf/projectHydration.ts';

interface UseInitialSectionAutoOpenArgs {
  activeSection: LessonNode | null;
  currentProjectId: string | null;
  documentIndex: PdfTextIndex | null;
  isBlocking: boolean;
  learningPlan: LearningPlan | null;
  openSection: (section: LessonNode) => Promise<unknown>;
  screenState: AppState;
  source: ProjectSource | null;
}

const getPlanAcknowledgementKey = ({
  currentProjectId,
  learningPlan,
}: Pick<UseInitialSectionAutoOpenArgs, 'currentProjectId' | 'learningPlan'>): string =>
  currentProjectId || learningPlan?.title || '';

export const useInitialSectionAutoOpen = ({
  activeSection,
  currentProjectId,
  documentIndex,
  isBlocking,
  learningPlan,
  openSection,
  screenState,
  source,
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
    const pdfFile = source?.kind === 'pdf' ? source.file : null;
    if (
      screenState !== AppState.READING ||
      !learningPlan ||
      !activeSection ||
      isBlocking ||
      needsPdfProjectHydration(pdfFile, learningPlan, documentIndex)
    ) {
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
    documentIndex,
    isBlocking,
    isNotesDialogOpen,
    learningPlan,
    openSection,
    screenState,
    source,
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
