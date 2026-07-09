// fallow-ignore-file unused-files
import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { pushNousDebugTrace } from '../../services/core/debugTrace.ts';
import { getProjectSourceFile } from '../../services/projects/projectSource.ts';
import {
  createEmptyWorkspaceDomainState,
  selectActiveSection,
  selectActiveSectionContent,
  selectActiveSectionQuiz,
  selectGenerationNotes,
  selectMusicUrl,
  selectNeedsSourceFile,
  workspaceDomainReducer,
} from '../../services/workspace/domain';
import type {
  LearningPlan,
  LessonNode,
  PdfDocumentAssets,
  PdfTextIndex,
  ProjectSnapshot,
  ProjectSource,
  QuizQuestion,
  ResearchCoursePlan,
  ResearchDossiersBySectionId,
  ResearchLessonDossier,
  SyllabusItem,
  UserProfile,
} from '../../types';

// fallow-ignore-next-line unused-exports — used by App.tsx
export const useWorkspaceDomain = () => {
  const [domainState, dispatch] = useReducer(
    workspaceDomainReducer,
    undefined,
    createEmptyWorkspaceDomainState
  );

  const source = domainState.source;
  const file = useMemo(() => getProjectSourceFile(source), [source]);
  const learningPlan = domainState.learningPlan;
  const documentAssets = domainState.documentAssets;
  const documentIndex = domainState.documentIndex;
  const isLearnMode = domainState.isLearnMode;
  const userProfile = domainState.userProfile;
  const syllabus = domainState.syllabus;
  const researchCoursePlan = domainState.researchCoursePlan ?? null;
  const researchDossiersBySectionId = useMemo(
    () => domainState.researchDossiersBySectionId ?? {},
    [domainState.researchDossiersBySectionId]
  );
  const activeSectionId = domainState.activeSectionId;
  const activeSection = useMemo(
    () => selectActiveSection({ learningPlan, activeSectionId }),
    [learningPlan, activeSectionId]
  );
  const sectionContent = useMemo(
    () => selectActiveSectionContent({ learningPlan, activeSectionId }),
    [learningPlan, activeSectionId]
  );
  const quiz = useMemo(
    () => selectActiveSectionQuiz({ learningPlan, activeSectionId }),
    [learningPlan, activeSectionId]
  );
  const musicUrl = useMemo(() => selectMusicUrl({ learningPlan }), [learningPlan]);
  const generationNotes = useMemo(() => selectGenerationNotes({ learningPlan }), [learningPlan]);
  const needsSourceFile = useMemo(
    () => selectNeedsSourceFile({ source, learningPlan, isLearnMode }),
    [source, learningPlan, isLearnMode]
  );

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

  const setResearchCoursePlan = useCallback((nextPlan: ResearchCoursePlan | null) => {
    dispatch({ type: 'set-research-course-plan', researchCoursePlan: nextPlan });
  }, []);

  const setResearchLessonDossier = useCallback((dossier: ResearchLessonDossier) => {
    dispatch({ type: 'set-research-lesson-dossier', dossier });
  }, []);

  const setResearchDossiers = useCallback((nextDossiers: ResearchDossiersBySectionId) => {
    dispatch({ type: 'set-research-dossiers', researchDossiersBySectionId: nextDossiers });
  }, []);

  const setActiveSectionId = useCallback((nextSectionId: string | null) => {
    dispatch({ type: 'set-active-section', activeSectionId: nextSectionId });
  }, []);

  const setMusicUrl = useCallback((nextMusicUrl: string) => {
    dispatch({ type: 'set-music-url', musicUrl: nextMusicUrl });
  }, []);

  const setGenerationNotes = useCallback((nextNotes: string) => {
    dispatch({ type: 'set-generation-notes', generationNotes: nextNotes });
  }, []);

  const updateActiveSectionContent = useCallback((content: string) => {
    dispatch({ type: 'update-active-section-content', content });
  }, []);

  const updateActiveSectionQuiz = useCallback((nextQuiz: QuizQuestion[]) => {
    dispatch({ type: 'update-active-section-quiz', quiz: nextQuiz });
  }, []);

  const updateSection = useCallback(
    (sectionId: string, updater: (section: LessonNode) => LessonNode) => {
      dispatch({ type: 'update-section', sectionId, updater });
    },
    []
  );

  const insertSectionAfter = useCallback((parentSectionId: string, section: LessonNode) => {
    dispatch({ type: 'insert-section-after', parentSectionId, section });
  }, []);

  useEffect(() => {
    pushNousDebugTrace('domain/source-updated', {
      hasLearningPlan: Boolean(learningPlan),
      sourceKind: source?.kind || null,
      sourceName: source?.kind === 'pdf' ? source.file.name : source?.name || null,
      textLength: source?.kind === 'codebase-bundle' ? source.aggregatedText.length : null,
    });
  }, [learningPlan, source]);

  return useMemo(
    () => ({
      activeSection,
      activeSectionId,
      documentAssets,
      documentIndex,
      domainState,
      file,
      generationNotes,
      hydrateSnapshot,
      insertSectionAfter,
      isLearnMode,
      learningPlan,
      musicUrl,
      needsSourceFile,
      quiz,
      resetDomain,
      researchCoursePlan,
      researchDossiersBySectionId,
      sectionContent,
      setActiveSectionId,
      setDocumentAssets,
      setDocumentIndex,
      setGenerationNotes,
      setIsLearnMode,
      setLearningPlan,
      setMusicUrl,
      setResearchCoursePlan,
      setResearchDossiers,
      setResearchLessonDossier,
      setSource,
      setSyllabus,
      setUserProfile,
      source,
      syllabus,
      updateActiveSectionContent,
      updateActiveSectionQuiz,
      updateSection,
      userProfile,
    }),
    [
      activeSection,
      activeSectionId,
      documentAssets,
      documentIndex,
      domainState,
      file,
      generationNotes,
      hydrateSnapshot,
      insertSectionAfter,
      isLearnMode,
      learningPlan,
      musicUrl,
      needsSourceFile,
      quiz,
      resetDomain,
      researchCoursePlan,
      researchDossiersBySectionId,
      sectionContent,
      setActiveSectionId,
      setDocumentAssets,
      setDocumentIndex,
      setGenerationNotes,
      setIsLearnMode,
      setLearningPlan,
      setMusicUrl,
      setResearchCoursePlan,
      setResearchDossiers,
      setResearchLessonDossier,
      setSource,
      setSyllabus,
      setUserProfile,
      source,
      syllabus,
      updateActiveSectionContent,
      updateActiveSectionQuiz,
      updateSection,
      userProfile,
    ]
  );
};
