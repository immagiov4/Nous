import { useEffect, useRef, useState } from 'react';
import { pushLuminaDebugTrace } from '../../../services/core/debugTrace.ts';
import {
  createWorkspaceWorkflowState,
  invalidateWorkspaceWorkflows,
  type WorkspaceWorkflowId,
  type WorkspaceWorkflowState,
} from '../../../services/workspace/workflow.ts';
import { AppState, type Message } from '../../../types.ts';
import type { WorkspaceChatSession, WorkspaceControllerStateAdapter } from './types.ts';

export const useWorkspaceControllerState = () => {
  const [screenState, setScreenState] = useState<AppState>(AppState.LIBRARY);
  const [assessmentMessages, setAssessmentMessages] = useState<Message[]>([]);
  const [chatSession, setChatSession] = useState<WorkspaceChatSession | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [workflowState, setWorkflowState] = useState<WorkspaceWorkflowState>(
    createWorkspaceWorkflowState
  );

  const assessmentMessagesRef = useRef(assessmentMessages);
  const chatSessionRef = useRef(chatSession);
  const workflowStateRef = useRef(workflowState);

  useEffect(() => {
    assessmentMessagesRef.current = assessmentMessages;
  }, [assessmentMessages]);

  useEffect(() => {
    chatSessionRef.current = chatSession;
  }, [chatSession]);

  useEffect(() => {
    workflowStateRef.current = workflowState;
  }, [workflowState]);

  const commitWorkflowState = (nextState: WorkspaceWorkflowState) => {
    workflowStateRef.current = nextState;
    setWorkflowState(nextState);
  };

  return {
    assessmentMessages,
    openingProjectId,
    screenState,
    stateAdapter: {
      beginWorkflow: (workflowId: WorkspaceWorkflowId, message?: string) => {
        const currentState = workflowStateRef.current;
        const nextRequestId = currentState[workflowId].requestId + 1;
        const nextState = {
          ...currentState,
          [workflowId]: {
            status: 'pending' as const,
            message,
            error: undefined,
            requestId: nextRequestId,
          },
        };
        commitWorkflowState(nextState);
        pushLuminaDebugTrace('workflow:begin', { message, requestId: nextRequestId, workflowId });
        return nextRequestId;
      },
      failWorkflow: (workflowId: WorkspaceWorkflowId, requestId: number, errorMessage: string) => {
        const currentState = workflowStateRef.current;
        if (currentState[workflowId].requestId !== requestId) {
          return;
        }

        const nextState = {
          ...currentState,
          [workflowId]: {
            ...currentState[workflowId],
            status: 'failed' as const,
            error: errorMessage,
            message: undefined,
          },
        };
        commitWorkflowState(nextState);
        pushLuminaDebugTrace('workflow:fail', { errorMessage, requestId, workflowId });
      },
      getAssessmentMessages: () => assessmentMessagesRef.current,
      getChatSession: () => chatSessionRef.current,
      getWorkflowState: () => workflowStateRef.current,
      invalidateWorkflows: workflowIds => {
        const nextState = invalidateWorkspaceWorkflows(workflowStateRef.current, workflowIds);
        commitWorkflowState(nextState);
        pushLuminaDebugTrace('workflow:invalidate', { workflowIds });
      },
      isWorkflowCurrent: (workflowId: WorkspaceWorkflowId, requestId: number) =>
        workflowStateRef.current[workflowId].requestId === requestId,
      resetRuntimeState: () => {
        setAssessmentMessages([]);
        assessmentMessagesRef.current = [];
        setChatSession(null);
        chatSessionRef.current = null;
        setOpeningProjectId(null);
      },
      setAssessmentMessages: nextMessages => {
        setAssessmentMessages(currentMessages => {
          const resolvedMessages =
            typeof nextMessages === 'function' ? nextMessages(currentMessages) : nextMessages;
          assessmentMessagesRef.current = resolvedMessages;
          return resolvedMessages;
        });
      },
      setChatSession: nextChatSession => {
        chatSessionRef.current = nextChatSession;
        setChatSession(nextChatSession);
      },
      setOpeningProjectId,
      setScreenState,
      setWorkflowMessage: (
        workflowId: WorkspaceWorkflowId,
        requestId: number,
        message: string
      ) => {
        const currentState = workflowStateRef.current;
        if (currentState[workflowId].requestId !== requestId) {
          return;
        }

        const nextState = {
          ...currentState,
          [workflowId]: {
            ...currentState[workflowId],
            message,
          },
        };
        commitWorkflowState(nextState);
        pushLuminaDebugTrace('workflow:message', { message, requestId, workflowId });
      },
      succeedWorkflow: (
        workflowId: WorkspaceWorkflowId,
        requestId: number,
        message?: string
      ) => {
        const currentState = workflowStateRef.current;
        if (currentState[workflowId].requestId !== requestId) {
          return;
        }

        const nextState = {
          ...currentState,
          [workflowId]: {
            ...currentState[workflowId],
            status: 'succeeded' as const,
            error: undefined,
            message,
          },
        };
        commitWorkflowState(nextState);
        pushLuminaDebugTrace('workflow:succeed', { message, requestId, workflowId });
      },
    } satisfies WorkspaceControllerStateAdapter,
    workflowState,
  };
};
