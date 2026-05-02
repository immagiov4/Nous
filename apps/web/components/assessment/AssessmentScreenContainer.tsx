// fallow-ignore-file unused-files
import { defaultModelConfig } from '../../app/modelDefaults.ts';
import { useWorkspaceAssessmentScreen } from '../../hooks/workspace/useWorkspaceAssessmentScreen.ts';
import type { useWorkspaceNavigation } from '../../hooks/workspace/useWorkspaceNavigation.ts';
import type { useWorkspaceReaderRuntime } from '../../hooks/workspace/useWorkspaceReaderRuntime.ts';
import type { AppState, Message } from '../../types.ts';
import AssessmentView from './AssessmentView.tsx';

type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;
type WorkspaceReaderRuntime = ReturnType<typeof useWorkspaceReaderRuntime>;

interface AssessmentScreenContainerProps {
  assessmentMessages: Message[];
  isLoading: boolean;
  loadingStatus: string;
  navigation: WorkspaceNavigation;
  notify: (message: string) => void;
  readerRuntime: WorkspaceReaderRuntime;
  screenState: AppState;
  startLearnJourney: () => Promise<{ errorMessage?: string; outcome: 'failed' | 'started' }>;
  submitAssessment: (input: string) => Promise<{
    errorMessage?: string;
    outcome: 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned';
  }>;
}

// fallow-ignore-next-line unused-exports — used by App.tsx
export const AssessmentScreenContainer = ({
  assessmentMessages,
  isLoading,
  loadingStatus,
  navigation,
  notify,
  readerRuntime,
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
      isDarkMode={readerRuntime.readerChrome.isDarkMode}
      isLoading={isLoading}
      loadingStatus={loadingStatus}
      messages={assessmentMessages}
      messagesEndRef={assessmentScreen.messagesEndRef}
      modelDefaults={defaultModelConfig}
      onBackToLibrary={navigation.handleBackToLibrary}
      onInputChange={assessmentScreen.setCurrentAssessmentInput}
      onSetPreferredOpenRouterModel={readerRuntime.setPreferredOpenRouterModel}
      onSubmit={assessmentScreen.handleAssessmentSubmit}
      preferredModels={readerRuntime.preferredModels}
    />
  );
};
