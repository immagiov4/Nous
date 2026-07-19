import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { pushNousDebugTrace } from '../../../services/core/debugTrace.ts';
import { getErrorMessage } from '../../../services/core/errorMessage.ts';
import { markApplicationExercisePlanningFailed } from '../../../services/exercises/plan.ts';
import type { GenerationStatusReporter } from '../../../services/openrouter/generationProgress.ts';
import { getCourseSourceDescriptors } from '../../../services/projects/courseSources.ts';
import {
  createProjectId,
  createProjectSnapshot,
} from '../../../services/projects/projectSnapshot.ts';
import {
  createProjectSourceFromFile,
  getProjectSourceName,
  isZipFileData,
} from '../../../services/projects/projectSource.ts';
import {
  ASSESSMENT_SOURCE_ARCHIVE_PREVIEW_BUDGET_CHARS,
  formatSourceArchiveIndex,
} from '../../../services/projects/sourceArchive.ts';
import {
  AppState,
  type FileData,
  type HomeChatToolPreferences,
  type LearningPlan,
  type LessonNode,
  type Message,
  type ProjectSource,
  type ResearchCoursePlan,
  type SyllabusItem,
  type UserProfile,
} from '../../../types.ts';
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';
import {
  loadProjectSourceFile,
  prepareUploadedCourseSource,
  readSourceFileData,
} from './controllerContext.ts';
import { importProjectBackupFile, isNousBackupArchive } from './projectImport.ts';
import type {
  AssessmentSourceInput,
  OpenSectionOptions,
  OpenSectionOutcome,
  WorkspaceControllerContext,
} from './types.ts';

interface AssessmentPlanningDependencies {
  openSection: (section: LessonNode, options?: OpenSectionOptions) => Promise<OpenSectionOutcome>;
}

const DEFAULT_ASSESSMENT_GREETING =
  'Ciao! Sono il tuo Architect. Cosa vuoi imparare esattamente oggi, e qual è il tuo obiettivo finale?';
const MIN_DOCUMENT_USER_TURNS_BEFORE_PLANNING = 2;
const TARGET_DOCUMENT_USER_TURNS_BEFORE_AUTO_COMPLETE = 3;
const LOCAL_ASSESSMENT_COMPLETE_MESSAGE =
  'Ho tutte le info ad alto impatto che mi servono per costruire il percorso. Se vuoi posso generare il corso ora, oppure puoi aggiungere un ultimo dettaglio davvero importante.';

const buildHomeChatMessageForModel = (
  input: string,
  toolPreferences?: HomeChatToolPreferences
): string => {
  const trimmedInput = input.trim();
  if (!toolPreferences?.newCourse) {
    return trimmedInput;
  }

  return `[Preferenza utente attiva: Nuovo corso]
L'utente sta usando questa conversazione per impostare o costruire un nuovo corso.
Tratta quindi la richiesta come orientata alla definizione del percorso, dei materiali, dell'obiettivo finale e dei confini del corso, invece che come una semplice query generica.
Non parlare esplicitamente di questa preferenza se non serve, ma tienila a mente mentre rispondi.
  ${
    toolPreferences.addingAssessmentDetails
      ? "\nStato UI: l'utente ha premuto \"No, voglio aggiungere...\". Tratta il prossimo messaggio come integrazione dell'intervista: se chiarisce il dubbio, chiudi l'intervista con [ASSESSMENT_COMPLETE]; se manca ancora qualcosa, fai solo un'altra domanda. Non iniziare mai a scrivere il corso in chat."
      : ''
  }

Messaggio utente:
${trimmedInput}`;
};

const normalizeAssessmentText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const matchesAnyAssessmentPattern = (value: string, patterns: RegExp[]): boolean =>
  patterns.some(pattern => pattern.test(value));

const hasEnoughHighImpactAssessmentSignals = (messages: Message[]): boolean => {
  const userMessages = messages.filter(message => message.role === 'user');
  if (userMessages.length < TARGET_DOCUMENT_USER_TURNS_BEFORE_AUTO_COMPLETE) {
    return false;
  }

  const normalizedText = normalizeAssessmentText(
    userMessages.map(message => message.text).join('\n')
  );

  const hasGoalSignal = matchesAnyAssessmentPattern(normalizedText, [
    /\besame\b/,
    /\buniversit(?:a|ario)?\b/,
    /\blaurea\b/,
    /\bcorso\b/,
    /\blibro\b/,
    /\bconsigliat/,
    /\bapprofond/,
    /\bprogetto\b/,
    /\bprepar/,
    /\bobiettivo\b/,
    /\bincludi tutto\b/,
  ]);

  const hasBackgroundSignal = matchesAnyAssessmentPattern(normalizedText, [
    /\bho fatto\b/,
    /\bho studiato\b/,
    /\bstudiato\b/,
    /\bsviluppator/,
    /\balgoritm/,
    /\bstruttur[ea] dati\b/,
    /\binduttiv/,
    /\balgebra booleana\b/,
    /\bautomi\b/,
    /\bgrammatic/,
    /\bformalism/,
    /\bcomplessit/,
    /\bnon ho letto niente\b/,
    /\bnon conosco\b/,
    /\bun minimo\b/,
  ]);

  const hasPreferenceSignal = matchesAnyAssessmentPattern(normalizedText, [
    /\bpreferisc/,
    /\bmeglio\b/,
    /\bimparo\b/,
    /\bconcett/,
    /\bteori/,
    /\bpratic/,
    /\besempi/,
    /\blinguaggio naturale\b/,
    /\bnotazioni simboliche\b/,
    /\bnon sono tanto bravo\b/,
    /\bmi rincoglioniscono\b/,
    /\bpartendo dal perche\b/,
  ]);

  const highImpactSignalCount = [hasGoalSignal, hasBackgroundSignal, hasPreferenceSignal].filter(
    Boolean
  ).length;

  return highImpactSignalCount >= 3;
};

const getSeededAssessmentQuestion = (session: {
  getHistory?: () => Array<{ role: string; content?: unknown }>;
}): string | null => {
  const history = session.getHistory?.() || [];

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (
      message.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content.trim()
    ) {
      return message.content;
    }
  }

  return null;
};

export const createAssessmentPlanningCommands = (
  context: WorkspaceControllerContext,
  _: AssessmentPlanningDependencies
) => {
  const { domain, openRouter, projectLibrary, sleep, state } = context;

  const readAttemptCount = (error: unknown): number =>
    typeof (error as { attempts?: unknown }).attempts === 'number'
      ? (error as { attempts: number }).attempts
      : 1;

  const planApplicationExercises = async (args: {
    courseIntent?: string;
    plan: LearningPlan;
    profile: UserProfile | null;
    requestId: number;
    researchCoursePlan?: ResearchCoursePlan | null;
    onProgressStatus?: (status: string) => void;
    onProgressStream?: (stream: string) => void;
  }) => {
    try {
      const result = await openRouter.generateApplicationExercisePlacements({
        courseIntent: args.courseIntent || args.plan.summary || args.plan.title,
        learningPlan: args.plan,
        profile: args.profile,
        researchCoursePlan: args.researchCoursePlan,
        onStatusUpdate: message => {
          state.setWorkflowMessage('generatePlan', args.requestId, message);
          args.onProgressStatus?.(message);
        },
        onReasoningUpdate: reasoning => {
          args.onProgressStream?.(reasoning);
        },
      });
      return result.plan;
    } catch (error) {
      return markApplicationExercisePlanningFailed(
        args.plan,
        error instanceof Error ? error : new Error(getErrorMessage(error)),
        readAttemptCount(error)
      );
    }
  };

  const finalizeLearnProfile = async (profile: UserProfile) => {
    domain.setUserProfile(profile);

    if (projectLibrary.currentProjectId) {
      await projectLibrary.saveCurrentProject({
        userProfile: profile,
        isLearnMode: true,
        state: AppState.ASSESSMENT,
      });
    }

    state.setAssessmentMessages(currentMessages => [
      ...currentMessages,
      {
        role: 'model',
        text: 'Perfetto, ho capito le tue esigenze. Sto creando il tuo piano di studi personalizzato...',
      } satisfies Message,
    ]);
  };

  async function startAssessment({
    file,
    sources,
    textSource,
  }: AssessmentSourceInput): Promise<void> {
    const requestId = state.beginWorkflow('assessment', t('Avvio Valutazione...'));
    state.setScreenState(AppState.ASSESSMENT);
    pushNousDebugTrace('assessment:start', {
      fileName: file?.name || null,
      hasFile: Boolean(file),
      sourceCount: sources?.length || 0,
      hasTextSource: Boolean(textSource),
      requestId,
      textLength: textSource?.text.length || null,
    });

    try {
      const session = sources?.length
        ? await openRouter.createAssessmentChatFromSourceSet(sources, status => {
            state.setWorkflowMessage('assessment', requestId, status);
          })
        : textSource
          ? await openRouter.createAssessmentChatFromTextSource(textSource, status => {
              state.setWorkflowMessage('assessment', requestId, status);
            })
          : file
            ? await openRouter.createAssessmentChat(file, status => {
                state.setWorkflowMessage('assessment', requestId, status);
              })
            : (() => {
                throw new Error('Missing source input for assessment');
              })();
      if (!state.isWorkflowCurrent('assessment', requestId)) {
        pushNousDebugTrace('assessment:stale-after-session', { requestId });
        return;
      }

      state.setChatSession(session);
      state.setWorkflowMessage('assessment', requestId, t('Avvio domande valutazione...'));
      const seededQuestion = getSeededAssessmentQuestion(session);
      if (seededQuestion) {
        pushNousDebugTrace('assessment:seeded-question', {
          preview: seededQuestion.slice(0, 120),
          requestId,
        });
        state.setAssessmentMessages([{ role: 'model', text: seededQuestion } satisfies Message]);
        state.succeedWorkflow('assessment', requestId);
        return;
      }

      pushNousDebugTrace('assessment:fallback-first-message', { requestId });
      const result = await session.sendMessage({
        message: 'Inizia la valutazione con una prima domanda breve e concreta.',
      });
      if (!state.isWorkflowCurrent('assessment', requestId)) {
        pushNousDebugTrace('assessment:stale-after-first-message', { requestId });
        return;
      }

      state.setAssessmentMessages([{ role: 'model', text: result.text || '' } satisfies Message]);
      pushNousDebugTrace('assessment:first-message-generated', {
        preview: (result.text || '').slice(0, 120),
        requestId,
      });
      state.succeedWorkflow('assessment', requestId);
    } catch (error) {
      state.setScreenState(AppState.LIBRARY);
      pushNousDebugTrace('assessment:failed', {
        errorMessage: getErrorMessage(error),
        requestId,
      });
      state.failWorkflow('assessment', requestId, getErrorMessage(error));
      throw error;
    }
  }

  async function startLearnAssessment(): Promise<void> {
    const requestId = state.beginWorkflow('assessment', t('Avvio Profilazione...'));
    state.setScreenState(AppState.ASSESSMENT);

    try {
      const session = openRouter.createLearnAssessmentChat('Italiano');
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
    const requestId = state.beginWorkflow('generatePlan', t('Creazione Piano Studi...'));
    state.setScreenState(AppState.PLANNING);
    const profile = args.profile || domain.userProfile;
    const progressObserver = openRouter.createGenerationProgressObserver({
      language: profile?.language || 'Italiano',
      onUpdate: progress => state.setWorkflowProgress('generatePlan', requestId, progress),
      operation: 'plan',
      subject: profile?.topic || getProjectSourceName(domain.source) || 'Nuovo percorso',
    });

    const reportStatus: GenerationStatusReporter = (status, stage) => {
      state.setWorkflowMessage('generatePlan', requestId, status);
      if (stage) {
        progressObserver.setStage(stage);
      }
      progressObserver.updateStatus(status);
    };

    try {
      if (args.mode === 'learn') {
        if (!args.profile) {
          throw new Error('Missing learn-mode profile');
        }

        const researchResult = await openRouter.generateResearchCoursePlan(
          args.profile,
          reportStatus,
          items => {
            domain.setSyllabus(items as SyllabusItem[]);
          },
          progressObserver.push
        );
        const newSyllabus = researchResult.syllabus;

        if (!state.isWorkflowCurrent('generatePlan', requestId)) {
          return;
        }

        const basePlan = openRouter.buildLearningPlanFromResearchCourse(
          args.profile,
          researchResult.researchCoursePlan,
          newSyllabus
        );
        const plan = await planApplicationExercises({
          plan: basePlan,
          profile: args.profile,
          requestId,
          researchCoursePlan: researchResult.researchCoursePlan,
          onProgressStatus: progressObserver.updateStatus,
          onProgressStream: progressObserver.push,
        });
        if (!state.isWorkflowCurrent('generatePlan', requestId)) {
          return;
        }
        domain.setLearningPlan(plan);
        domain.setDocumentAssets(null);
        domain.setDocumentIndex(null);
        domain.setSyllabus(newSyllabus);
        domain.setResearchCoursePlan(researchResult.researchCoursePlan);
        domain.setResearchDossiers({});
        domain.setUserProfile(args.profile);
        domain.setIsLearnMode(true);
        state.setScreenState(AppState.READING);

        const firstSection = flattenLessons(plan.modules)[0] || null;
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
              researchCoursePlan: researchResult.researchCoursePlan,
              researchDossiersBySectionId: {},
              activeSectionId: firstSection.id,
            })
          );
        }
      } else {
        const archiveSource = domain.source?.kind === 'archive' ? domain.source : null;
        const sourceFile = await loadProjectSourceFile(context);
        if (!sourceFile && !archiveSource) {
          throw new Error('Missing source file for plan generation');
        }

        if (domain.source?.kind === 'pdf') {
          state.setWorkflowMessage('generatePlan', requestId, t('Verifica testo PDF...'));
          await openRouter.validatePdfTextSource(sourceFile as FileData);
        }

        let sourceProjectId = projectLibrary.currentProjectId;
        if (archiveSource && !sourceProjectId) {
          sourceProjectId = createProjectId();
          projectLibrary.setCurrentProjectId(sourceProjectId);
          projectLibrary.setProjectHydrated(true);
          await projectLibrary.persistSnapshot(
            createProjectSnapshot({
              id: sourceProjectId,
              state: AppState.PLANNING,
              source: archiveSource,
            })
          );
        }

        const sources = getCourseSourceDescriptors(domain.source);
        const plan =
          sources.length > 1
            ? await openRouter.generateLearningPlanFromSourceSet(sources, args.history || [], {
                language: profile?.language,
                onReasoningUpdate: progressObserver.push,
                onStatusUpdate: reportStatus,
              })
            : archiveSource && sourceProjectId
              ? await openRouter.generateLearningPlanFromSourceArchive(
                  { projectId: sourceProjectId, source: archiveSource },
                  args.history || [],
                  {
                    language: profile?.language,
                    onReasoningUpdate: progressObserver.push,
                    onStatusUpdate: reportStatus,
                  }
                )
              : await openRouter.generateLearningPlan(sourceFile as FileData, args.history || [], {
                  language: profile?.language,
                  onReasoningUpdate: progressObserver.push,
                  onStatusUpdate: reportStatus,
                });

        if (!state.isWorkflowCurrent('generatePlan', requestId)) {
          return;
        }

        const prepared = archiveSource
          ? { learningPlan: plan, documentIndex: null }
          : await context.preparePdfLessonPlan(sourceFile as FileData, plan, domain.documentIndex);
        if (!state.isWorkflowCurrent('generatePlan', requestId)) {
          return;
        }

        const plannedWithExercises = await planApplicationExercises({
          courseIntent: args.history?.map(message => message.text).join('\n'),
          plan: prepared.learningPlan,
          profile: domain.userProfile,
          requestId,
          onProgressStatus: progressObserver.updateStatus,
          onProgressStream: progressObserver.push,
        });
        if (!state.isWorkflowCurrent('generatePlan', requestId)) {
          return;
        }

        domain.setLearningPlan(plannedWithExercises);
        domain.setDocumentAssets(null);
        domain.setDocumentIndex(prepared.documentIndex);
        state.setScreenState(AppState.READING);

        const firstSection = flattenLessons(plannedWithExercises.modules)[0] || null;
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
              learningPlan: plannedWithExercises,
              documentAssets: null,
              documentIndex: prepared.documentIndex,
              isLearnMode: domain.isLearnMode,
              userProfile: domain.userProfile,
              syllabus: domain.syllabus,
              activeSectionId: firstSection.id,
            })
          );
        }
      }

      await progressObserver.finish();
      progressObserver.complete();
      state.succeedWorkflow('generatePlan', requestId);
    } catch (error) {
      state.setScreenState(AppState.LIBRARY);
      state.failWorkflow('generatePlan', requestId, getErrorMessage(error));
      throw error;
    }
  }

  async function startLearnJourney(): Promise<{
    errorMessage?: string;
    outcome: 'failed' | 'started';
  }> {
    try {
      const nextProjectId = createProjectId();
      projectLibrary.setProjectHydrated(false);
      domain.resetDomain();
      state.resetSessionState();
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

  function cancelAssessment(): void {
    domain.resetDomain();
    state.resetSessionState();
    projectLibrary.setCurrentProjectId(null);
    projectLibrary.setProjectHydrated(true);
    state.setScreenState(AppState.LIBRARY);
  }

  async function startHomeChat(args: {
    input: string;
    selectedFile?: File | null;
    selectedFiles?: File[];
    toolPreferences?: HomeChatToolPreferences;
  }): Promise<{
    errorMessage?: string;
    outcome:
      | 'abandoned'
      | 'assessment-complete'
      | 'continued'
      | 'failed'
      | 'imported'
      | 'noop'
      | 'planned';
    sourceWarnings?: Array<{ message: string; name: string }>;
  }> {
    const trimmedInput = args.input.trim();
    if (!trimmedInput) {
      return { outcome: 'noop' };
    }

    const selectedFiles = args.selectedFiles?.length
      ? args.selectedFiles
      : args.selectedFile
        ? [args.selectedFile]
        : [];
    const requestId = state.beginWorkflow(
      'assessment',
      t(selectedFiles.length > 0 ? 'Preparazione sorgente...' : 'Avvio conversazione...')
    );

    try {
      domain.resetDomain();
      state.resetSessionState();
      projectLibrary.setCurrentProjectId(null);
      projectLibrary.setProjectHydrated(false);

      let session:
        | Awaited<ReturnType<typeof openRouter.createAssessmentChat>>
        | ReturnType<typeof openRouter.createEmbeddedLearnAssessmentChat>;
      let learnMode = false;
      let sourceWarnings: Array<{ message: string; name: string }> = [];

      if (selectedFiles.length > 0) {
        let nextSource: ProjectSource | null = null;
        let nextFile: FileData | null = null;
        let archiveFile: File | undefined;

        const zipFiles = selectedFiles.filter(file =>
          isZipFileData({ name: file.name, mimeType: file.type })
        );
        if (zipFiles.length > 0 && selectedFiles.length !== 1) {
          throw new Error('Gli archivi ZIP devono essere caricati da soli.');
        }

        if (zipFiles.length === 1) {
          const selectedFile = zipFiles[0];
          const isBackupArchive = await isNousBackupArchive(selectedFile);

          if (isBackupArchive) {
            state.setWorkflowMessage('assessment', requestId, t('Importazione backup...'));
            await importProjectBackupFile(context, selectedFile);
            state.succeedWorkflow('assessment', requestId);
            return { outcome: 'imported' };
          }

          const archiveSource = await import('../../../utils/project/codebaseBundle.ts').then(
            module => module.createSourceArchiveFromZip(selectedFile)
          );
          nextSource = archiveSource;
          nextFile = archiveSource.file;
          archiveFile = selectedFile;
        } else {
          if (selectedFiles.length === 1) {
            nextFile = await readSourceFileData(selectedFiles[0]);
            nextSource = createProjectSourceFromFile(nextFile);
          } else {
            const prepared = await prepareUploadedCourseSource(
              context,
              selectedFiles,
              (completed, total) => {
                state.setWorkflowMessage(
                  'assessment',
                  requestId,
                  t('Preparazione fonti... {completed}/{total}', { completed, total })
                );
              }
            );
            nextSource = prepared.source;
            nextFile = prepared.descriptors.find(source => source.status !== 'error')?.file || null;
          }
        }

        if (!nextSource || !nextFile) {
          throw new Error('Unable to prepare project source');
        }

        sourceWarnings = (nextSource.sources || [])
          .filter(source => source.status === 'error')
          .map(source => ({
            message: source.errorMessage || 'Questa fonte non è utilizzabile.',
            name: source.name,
          }));

        if (nextSource.kind === 'pdf' && !nextSource.sources?.length) {
          state.setWorkflowMessage('assessment', requestId, t('Verifica testo PDF...'));
          await openRouter.validatePdfTextSource(nextFile);
        }

        if (nextSource.kind === 'archive') {
          const projectId = createProjectId();
          projectLibrary.setCurrentProjectId(projectId);
          const saved = await projectLibrary.persistSnapshot(
            createProjectSnapshot({
              id: projectId,
              state: AppState.ASSESSMENT,
              source: nextSource,
            }),
            { archiveFile, throwOnError: true }
          );
          if (saved?.snapshot.source?.kind !== 'archive') {
            throw new Error('La sorgente archivio non è stata salvata.');
          }
          nextSource = saved.snapshot.source;
        }

        domain.setSource(nextSource);
        if (nextSource.kind === 'archive') {
          projectLibrary.setProjectHydrated(true);
        }
        domain.setIsLearnMode(false);
        learnMode = false;

        session =
          nextSource.sources && nextSource.sources.length > 1
            ? await openRouter.createEmbeddedAssessmentChatFromSourceSet(nextSource.sources)
            : nextSource.kind === 'archive'
              ? await openRouter.createEmbeddedAssessmentChatFromTextSource({
                  name: nextSource.name,
                  text: formatSourceArchiveIndex(nextSource.index, {
                    previewBudgetChars: ASSESSMENT_SOURCE_ARCHIVE_PREVIEW_BUDGET_CHARS,
                  }),
                })
              : await openRouter.createEmbeddedAssessmentChat(nextFile, status => {
                  state.setWorkflowMessage('assessment', requestId, status);
                });
      } else {
        domain.setSource(null);
        domain.setIsLearnMode(true);
        learnMode = true;
        session = openRouter.createEmbeddedLearnAssessmentChat('Italiano');
      }

      state.setChatSession(session);
      state.setAssessmentMessages([{ role: 'user', text: trimmedInput } satisfies Message]);

      const response = await session.sendMessage({
        message: buildHomeChatMessageForModel(trimmedInput, args.toolPreferences),
      });

      if (learnMode) {
        const call = response.functionCalls?.[0];

        if (call?.name === 'abandonAssessment') {
          cancelAssessment();
          state.succeedWorkflow('assessment', requestId);
          return { outcome: 'abandoned', sourceWarnings };
        }

        if (call && call.name === 'finalizeProfile') {
          const profileArgs = (call.args ?? {}) as Partial<UserProfile>;
          const profile = {
            ...profileArgs,
            language: 'Italiano',
          } as UserProfile;

          await finalizeLearnProfile(profile);
          state.succeedWorkflow('assessment', requestId);
          await sleep(1500);
          await runPlanGeneration({ mode: 'learn', profile });
          return { outcome: 'planned', sourceWarnings };
        }

        state.setAssessmentMessages(currentMessages => [
          ...currentMessages,
          { role: 'model', text: response.text || '' } satisfies Message,
        ]);
        state.succeedWorkflow('assessment', requestId);
        return { outcome: 'continued', sourceWarnings };
      }

      const modelText = response.text || '';
      const nextHistory: Message[] = [
        { role: 'user', text: trimmedInput },
        { role: 'model', text: modelText },
      ];

      state.setAssessmentMessages(nextHistory);

      const userTurns = nextHistory.filter(message => message.role === 'user').length;
      const isAssessmentComplete =
        modelText.includes('[ASSESSMENT_COMPLETE]') &&
        userTurns >= MIN_DOCUMENT_USER_TURNS_BEFORE_PLANNING;

      state.succeedWorkflow('assessment', requestId);

      if (isAssessmentComplete) {
        return { outcome: 'assessment-complete' as const, sourceWarnings };
      }

      return { outcome: 'continued', sourceWarnings };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('assessment', requestId, errorMessage);
      return { outcome: 'failed', errorMessage };
    }
  }

  async function submitAssessment(
    input: string,
    toolPreferences?: HomeChatToolPreferences
  ): Promise<{
    errorMessage?: string;
    outcome: 'abandoned' | 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned';
    sourceWarnings?: Array<{ message: string; name: string }>;
  }> {
    const trimmedInput = input.trim();
    const chatSession = state.getChatSession();
    if (!trimmedInput || !chatSession) {
      return { outcome: 'noop' };
    }

    const requestId = state.beginWorkflow('assessment', t('Valutazione risposta...'));
    const userMessage: Message = { role: 'user', text: trimmedInput };
    const previousMessages = state.getAssessmentMessages();
    state.setAssessmentMessages([...previousMessages, userMessage]);

    try {
      if (domain.isLearnMode) {
        const response = await chatSession.sendMessage({
          message: buildHomeChatMessageForModel(trimmedInput, toolPreferences),
        });
        const call = response.functionCalls?.[0];

        if (call?.name === 'abandonAssessment') {
          cancelAssessment();
          state.succeedWorkflow('assessment', requestId);
          return { outcome: 'abandoned' };
        }

        if (call && call.name === 'finalizeProfile') {
          const profileArgs = (call.args ?? {}) as Partial<UserProfile>;
          const profile = {
            ...profileArgs,
            language: 'Italiano',
          } as UserProfile;
          await finalizeLearnProfile(profile);
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

      const userHistory: Message[] = [...previousMessages, userMessage];
      if (hasEnoughHighImpactAssessmentSignals(userHistory)) {
        pushNousDebugTrace('assessment:local-complete-from-signals', {
          requestId,
          userTurns: userHistory.filter(message => message.role === 'user').length,
        });
        state.setAssessmentMessages([
          ...userHistory,
          { role: 'model', text: LOCAL_ASSESSMENT_COMPLETE_MESSAGE } satisfies Message,
        ]);
        state.succeedWorkflow('assessment', requestId);
        return { outcome: 'assessment-complete' };
      }

      const response = await chatSession.sendMessage({
        message: buildHomeChatMessageForModel(trimmedInput, toolPreferences),
      });
      const modelText = response.text || '';
      const nextHistory: Message[] = [
        ...previousMessages,
        userMessage,
        { role: 'model', text: modelText },
      ];
      state.setAssessmentMessages(nextHistory);

      const userTurns = nextHistory.filter(message => message.role === 'user').length;
      const isAssessmentComplete =
        modelText.includes('[ASSESSMENT_COMPLETE]') &&
        userTurns >= MIN_DOCUMENT_USER_TURNS_BEFORE_PLANNING;

      state.succeedWorkflow('assessment', requestId);

      if (isAssessmentComplete) {
        return { outcome: 'assessment-complete' as const };
      }

      return { outcome: 'continued' };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('assessment', requestId, errorMessage);
      return { outcome: 'failed', errorMessage };
    }
  }

  async function confirmPlanGeneration(): Promise<{
    errorMessage?: string;
    outcome: 'failed' | 'planned';
  }> {
    try {
      const history = state.getAssessmentMessages();
      const mode = domain.isLearnMode ? 'learn' : 'document';
      const profile = domain.userProfile ?? undefined;
      await runPlanGeneration({ history, mode, profile });
      return { outcome: 'planned' };
    } catch (error) {
      return { outcome: 'failed', errorMessage: getErrorMessage(error) };
    }
  }

  return {
    cancelAssessment,
    confirmPlanGeneration,
    startHomeChat,
    startAssessment,
    startLearnAssessment,
    startLearnJourney,
    submitAssessment,
  };
};
