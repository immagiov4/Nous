import { useWorkspaceAssessmentScreen } from '../../hooks/workspace/useWorkspaceAssessmentScreen.ts';
import type { useWorkspaceNavigation } from '../../hooks/workspace/useWorkspaceNavigation.ts';
import type { useWorkspaceReaderState } from '../../hooks/workspace/useWorkspaceReaderState.ts';
import type { AppState, Message } from '../../types.ts';
import AssessmentView from './AssessmentView.tsx';

type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;
type WorkspaceReaderState = ReturnType<typeof useWorkspaceReaderState>;

interface AssessmentScreenContainerProps {
  readonly assessmentMessages: Message[];
  readonly cancelAssessment: () => Promise<void>;
  readonly confirmPlanGeneration: () => Promise<{
    errorMessage?: string;
    outcome: 'failed' | 'planned';
  }>;
  readonly hasCourseProposal: boolean;
  readonly isLoading: boolean;
  readonly loadingStatus: string;
  readonly navigation: WorkspaceNavigation;
  readonly notify: (message: string) => void;
  readonly readerState: WorkspaceReaderState;
  readonly screenState: AppState;
  readonly submitAssessment: (input: string) => Promise<{
    errorMessage?: string;
    outcome: 'abandoned' | 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned';
  }>;
}

export const AssessmentScreenContainer = ({
  assessmentMessages,
  cancelAssessment,
  confirmPlanGeneration,
  hasCourseProposal,
  isLoading,
  loadingStatus,
  navigation,
  notify,
  readerState,
  screenState,
  submitAssessment,
}: AssessmentScreenContainerProps) => {
  const assessmentScreen = useWorkspaceAssessmentScreen({
    assessmentMessages,
    cancelAssessment,
    confirmPlanGeneration,
    notify,
    screenState,
    submitAssessment,
  });

  return (
    <AssessmentView
      assessmentInputId={assessmentScreen.assessmentInputId}
      assessmentInputRef={assessmentScreen.assessmentInputRef}
      currentAssessmentInput={assessmentScreen.currentAssessmentInput}
      hasCourseProposal={hasCourseProposal}
      isDarkMode={readerState.readerChrome.isDarkMode}
      isLoading={isLoading}
      loadingStatus={loadingStatus}
      messages={assessmentMessages}
      messagesEndRef={assessmentScreen.messagesEndRef}
      onBackToLibrary={navigation.handleBackToLibrary}
      onCancelAssessment={assessmentScreen.handleCancelAssessment}
      onConfirmGenerate={assessmentScreen.handleConfirmPlanGeneration}
      onInputChange={assessmentScreen.setCurrentAssessmentInput}
      onSubmit={assessmentScreen.handleAssessmentSubmit}
    />
  );
};
