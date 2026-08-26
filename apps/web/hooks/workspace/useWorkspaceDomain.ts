import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pushNousDebugTrace } from '../../services/core/debugTrace.ts';
import {
  getProjectSourceFile,
  getProjectSourceName,
} from '../../services/projects/projectSource.ts';
import {
  createEmptyWorkspaceDomainState,
  selectActiveSection,
  selectActiveSectionContent,
  selectActiveSectionQuiz,
  selectGenerationNotes,
  selectMusicUrl,
  selectNeedsSourceFile,
  type WorkspaceDomainAction,
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

export const useWorkspaceDomain = () => {
  const [domainState, setDomainState] = useState(createEmptyWorkspaceDomainState);
  const domainStateRef = useRef(domainState);

  const applyDomainAction = useCallback((action: WorkspaceDomainAction) => {
    const nextState = workspaceDomainReducer(domainStateRef.current, action);
    domainStateRef.current = nextState;
    setDomainState(nextState);
  }, []);
  const getDomainState = useCallback(() => domainStateRef.current, []);

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

  const hydrateSnapshot = useCallback(
    (snapshot: ProjectSnapshot) => {
      applyDomainAction({ type: 'hydrate', snapshot });
    },
    [applyDomainAction]
  );

  const resetDomain = useCallback(() => {
    applyDomainAction({ type: 'reset' });
  }, [applyDomainAction]);

  const setSource = useCallback(
    (nextSource: ProjectSource | null) => {
      applyDomainAction({ type: 'set-source', source: nextSource });
    },
    [applyDomainAction]
  );

  const setLearningPlan = useCallback(
    (nextPlan: LearningPlan | null) => {
      applyDomainAction({ type: 'set-learning-plan', learningPlan: nextPlan });
    },
    [applyDomainAction]
  );

  const setDocumentAssets = useCallback(
    (nextAssets: PdfDocumentAssets | null) => {
      applyDomainAction({ type: 'set-document-assets', documentAssets: nextAssets });
    },
    [applyDomainAction]
  );

  const setDocumentIndex = useCallback(
    (nextIndex: PdfTextIndex | null) => {
      applyDomainAction({ type: 'set-document-index', documentIndex: nextIndex });
    },
    [applyDomainAction]
  );

  const setIsLearnMode = useCallback(
    (value: boolean) => {
      applyDomainAction({ type: 'set-learn-mode', isLearnMode: value });
    },
    [applyDomainAction]
  );

  const setUserProfile = useCallback(
    (profile: UserProfile | null) => {
      applyDomainAction({ type: 'set-user-profile', userProfile: profile });
    },
    [applyDomainAction]
  );

  const setSyllabus = useCallback(
    (nextSyllabus: SyllabusItem[]) => {
      applyDomainAction({ type: 'set-syllabus', syllabus: nextSyllabus });
    },
    [applyDomainAction]
  );

  const setResearchCoursePlan = useCallback(
    (nextPlan: ResearchCoursePlan | null) => {
      applyDomainAction({ type: 'set-research-course-plan', researchCoursePlan: nextPlan });
    },
    [applyDomainAction]
  );

  const setResearchLessonDossier = useCallback(
    (dossier: ResearchLessonDossier) => {
      applyDomainAction({ type: 'set-research-lesson-dossier', dossier });
    },
    [applyDomainAction]
  );

  const setResearchDossiers = useCallback(
    (nextDossiers: ResearchDossiersBySectionId) => {
      applyDomainAction({
        type: 'set-research-dossiers',
        researchDossiersBySectionId: nextDossiers,
      });
    },
    [applyDomainAction]
  );

  const setActiveSectionId = useCallback(
    (nextSectionId: string | null) => {
      applyDomainAction({ type: 'set-active-section', activeSectionId: nextSectionId });
    },
    [applyDomainAction]
  );

  const setMusicUrl = useCallback(
    (nextMusicUrl: string) => {
      applyDomainAction({ type: 'set-music-url', musicUrl: nextMusicUrl });
    },
    [applyDomainAction]
  );

  const setGenerationNotes = useCallback(
    (nextNotes: string) => {
      applyDomainAction({ type: 'set-generation-notes', generationNotes: nextNotes });
    },
    [applyDomainAction]
  );

  const updateActiveSectionContent = useCallback(
    (content: string) => {
      applyDomainAction({ type: 'update-active-section-content', content });
    },
    [applyDomainAction]
  );

  const updateActiveSectionQuiz = useCallback(
    (nextQuiz: QuizQuestion[]) => {
      applyDomainAction({ type: 'update-active-section-quiz', quiz: nextQuiz });
    },
    [applyDomainAction]
  );

  const updateSection = useCallback(
    (sectionId: string, updater: (section: LessonNode) => LessonNode) => {
      applyDomainAction({ type: 'update-section', sectionId, updater });
    },
    [applyDomainAction]
  );

  const insertSectionAfter = useCallback(
    (parentSectionId: string, section: LessonNode) => {
      applyDomainAction({ type: 'insert-section-after', parentSectionId, section });
    },
    [applyDomainAction]
  );

  useEffect(() => {
    pushNousDebugTrace('domain/source-updated', {
      hasLearningPlan: Boolean(learningPlan),
      sourceKind: source?.kind || null,
      sourceName: getProjectSourceName(source) || null,
      archiveEntryCount: source?.kind === 'archive' ? source.index.entries.length : null,
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
      getDomainState,
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
      getDomainState,
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
