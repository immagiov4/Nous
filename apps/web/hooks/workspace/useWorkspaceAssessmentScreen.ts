// fallow-ignore-file unused-files
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { AppState, type Message } from '../../types.ts';

interface UseWorkspaceAssessmentScreenArgs {
  assessmentMessages: Message[];
  notify: (message: string) => void;
  screenState: AppState;
  startLearnJourney: () => Promise<{ errorMessage?: string; outcome: 'failed' | 'started' }>;
  submitAssessment: (input: string) => Promise<{
    errorMessage?: string;
    outcome: 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned';
  }>;
}

// fallow-ignore-next-line unused-exports — used by App.tsx
export const useWorkspaceAssessmentScreen = ({
  assessmentMessages,
  notify,
  screenState,
  startLearnJourney,
  submitAssessment,
}: UseWorkspaceAssessmentScreenArgs) => {
  const [currentAssessmentInput, setCurrentAssessmentInput] = useState('');
  const assessmentInputId = useId();
  const assessmentInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const assessmentMessageCount = assessmentMessages.length;

  useEffect(() => {
    if (screenState !== AppState.ASSESSMENT) {
      return;
    }

    messagesEndRef.current?.scrollIntoView({
      behavior: assessmentMessageCount > 0 ? 'smooth' : 'auto',
    });
    assessmentInputRef.current?.focus();
  }, [assessmentMessageCount, screenState]);

  const handleStartLearnJourney = async () => {
    const result = await startLearnJourney();
    if (result.errorMessage) {
      notify(result.errorMessage);
    }
  };

  const handleAssessmentSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const submittedInput = currentAssessmentInput;
    setCurrentAssessmentInput('');
    const result = await submitAssessment(submittedInput);
    if (result.outcome === 'noop') {
      setCurrentAssessmentInput(submittedInput);
    }
    if (result.errorMessage) {
      notify(result.errorMessage);
    }
  };

  return {
    assessmentInputId,
    assessmentInputRef,
    currentAssessmentInput,
    handleAssessmentSubmit,
    handleStartLearnJourney,
    messagesEndRef,
    setCurrentAssessmentInput,
  };
};
