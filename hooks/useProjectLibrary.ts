import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { IndexedDbProjectRepository } from '../services/indexedDbProjectRepository';
import { createProjectSnapshot, exportProjectData } from '../services/projectSnapshot';
import { ProjectStorageError } from '../services/projectRepository';
import {
  AppState,
  type ContextMenuState,
  type FileData,
  type LearningPlan,
  type Message,
  type ProjectExportData,
  type ProjectSnapshot,
  type QuizQuestion,
  type SavedProjectMeta,
  type SyllabusItem,
  type UiPreferences,
  type UserProfile,
  type VoiceName,
} from '../types';

const UI_PREFERENCES_KEY = 'lumina-ui-preferences';
const projectRepository = new IndexedDbProjectRepository();

interface WorkspaceState {
  state: AppState;
  file: FileData | null;
  learningPlan: LearningPlan | null;
  isLearnMode: boolean;
  userProfile: UserProfile | null;
  syllabus: SyllabusItem[];
  activeSectionId: string | null;
  musicUrl: string;
  isDarkMode: boolean;
  teleprompterSpeed: number;
  preferredVoice: VoiceName;
  playbackRate: number;
}

interface ProjectLibrarySetters<TChatSession, TContextAnswer> {
  setState: Dispatch<SetStateAction<AppState>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setFile: Dispatch<SetStateAction<FileData | null>>;
  setLearningPlan: Dispatch<SetStateAction<LearningPlan | null>>;
  setAssessmentMessages: Dispatch<SetStateAction<Message[]>>;
  setCurrentAssessmentInput: Dispatch<SetStateAction<string>>;
  setChatSession: Dispatch<SetStateAction<TChatSession | null>>;
  setIsLearnMode: Dispatch<SetStateAction<boolean>>;
  setUserProfile: Dispatch<SetStateAction<UserProfile | null>>;
  setSyllabus: Dispatch<SetStateAction<SyllabusItem[]>>;
  setMusicUrl: Dispatch<SetStateAction<string>>;
  setIsQuizSubmitted: Dispatch<SetStateAction<boolean>>;
  setContextAnswer: Dispatch<SetStateAction<TContextAnswer | null>>;
  setContextMenu: Dispatch<SetStateAction<ContextMenuState>>;
  setSpeechBlocks: Dispatch<SetStateAction<string[]>>;
  setIsFocusMode: Dispatch<SetStateAction<boolean>>;
  setActiveSectionId: Dispatch<SetStateAction<string | null>>;
  setSectionContent: Dispatch<SetStateAction<string>>;
  setQuiz: Dispatch<SetStateAction<QuizQuestion[]>>;
  setQuizAnswers: Dispatch<SetStateAction<number[]>>;
  setIsDarkMode: Dispatch<SetStateAction<boolean>>;
  setTeleprompterSpeed: Dispatch<SetStateAction<number>>;
}

interface AudioPreferenceHandlers {
  applyPreferredVoice: (voice: VoiceName) => void;
  applyPlaybackRate: (rate: number) => void;
  setTestVoice: (voice: VoiceName) => void;
}

interface UseProjectLibraryArgs<TChatSession, TContextAnswer> {
  audioHandlers: AudioPreferenceHandlers;
  workspace: WorkspaceState;
  setters: ProjectLibrarySetters<TChatSession, TContextAnswer>;
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
};

export const useProjectLibrary = <TChatSession, TContextAnswer>({
  audioHandlers,
  workspace,
  setters,
}: UseProjectLibraryArgs<TChatSession, TContextAnswer>) => {
  const { applyPlaybackRate, applyPreferredVoice, setTestVoice } = audioHandlers;
  const {
    setActiveSectionId,
    setAssessmentMessages,
    setChatSession,
    setContextAnswer,
    setContextMenu,
    setCurrentAssessmentInput,
    setFile,
    setIsDarkMode,
    setIsFocusMode,
    setIsLearnMode,
    setIsLoading,
    setIsQuizSubmitted,
    setLearningPlan,
    setMusicUrl,
    setQuiz,
    setQuizAnswers,
    setSectionContent,
    setSpeechBlocks,
    setState,
    setSyllabus,
    setTeleprompterSpeed,
    setUserProfile,
  } = setters;

  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [savedProjects, setSavedProjects] = useState<SavedProjectMeta[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [needsSourceFile, setNeedsSourceFile] = useState(false);
  const autosaveTimeoutRef = useRef<number | null>(null);
  const isProjectHydratedRef = useRef(false);
  const persistentStorageRequestedRef = useRef(false);
  const didLoadInitialStateRef = useRef(false);

  const sortProjects = useCallback(
    (projects: SavedProjectMeta[]) => projects.slice().sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime()),
    []
  );

  const syncProjectMeta = useCallback((meta: SavedProjectMeta) => {
    setSavedProjects((previousProjects) => {
      const nextProjects = previousProjects.filter(project => project.id !== meta.id);
      nextProjects.push(meta);
      return sortProjects(nextProjects);
    });
  }, [sortProjects]);

  const refreshSavedProjects = useCallback(async () => {
    const projects = await projectRepository.listProjects();
    setSavedProjects(sortProjects(projects));
  }, [sortProjects]);

  const requestPersistentStorage = useCallback(async () => {
    if (persistentStorageRequestedRef.current) {
      return;
    }

    persistentStorageRequestedRef.current = true;

    if (typeof window === 'undefined' || !window.isSecureContext || !navigator.storage?.persist) {
      return;
    }

    try {
      await navigator.storage.persist();
    } catch {
      // Best effort only.
    }
  }, []);

  const resetWorkspace = useCallback(() => {
    isProjectHydratedRef.current = false;
    setCurrentProjectId(null);
    setFile(null);
    setLearningPlan(null);
    setAssessmentMessages([]);
    setCurrentAssessmentInput('');
    setChatSession(null);
    setMusicUrl('');
    setActiveSectionId(null);
    setSectionContent('');
    setSpeechBlocks([]);
    setQuiz([]);
    setQuizAnswers([]);
    setIsQuizSubmitted(false);
    setContextMenu({ visible: false, x: 0, y: 0, selectedText: '' });
    setContextAnswer(null);
    setIsFocusMode(false);
    setIsLearnMode(false);
    setUserProfile(null);
    setSyllabus([]);
    setNeedsSourceFile(false);
  }, [setActiveSectionId, setAssessmentMessages, setChatSession, setContextAnswer, setContextMenu, setCurrentAssessmentInput, setFile, setIsFocusMode, setIsLearnMode, setIsQuizSubmitted, setLearningPlan, setMusicUrl, setQuiz, setQuizAnswers, setSectionContent, setSpeechBlocks, setSyllabus, setUserProfile]);

  const currentProjectMeta = useMemo(
    () => savedProjects.find((project) => project.id === currentProjectId) || null,
    [currentProjectId, savedProjects]
  );

  const buildSnapshotFromState = useCallback((overrides?: Partial<ProjectSnapshot>): ProjectSnapshot | null => {
    const projectId = overrides?.id || currentProjectId;
    if (!projectId) {
      return null;
    }

    const resolvedMusicUrl = overrides?.musicUrl ?? workspace.musicUrl ?? workspace.learningPlan?.backgroundMusicUrl ?? '';
    const planWithMusic =
      overrides?.learningPlan ??
      (workspace.learningPlan ? { ...workspace.learningPlan, backgroundMusicUrl: resolvedMusicUrl } : null);

    return createProjectSnapshot({
      id: projectId,
      version: overrides?.version,
      sourceKind: overrides?.sourceKind || currentProjectMeta?.sourceKind,
      state: overrides?.state || workspace.state,
      file: overrides?.file !== undefined ? overrides.file : workspace.file,
      learningPlan: planWithMusic,
      isLearnMode: overrides?.isLearnMode ?? workspace.isLearnMode,
      userProfile: overrides?.userProfile !== undefined ? overrides.userProfile : workspace.userProfile,
      syllabus: overrides?.syllabus ?? workspace.syllabus,
      activeSectionId: overrides?.activeSectionId !== undefined ? overrides.activeSectionId : workspace.activeSectionId,
      musicUrl: overrides?.musicUrl !== undefined ? overrides.musicUrl : workspace.musicUrl,
      createdAt: overrides?.createdAt || currentProjectMeta?.createdAt,
      updatedAt: overrides?.updatedAt,
      lastOpenedAt: overrides?.lastOpenedAt || currentProjectMeta?.lastOpenedAt,
    });
  }, [currentProjectId, currentProjectMeta, workspace]);

  const persistSnapshot = useCallback(async (snapshot: ProjectSnapshot) => {
    try {
      const meta = await projectRepository.saveProject(snapshot);
      syncProjectMeta(meta);
      setStorageError(null);
      void requestPersistentStorage();
      return meta;
    } catch (error) {
      const message = error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
      setStorageError(message);
      return null;
    }
  }, [requestPersistentStorage, syncProjectMeta]);

  const saveCurrentProject = useCallback(async (overrides?: Partial<ProjectSnapshot>) => {
    const snapshot = buildSnapshotFromState(overrides);
    if (!snapshot) {
      return null;
    }

    return persistSnapshot(snapshot);
  }, [buildSnapshotFromState, persistSnapshot]);

  const downloadJson = useCallback((data: unknown, filename: string) => {
    const dataStr = `data:text/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data))}`;
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute('href', dataStr);
    downloadAnchorNode.setAttribute('download', filename);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  }, []);

  const downloadProject = useCallback(async (projectId?: string) => {
    const targetProjectId = projectId || currentProjectId;
    if (!targetProjectId) {
      return;
    }

    const exportData =
      targetProjectId === currentProjectId
        ? buildSnapshotFromState()
        : await projectRepository.loadProject(targetProjectId);

    if (!exportData) {
      return;
    }

    const payload: ProjectExportData = exportProjectData(exportData);
    downloadJson(payload, `lumina-plan-${new Date().toISOString().slice(0, 10)}.json`);
  }, [buildSnapshotFromState, currentProjectId, downloadJson]);

  const applySnapshotToWorkspace = useCallback((snapshot: ProjectSnapshot) => {
    isProjectHydratedRef.current = false;
    setIsLoading(false);
    setCurrentProjectId(snapshot.id);
    setFile(snapshot.file);
    setLearningPlan(snapshot.learningPlan);
    setAssessmentMessages([]);
    setCurrentAssessmentInput('');
    setChatSession(null);
    setIsLearnMode(snapshot.isLearnMode);
    setUserProfile(snapshot.userProfile);
    setSyllabus(snapshot.syllabus);
    setMusicUrl(snapshot.musicUrl || snapshot.learningPlan?.backgroundMusicUrl || '');
    setNeedsSourceFile(!snapshot.file && Boolean(snapshot.learningPlan) && !snapshot.isLearnMode);
    setIsQuizSubmitted(false);
    setContextAnswer(null);
    setContextMenu({ visible: false, x: 0, y: 0, selectedText: '' });
    setSpeechBlocks([]);
    setIsFocusMode(false);

    const nextSection =
      snapshot.learningPlan?.sections.find(section => section.id === snapshot.activeSectionId) ||
      snapshot.learningPlan?.sections.find(section => !section.isCompleted) ||
      snapshot.learningPlan?.sections[0] ||
      null;

    setActiveSectionId(nextSection?.id || null);
    setSectionContent(nextSection?.content || '');
    setQuiz(nextSection?.quiz || []);
    setQuizAnswers(nextSection?.quiz ? new Array(nextSection.quiz.length).fill(-1) : []);
    setState(snapshot.learningPlan ? AppState.READING : AppState.LIBRARY);

    window.setTimeout(() => {
      isProjectHydratedRef.current = true;
    }, 0);
  }, [setActiveSectionId, setAssessmentMessages, setChatSession, setContextAnswer, setContextMenu, setCurrentAssessmentInput, setFile, setIsFocusMode, setIsLearnMode, setIsLoading, setIsQuizSubmitted, setLearningPlan, setMusicUrl, setQuiz, setQuizAnswers, setSectionContent, setSpeechBlocks, setState, setSyllabus, setUserProfile]);

  useEffect(() => {
    if (didLoadInitialStateRef.current) {
      return;
    }

    didLoadInitialStateRef.current = true;

    const loadInitialState = async () => {
      try {
        const rawPreferences = window.localStorage.getItem(UI_PREFERENCES_KEY);
        if (rawPreferences) {
          const parsed = JSON.parse(rawPreferences) as Partial<UiPreferences>;
          if (typeof parsed.isDarkMode === 'boolean') {
            setIsDarkMode(parsed.isDarkMode);
          }
          if (typeof parsed.teleprompterSpeed === 'number') {
            setTeleprompterSpeed(parsed.teleprompterSpeed);
          }
          if (typeof parsed.preferredVoice === 'string') {
            applyPreferredVoice(parsed.preferredVoice as VoiceName);
            setTestVoice(parsed.preferredVoice as VoiceName);
          }
          if (typeof parsed.playbackRate === 'number') {
            applyPlaybackRate(parsed.playbackRate);
          }
        }
      } catch {
        // Ignore corrupted local UI preferences.
      }

      try {
        await refreshSavedProjects();
      } finally {
        setIsLibraryLoading(false);
      }
    };

    void loadInitialState();
  }, [applyPlaybackRate, applyPreferredVoice, refreshSavedProjects, setIsDarkMode, setTeleprompterSpeed, setTestVoice]);

  useEffect(() => {
    const nextPreferences: UiPreferences = {
      isDarkMode: workspace.isDarkMode,
      teleprompterSpeed: workspace.teleprompterSpeed,
      preferredVoice: workspace.preferredVoice,
      playbackRate: workspace.playbackRate,
    };

    window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(nextPreferences));
  }, [workspace.isDarkMode, workspace.playbackRate, workspace.preferredVoice, workspace.teleprompterSpeed]);

  useEffect(() => {
    if (!currentProjectId || !isProjectHydratedRef.current) {
      return;
    }

    if (autosaveTimeoutRef.current) {
      window.clearTimeout(autosaveTimeoutRef.current);
    }

    autosaveTimeoutRef.current = window.setTimeout(() => {
      void saveCurrentProject();
    }, 800);

    return () => {
      if (autosaveTimeoutRef.current) {
        window.clearTimeout(autosaveTimeoutRef.current);
        autosaveTimeoutRef.current = null;
      }
    };
  }, [currentProjectId, saveCurrentProject]);

  return {
    applySnapshotToWorkspace,
    currentProjectId,
    deleteStoredProject: projectRepository.deleteProject.bind(projectRepository),
    downloadProject,
    importProjectData: projectRepository.importProject.bind(projectRepository),
    isLibraryLoading,
    isProjectHydratedRef,
    loadStoredProject: projectRepository.loadProject.bind(projectRepository),
    needsSourceFile,
    persistSnapshot,
    refreshSavedProjects,
    resetWorkspace,
    saveCurrentProject,
    savedProjects,
    setCurrentProjectId,
    setNeedsSourceFile,
    setProjectHydrated: (value: boolean) => {
      isProjectHydratedRef.current = value;
    },
    storageError,
    touchStoredProject: projectRepository.touchProject.bind(projectRepository),
  };
};
