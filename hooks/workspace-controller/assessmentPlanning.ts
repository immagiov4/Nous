import { pushLuminaDebugTrace } from '../../services/debugTrace.ts';
import { getErrorMessage } from '../../services/errorMessage.ts';
import { getProjectSourceFile } from '../../services/projectSource.ts';
import { createProjectId, createProjectSnapshot } from '../../services/projectSnapshot.ts';
import { buildLearningPlanFromSyllabus } from '../../services/workspace-controller/learnMode.ts';
import { AppState, type FileData, type Message, type SyllabusItem, type UserProfile } from '../../types.ts';
import type {
  AssessmentSourceInput,
  OpenSectionOptions,
  OpenSectionOutcome,
  WorkspaceControllerContext,
} from './types.ts';

interface AssessmentPlanningDependencies {
  openSection: (
    section: import('../../types.ts').LearningSection,
    options?: OpenSectionOptions
  ) => Promise<OpenSectionOutcome>;
}

const DEFAULT_ASSESSMENT_GREETING =
  "Ciao! Sono il tuo Architect. Cosa vuoi imparare esattamente oggi, e qual è il tuo obiettivo finale?";

const getSeededAssessmentQuestion = (
  session: { getHistory?: () => Array<{ role: string; content?: unknown }> }
): string | null => {
  const history = session.getHistory?.() || [];

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
      return message.content;
    }
  }

  return null;
};

export const createAssessmentPlanningCommands = (
  context: WorkspaceControllerContext,
  { openSection }: AssessmentPlanningDependencies
) => {
  const { domain, gemini, projectLibrary, sleep, state } = context;

  async function startAssessment({ file, textSource }: AssessmentSourceInput): Promise<void> {
    const requestId = state.beginWorkflow('assessment', 'Avvio Valutazione...');
    state.setScreenState(AppState.ASSESSMENT);
    pushLuminaDebugTrace('assessment:start', {
      fileName: file?.name || null,
      hasFile: Boolean(file),
      hasTextSource: Boolean(textSource),
      requestId,
      textLength: textSource?.text.length || null,
    });

    try {
      const session = textSource
        ? await gemini.createAssessmentChatFromTextSource(textSource, status => {
            state.setWorkflowMessage('assessment', requestId, status);
          })
        : file
          ? await gemini.createAssessmentChat(file, status => {
              state.setWorkflowMessage('assessment', requestId, status);
            })
          : (() => {
              throw new Error('Missing source input for assessment');
            })();
      if (!state.isWorkflowCurrent('assessment', requestId)) {
        pushLuminaDebugTrace('assessment:stale-after-session', { requestId });
        return;
      }

      state.setChatSession(session);
      state.setWorkflowMessage('assessment', requestId, 'Avvio domande valutazione...');
      const seededQuestion = getSeededAssessmentQuestion(session);
      if (seededQuestion) {
        pushLuminaDebugTrace('assessment:seeded-question', {
          preview: seededQuestion.slice(0, 120),
          requestId,
        });
        state.setAssessmentMessages([
          { role: 'model', text: seededQuestion } satisfies Message,
        ]);
        state.succeedWorkflow('assessment', requestId);
        return;
      }

      pushLuminaDebugTrace('assessment:fallback-first-message', { requestId });
      const result = await session.sendMessage({
        message: 'Inizia la valutazione con una prima domanda breve e concreta.',
      });
      if (!state.isWorkflowCurrent('assessment', requestId)) {
        pushLuminaDebugTrace('assessment:stale-after-first-message', { requestId });
        return;
      }

      state.setAssessmentMessages([
        { role: 'model', text: result.text || '' } satisfies Message,
      ]);
      pushLuminaDebugTrace('assessment:first-message-generated', {
        preview: (result.text || '').slice(0, 120),
        requestId,
      });
      state.succeedWorkflow('assessment', requestId);
    } catch (error) {
      state.setScreenState(AppState.LIBRARY);
      pushLuminaDebugTrace('assessment:failed', {
        errorMessage: getErrorMessage(error),
        requestId,
      });
      state.failWorkflow('assessment', requestId, getErrorMessage(error));
      throw error;
    }
  }

  async function startLearnAssessment(): Promise<void> {
    const requestId = state.beginWorkflow('assessment', 'Avvio Profilazione...');
    state.setScreenState(AppState.ASSESSMENT);

    try {
      const session = gemini.createLearnAssessmentChat('Italiano');
      state.setChatSession(session);
      state.setAssessmentMessages([
        { role: 'model', text: DEFAULT_ASSESSMENT_GREETING } satisfies Message,
      ]);
      state.succeedWorkflow('assessment', requestId);
    } catch (error) {
      state.setScreenState(AppState.LIBRARY);
      state.failWorkflow('assessment', requestId, getErrorMessage(error));
      throw error;
    }
  }

  async function runPlanGeneration(args: {
    history?: Message[];
    mode: 'document' | 'learn';
    profile?: UserProfile;
  }): Promise<void> {
    const requestId = state.beginWorkflow('generatePlan', 'Creazione Piano Studi...');
    state.setScreenState(AppState.PLANNING);

    try {
      if (args.mode === 'learn') {
        if (!args.profile) {
          throw new Error('Missing learn-mode profile');
        }

        const newSyllabus = await gemini.generateFullCurriculum(
          args.profile,
          message => {
            state.setWorkflowMessage('generatePlan', requestId, message);
          },
          items => {
            domain.setSyllabus(items as SyllabusItem[]);
          },
          () => {
            state.setWorkflowMessage('generatePlan', requestId, 'Revisione finale...');
          }
        );

        if (!state.isWorkflowCurrent('generatePlan', requestId)) {
          return;
        }

        const plan = buildLearningPlanFromSyllabus(args.profile, newSyllabus);
        domain.setLearningPlan(plan);
        domain.setDocumentAssets(null);
        domain.setDocumentIndex(null);
        domain.setSyllabus(newSyllabus);
        domain.setUserProfile(args.profile);
        domain.setIsLearnMode(true);
        state.setScreenState(AppState.READING);

        const firstSection = plan.sections[0] || null;
        if (firstSection) {
          const projectId = projectLibrary.currentProjectId || createProjectId();
          if (!projectLibrary.currentProjectId) {
            projectLibrary.setCurrentProjectId(projectId);
            projectLibrary.setProjectHydrated(true);
          }
          domain.setActiveSectionId(firstSection.id);
          await projectLibrary.persistSnapshot(
            createProjectSnapshot({
              id: projectId,
              state: AppState.READING,
              source: domain.source,
              learningPlan: plan,
              documentAssets: null,
              documentIndex: null,
              isLearnMode: true,
              userProfile: args.profile,
              syllabus: newSyllabus,
              activeSectionId: firstSection.id,
            })
          );
          await openSection(firstSection, {
            allowWhileBlocking: true,
            currentDocumentAssets: null,
            currentDocumentIndex: null,
            currentPlan: plan,
            currentSourceFile: domain.file,
            currentSyllabus: newSyllabus,
            currentUserProfile: args.profile,
            isLearnMode: true,
          });
        }
      } else {
        const sourceFile = domain.file ?? getProjectSourceFile(domain.source);
        if (!sourceFile) {
          throw new Error('Missing source file for plan generation');
        }

        const plan = await gemini.generateLearningPlan(sourceFile, args.history || [], status => {
          state.setWorkflowMessage('generatePlan', requestId, status);
        });

        if (!state.isWorkflowCurrent('generatePlan', requestId)) {
          return;
        }

        const prepared = await context.preparePdfLessonPlan(
          sourceFile,
          plan,
          domain.documentIndex
        );
        if (!state.isWorkflowCurrent('generatePlan', requestId)) {
          return;
        }

        domain.setLearningPlan(prepared.learningPlan);
        domain.setDocumentAssets(null);
        domain.setDocumentIndex(prepared.documentIndex);
        state.setScreenState(AppState.READING);

        const firstSection = prepared.learningPlan.sections[0] || null;
        if (firstSection) {
          const projectId = projectLibrary.currentProjectId || createProjectId();
          if (!projectLibrary.currentProjectId) {
            projectLibrary.setCurrentProjectId(projectId);
            projectLibrary.setProjectHydrated(true);
          }
          domain.setActiveSectionId(firstSection.id);
          await projectLibrary.persistSnapshot(
            createProjectSnapshot({
              id: projectId,
              state: AppState.READING,
              source: domain.source,
              learningPlan: prepared.learningPlan,
              documentAssets: null,
              documentIndex: prepared.documentIndex,
              isLearnMode: domain.isLearnMode,
              userProfile: domain.userProfile,
              syllabus: domain.syllabus,
              activeSectionId: firstSection.id,
            })
          );
          await openSection(firstSection, {
            allowWhileBlocking: true,
            currentDocumentAssets: null,
            currentDocumentIndex: prepared.documentIndex,
            currentPlan: prepared.learningPlan,
            currentSourceFile: sourceFile,
            currentSyllabus: domain.syllabus,
            currentUserProfile: domain.userProfile,
            isLearnMode: domain.isLearnMode,
          });
        }
      }

      state.succeedWorkflow('generatePlan', requestId);
    } catch (error) {
      state.setScreenState(AppState.LIBRARY);
      state.failWorkflow('generatePlan', requestId, getErrorMessage(error));
      throw error;
    }
  }

  async function startLearnJourney(): Promise<{ errorMessage?: string; outcome: 'failed' | 'started' }> {
    try {
      const nextProjectId = createProjectId();
      projectLibrary.setProjectHydrated(false);
      domain.resetDomain();
      state.resetRuntimeState();
      projectLibrary.setCurrentProjectId(nextProjectId);
      domain.setIsLearnMode(true);
      projectLibrary.setProjectHydrated(true);
      await projectLibrary.persistSnapshot(
        createProjectSnapshot({
          id: nextProjectId,
          state: AppState.ASSESSMENT,
          source: null,
          isLearnMode: true,
        })
      );
      await startLearnAssessment();
      return { outcome: 'started' };
    } catch (error) {
      return { outcome: 'failed', errorMessage: getErrorMessage(error) };
    }
  }

  async function submitAssessment(
    input: string
  ): Promise<{ errorMessage?: string; outcome: 'continued' | 'failed' | 'noop' | 'planned' }> {
    const trimmedInput = input.trim();
    const chatSession = state.getChatSession();
    if (!trimmedInput || !chatSession) {
      return { outcome: 'noop' };
    }

    const requestId = state.beginWorkflow('assessment', 'Valutazione risposta...');
    const userMessage: Message = { role: 'user', text: trimmedInput };
    const previousMessages = state.getAssessmentMessages();
    state.setAssessmentMessages([...previousMessages, userMessage]);

    try {
      if (domain.isLearnMode) {
        const response = await chatSession.sendMessage({ message: trimmedInput });
        const call = response.functionCalls?.[0];

        if (call && call.name === 'finalizeProfile') {
          const profileArgs = (call.args ?? {}) as Partial<UserProfile>;
          const profile = {
            ...profileArgs,
            language: 'Italiano',
          } as UserProfile;
          domain.setUserProfile(profile);
          await projectLibrary.saveCurrentProject({
            userProfile: profile,
            isLearnMode: true,
            state: AppState.ASSESSMENT,
          });
          state.setAssessmentMessages(currentMessages => [
            ...currentMessages,
            {
              role: 'model',
              text: 'Perfetto, ho capito le tue esigenze. Sto creando il tuo piano di studi personalizzato...',
            } satisfies Message,
          ]);
          state.succeedWorkflow('assessment', requestId);
          await sleep(1500);
          await runPlanGeneration({ mode: 'learn', profile });
          return { outcome: 'planned' };
        }

        state.setAssessmentMessages(currentMessages => [
          ...currentMessages,
          { role: 'model', text: response.text || '' } satisfies Message,
        ]);
        state.succeedWorkflow('assessment', requestId);
        return { outcome: 'continued' };
      }

      const response = await chatSession.sendMessage({ message: trimmedInput });
      const modelText = response.text || '';
      const nextHistory: Message[] = [
        ...previousMessages,
        userMessage,
        { role: 'model', text: modelText },
      ];
      state.setAssessmentMessages(nextHistory);

      const userTurns = nextHistory.filter(message => message.role === 'user').length;
      const shouldGeneratePlan = modelText.includes('[ASSESSMENT_COMPLETE]') || userTurns >= 3;

      state.succeedWorkflow('assessment', requestId);

      if (shouldGeneratePlan) {
        await sleep(1500);
        await runPlanGeneration({ history: nextHistory, mode: 'document' });
        return { outcome: 'planned' };
      }

      return { outcome: 'continued' };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('assessment', requestId, errorMessage);
      return { outcome: 'failed', errorMessage };
    }
  }

  return {
    startAssessment,
    startLearnAssessment,
    startLearnJourney,
    submitAssessment,
  };
};
