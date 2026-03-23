import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { pushLuminaDebugTrace } from '../services/debugTrace.ts';
import {
  createEmptyWorkspaceDomainState,
  selectActiveSection,
  selectActiveSectionContent,
  selectActiveSectionQuiz,
  selectMusicUrl,
  selectNeedsSourceFile,
  workspaceDomainReducer,
} from '../services/workspaceDomain';
import type {
  LearningPlan,
  LearningSection,
  PdfDocumentAssets,
  PdfTextIndex,
  ProjectSnapshot,
  ProjectSource,
  QuizQuestion,
  SyllabusItem,
  UserProfile,
} from '../types';

export const useWorkspaceDomain = () => {
  const [domainState, dispatch] = useReducer(
    workspaceDomainReducer,
    undefined,
    createEmptyWorkspaceDomainState
  );

  const source = domainState.source;
  const file = useMemo(() => (source?.kind === 'pdf' ? source.file : null), [source]);
  const learningPlan = domainState.learningPlan;
  const documentAssets = domainState.documentAssets;
  const documentIndex = domainState.documentIndex;
  const isLearnMode = domainState.isLearnMode;
  const userProfile = domainState.userProfile;
  const syllabus = domainState.syllabus;
  const activeSectionId = domainState.activeSectionId;
  const activeSection = useMemo(() => selectActiveSection(domainState), [domainState]);
  const sectionContent = useMemo(() => selectActiveSectionContent(domainState), [domainState]);
  const quiz = useMemo(() => selectActiveSectionQuiz(domainState), [domainState]);
  const musicUrl = useMemo(() => selectMusicUrl(domainState), [domainState]);
  const needsSourceFile = useMemo(() => selectNeedsSourceFile(domainState), [domainState]);

  const hydrateSnapshot = useCallback((snapshot: ProjectSnapshot) => {
    dispatch({ type: 'hydrate', snapshot });
  }, []);

  const resetDomain = useCallback(() => {
    dispatch({ type: 'reset' });
  }, []);

  const setSource = useCallback((nextSource: ProjectSource | null) => {
    dispatch({ type: 'set-source', source: nextSource });
  }, []);

  const setLearningPlan = useCallback((nextPlan: LearningPlan | null) => {
    dispatch({ type: 'set-learning-plan', learningPlan: nextPlan });
  }, []);

  const setDocumentAssets = useCallback((nextAssets: PdfDocumentAssets | null) => {
    dispatch({ type: 'set-document-assets', documentAssets: nextAssets });
  }, []);

  const setDocumentIndex = useCallback((nextIndex: PdfTextIndex | null) => {
    dispatch({ type: 'set-document-index', documentIndex: nextIndex });
  }, []);

  const setIsLearnMode = useCallback((value: boolean) => {
    dispatch({ type: 'set-learn-mode', isLearnMode: value });
  }, []);

  const setUserProfile = useCallback((profile: UserProfile | null) => {
    dispatch({ type: 'set-user-profile', userProfile: profile });
  }, []);

  const setSyllabus = useCallback((nextSyllabus: SyllabusItem[]) => {
    dispatch({ type: 'set-syllabus', syllabus: nextSyllabus });
  }, []);

  const setActiveSectionId = useCallback((nextSectionId: string | null) => {
    dispatch({ type: 'set-active-section', activeSectionId: nextSectionId });
  }, []);

  const setMusicUrl = useCallback((nextMusicUrl: string) => {
    dispatch({ type: 'set-music-url', musicUrl: nextMusicUrl });
  }, []);

  const updateActiveSectionContent = useCallback((content: string) => {
    dispatch({ type: 'update-active-section-content', content });
  }, []);

  const updateActiveSectionQuiz = useCallback((nextQuiz: QuizQuestion[]) => {
    dispatch({ type: 'update-active-section-quiz', quiz: nextQuiz });
  }, []);

  const updateSection = useCallback(
    (sectionId: string, updater: (section: LearningSection) => LearningSection) => {
      dispatch({ type: 'update-section', sectionId, updater });
    },
    []
  );

  const insertSectionAfter = useCallback((parentSectionId: string, section: LearningSection) => {
    dispatch({ type: 'insert-section-after', parentSectionId, section });
  }, []);

  useEffect(() => {
    pushLuminaDebugTrace('domain/source-updated', {
      hasLearningPlan: Boolean(domainState.learningPlan),
      sourceKind: source?.kind || null,
      sourceName: source?.kind === 'pdf' ? source.file.name : source?.name || null,
      textLength: source?.kind === 'codebase-bundle' ? source.aggregatedText.length : null,
    });
  }, [domainState.learningPlan, source]);

  return {
    activeSection,
    activeSectionId,
    documentAssets,
    documentIndex,
    domainState,
    file,
    hydrateSnapshot,
    insertSectionAfter,
    isLearnMode,
    learningPlan,
    musicUrl,
    needsSourceFile,
    quiz,
    resetDomain,
    sectionContent,
    setActiveSectionId,
    setDocumentAssets,
    setDocumentIndex,
    setIsLearnMode,
    setLearningPlan,
    setMusicUrl,
    setSource,
    setSyllabus,
    setUserProfile,
    source,
    syllabus,
    updateActiveSectionContent,
    updateActiveSectionQuiz,
    updateSection,
    userProfile,
  };
};
