import { useWorkspaceAssessmentScreen } from '../../hooks/workspace/useWorkspaceAssessmentScreen.ts';
import type { useWorkspaceNavigation } from '../../hooks/workspace/useWorkspaceNavigation.ts';
import type { useWorkspaceReaderState } from '../../hooks/workspace/useWorkspaceReaderState.ts';
import type { AppState, Message } from '../../types.ts';
import AssessmentView from './AssessmentView.tsx';

type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;
type WorkspaceReaderState = ReturnType<typeof useWorkspaceReaderState>;

interface AssessmentScreenContainerProps {
  readonly assessmentMessages: Message[];
  readonly isLoading: boolean;
  readonly loadingStatus: string;
  readonly navigation: WorkspaceNavigation;
  readonly notify: (message: string) => void;
  readonly readerState: WorkspaceReaderState;
  readonly screenState: AppState;
  readonly startLearnJourney: () => Promise<{
    errorMessage?: string;
    outcome: 'failed' | 'started';
  }>;
  readonly submitAssessment: (input: string) => Promise<{
    errorMessage?: string;
    outcome: 'abandoned' | 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned';
  }>;
}

export const AssessmentScreenContainer = ({
  assessmentMessages,
  isLoading,
  loadingStatus,
  navigation,
  notify,
  readerState,
  screenState,
  startLearnJourney,
  submitAssessment,
}: AssessmentScreenContainerProps) => {
  const assessmentScreen = useWorkspaceAssessmentScreen({
    assessmentMessages,
    notify,
    screenState,
    startLearnJourney,
    submitAssessment,
  });

  return (
    <AssessmentView
      assessmentInputId={assessmentScreen.assessmentInputId}
      assessmentInputRef={assessmentScreen.assessmentInputRef}
      currentAssessmentInput={assessmentScreen.currentAssessmentInput}
      isDarkMode={readerState.readerChrome.isDarkMode}
      isLoading={isLoading}
      loadingStatus={loadingStatus}
      messages={assessmentMessages}
      messagesEndRef={assessmentScreen.messagesEndRef}
      onBackToLibrary={navigation.handleBackToLibrary}
      onInputChange={assessmentScreen.setCurrentAssessmentInput}
      onSubmit={assessmentScreen.handleAssessmentSubmit}
    />
  );
};
