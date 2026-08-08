import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { getErrorMessage } from '../../services/core/errorMessage.ts';
import { AppState, type Message } from '../../types.ts';

interface UseWorkspaceAssessmentScreenArgs {
  assessmentMessages: Message[];
  cancelAssessment: () => Promise<void>;
  confirmPlanGeneration: () => Promise<{
    errorMessage?: string;
    outcome: 'failed' | 'planned';
  }>;
  notify: (message: string) => void;
  screenState: AppState;
  submitAssessment: (input: string) => Promise<{
    errorMessage?: string;
    outcome: 'abandoned' | 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned';
  }>;
}

export const useWorkspaceAssessmentScreen = ({
  assessmentMessages,
  cancelAssessment,
  confirmPlanGeneration,
  notify,
  screenState,
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

  const handleCancelAssessment = async () => {
    try {
      await cancelAssessment();
    } catch (error) {
      notify(getErrorMessage(error));
    }
  };

  const handleConfirmPlanGeneration = async () => {
    const result = await confirmPlanGeneration();
    if (result.errorMessage) notify(result.errorMessage);
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
    handleCancelAssessment,
    handleAssessmentSubmit,
    handleConfirmPlanGeneration,
    messagesEndRef,
    setCurrentAssessmentInput,
  };
};
