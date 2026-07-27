import { useEffect, useRef, useState } from 'react';
import { pushNousDebugTrace } from '../../../services/core/debugTrace.ts';
import {
  createWorkspaceWorkflowState,
  invalidateWorkspaceWorkflows,
  type WorkspaceWorkflowId,
  type WorkspaceWorkflowState,
} from '../../../services/workspace/workflow.ts';
import { AppState, type Message } from '../../../types.ts';
import type {
  WorkspaceChatSession,
  WorkspaceControllerStateAdapter,
  WorkspaceGenerationKind,
} from './types.ts';

export const useWorkspaceControllerState = () => {
  const [screenState, setScreenState] = useState<AppState>(AppState.LIBRARY);
  const [assessmentMessages, setAssessmentMessages] = useState<Message[]>([]);
  const [chatSession, setChatSession] = useState<WorkspaceChatSession | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const openingProjectIdRef = useRef<string | null>(null);
  const [workflowState, setWorkflowState] = useState<WorkspaceWorkflowState>(
    createWorkspaceWorkflowState
  );
  const [missingSourceProjectId, setMissingSourceProjectId] = useState<string | null>(null);
  const [, setGenerationRevision] = useState(0);

  const assessmentMessagesRef = useRef(assessmentMessages);
  const chatSessionRef = useRef(chatSession);
  const generationByProjectRef = useRef(
    new Map<
      string | null,
      { kind: WorkspaceGenerationKind; sectionId: string | null; token: number }
    >()
  );
  const nextGenerationTokenRef = useRef(0);
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

  const commitGenerationChange = () => {
    setGenerationRevision(currentRevision => currentRevision + 1);
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
            reasoning: undefined,
            progress: undefined,
            error: undefined,
            requestId: nextRequestId,
          },
        };
        commitWorkflowState(nextState);
        pushNousDebugTrace('workflow:begin', { message, requestId: nextRequestId, workflowId });
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
            reasoning: undefined,
            progress: undefined,
          },
        };
        commitWorkflowState(nextState);
        pushNousDebugTrace('workflow:fail', { errorMessage, requestId, workflowId });
      },
      finishGeneration: (projectId, token) => {
        const activeGeneration = generationByProjectRef.current.get(projectId);
        if (activeGeneration?.token !== token) {
          return;
        }

        generationByProjectRef.current.delete(projectId);
        commitGenerationChange();
      },
      getAssessmentMessages: () => assessmentMessagesRef.current,
      getChatSession: () => chatSessionRef.current,
      getGeneratingSectionId: projectId =>
        generationByProjectRef.current.get(projectId)?.sectionId ?? null,
      getOpeningProjectId: () => openingProjectIdRef.current,
      getWorkflowState: () => workflowStateRef.current,
      invalidateWorkflows: workflowIds => {
        const nextState = invalidateWorkspaceWorkflows(workflowStateRef.current, workflowIds);
        commitWorkflowState(nextState);
      },
      isGenerationActive: projectId => generationByProjectRef.current.has(projectId),
      isLessonGenerationActive: projectId =>
        generationByProjectRef.current.get(projectId)?.kind === 'lesson',
      isWorkflowCurrent: (workflowId: WorkspaceWorkflowId, requestId: number) =>
        workflowStateRef.current[workflowId].requestId === requestId,
      resetSessionState: () => {
        setAssessmentMessages([]);
        assessmentMessagesRef.current = [];
        setChatSession(null);
        chatSessionRef.current = null;
        openingProjectIdRef.current = null;
        setOpeningProjectId(null);
        setMissingSourceProjectId(null);
      },
      setAssessmentMessages: nextMessages => {
        setAssessmentMessages(currentMessages => {
          const resolvedMessages =
            typeof nextMessages === 'function' ? nextMessages(currentMessages) : nextMessages;
          assessmentMessagesRef.current = resolvedMessages;
          return resolvedMessages;
        });
      },
      setGeneratingSectionId: (projectId, token, sectionId) => {
        const activeGeneration = generationByProjectRef.current.get(projectId);
        if (activeGeneration?.token !== token || activeGeneration.sectionId === sectionId) {
          return;
        }

        generationByProjectRef.current.set(projectId, {
          ...activeGeneration,
          sectionId,
        });
        commitGenerationChange();
      },
      setChatSession: nextChatSession => {
        chatSessionRef.current = nextChatSession;
        setChatSession(nextChatSession);
      },
      setOpeningProjectId: (projectId: string | null) => {
        openingProjectIdRef.current = projectId;
        setOpeningProjectId(projectId);
      },
      setMissingSourceProjectId,
      setScreenState,
      setWorkflowMessage: (workflowId: WorkspaceWorkflowId, requestId: number, message: string) => {
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
        pushNousDebugTrace('workflow:message', { message, requestId, workflowId });
      },
      setWorkflowReasoning: (
        workflowId: WorkspaceWorkflowId,
        requestId: number,
        reasoning: string
      ) => {
        const currentState = workflowStateRef.current;
        if (currentState[workflowId].requestId !== requestId) {
          return;
        }

        const nextState = {
          ...currentState,
          [workflowId]: {
            ...currentState[workflowId],
            reasoning,
          },
        };
        commitWorkflowState(nextState);
      },
      setWorkflowProgress: (workflowId, requestId, progress) => {
        const currentState = workflowStateRef.current;
        if (
          currentState[workflowId].requestId !== requestId ||
          currentState[workflowId].status !== 'pending'
        ) {
          return;
        }

        const nextState = {
          ...currentState,
          [workflowId]: {
            ...currentState[workflowId],
            progress,
          },
        };
        commitWorkflowState(nextState);
      },
      succeedWorkflow: (workflowId: WorkspaceWorkflowId, requestId: number, message?: string) => {
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
            reasoning: undefined,
            progress: undefined,
          },
        };
        commitWorkflowState(nextState);
        pushNousDebugTrace('workflow:succeed', { message, requestId, workflowId });
      },
      tryBeginGeneration: (projectId, kind) => {
        if (generationByProjectRef.current.has(projectId)) {
          return null;
        }

        const token = nextGenerationTokenRef.current + 1;
        nextGenerationTokenRef.current = token;
        generationByProjectRef.current.set(projectId, { kind, sectionId: null, token });
        commitGenerationChange();
        return token;
      },
    } satisfies WorkspaceControllerStateAdapter,
    missingSourceProjectId,
    workflowState,
  };
};
