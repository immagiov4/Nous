/* @refresh reset */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReaderChrome } from '../reader/useReaderChrome.ts';
import { useReaderContext } from '../reader/useReaderContext.ts';
import { useReaderSpeechBlocks } from '../reader/useReaderSpeech.ts';
import { useTtsPlayer } from '../reader/useTtsPlayer.ts';
import {
  buildLessonAssetMap,
  buildLessonImageRefMap,
  buildSidebarGroups,
} from '../../utils/reader/workspaceReader.ts';
import type {
  LearningPlan,
  LearningSection,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
  PdfDocumentAssets,
  QuizQuestion,
  SyllabusItem,
  UiPreferences,
} from '../../types.ts';

interface UseWorkspaceReaderRuntimeArgs {
  activeSection: LearningSection | null;
  activeSectionId: string | null;
  documentAssets: PdfDocumentAssets | null;
  learningPlan: LearningPlan | null;
  quiz: QuizQuestion[];
  sectionContent: string;
  syllabus: SyllabusItem[];
}

export const useWorkspaceReaderRuntime = ({
  activeSection,
  activeSectionId,
  documentAssets,
  learningPlan,
  quiz,
  sectionContent,
  syllabus,
}: UseWorkspaceReaderRuntimeArgs) => {
  const sidebarGroups = useMemo(
    () => buildSidebarGroups(learningPlan, syllabus),
    [learningPlan, syllabus]
  );
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [musicVolume, setMusicVolume] = useState(20);
  const [quizAnswers, setQuizAnswers] = useState<number[]>([]);
  const [isQuizSubmitted, setIsQuizSubmitted] = useState(false);
  const [preferredModels, setPreferredModels] = useState<OpenRouterModelPreferences>({
    preferredLessonModel: '',
    preferredAssessmentModel: '',
    preferredContextModel: '',
  });
  const previousQuizSectionIdRef = useRef(activeSectionId);
  const previousQuizSubmissionSectionIdRef = useRef(activeSectionId);

  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const readerChrome = useReaderChrome({
    activeSectionId,
    sidebarGroups,
  });
  const readerContext = useReaderContext({
    activeSectionId,
    contentRef,
    isMobileViewport: readerChrome.isMobileViewport,
    sectionAnnotations: activeSection?.annotations,
    sectionContent,
  });
  const { speechBlocks } = useReaderSpeechBlocks({
    contentRef,
    sectionContent,
  });
  const ttsPlayer = useTtsPlayer({
    activeSectionId,
    sectionContent,
    speechBlocks,
  });

  const setPreferredOpenRouterModel = useCallback((slot: OpenRouterModelSlot, value: string) => {
    const trimmedValue = value.trim();
    setPreferredModels(currentModels => {
      const key =
        slot === 'assessment'
          ? 'preferredAssessmentModel'
          : slot === 'context'
            ? 'preferredContextModel'
            : 'preferredLessonModel';

      if (currentModels[key] === trimmedValue) {
        return currentModels;
      }

      return {
        ...currentModels,
        [key]: trimmedValue,
      };
    });
  }, []);

  const applyUiPreferences = useCallback(
    (preferences: Partial<UiPreferences>) => {
      if (typeof preferences.isDarkMode === 'boolean') {
        readerChrome.setIsDarkMode(preferences.isDarkMode);
      }

      if (preferences.preferredVoice) {
        ttsPlayer.handleVoiceChange(preferences.preferredVoice);
      }

      if (typeof preferences.playbackRate === 'number') {
        ttsPlayer.handleSpeedChange(preferences.playbackRate);
      }

      setPreferredModels(currentModels => ({
        preferredLessonModel:
          typeof preferences.preferredLessonModel === 'string'
            ? preferences.preferredLessonModel
            : currentModels.preferredLessonModel,
        preferredAssessmentModel:
          typeof preferences.preferredAssessmentModel === 'string'
            ? preferences.preferredAssessmentModel
            : currentModels.preferredAssessmentModel,
        preferredContextModel:
          typeof preferences.preferredContextModel === 'string'
            ? preferences.preferredContextModel
            : currentModels.preferredContextModel,
      }));
    },
    [
      readerChrome.setIsDarkMode,
      ttsPlayer.handleSpeedChange,
      ttsPlayer.handleVoiceChange,
    ]
  );

  const uiPreferences = useMemo<UiPreferences>(
    () => ({
      isDarkMode: readerChrome.isDarkMode,
      preferredVoice: ttsPlayer.audioState.currentVoice,
      playbackRate: ttsPlayer.audioState.playbackRate,
      preferredLessonModel: preferredModels.preferredLessonModel,
      preferredAssessmentModel: preferredModels.preferredAssessmentModel,
      preferredContextModel: preferredModels.preferredContextModel,
    }),
    [
      preferredModels.preferredAssessmentModel,
      preferredModels.preferredContextModel,
      preferredModels.preferredLessonModel,
      readerChrome.isDarkMode,
      ttsPlayer.audioState.currentVoice,
      ttsPlayer.audioState.playbackRate,
    ]
  );

  const activeSidebarGroup = useMemo(
    () =>
      sidebarGroups.find(group => group.sections.some(section => section.id === activeSectionId)) ||
      null,
    [activeSectionId, sidebarGroups]
  );
  const activeSectionAssetsById = useMemo(
    () => buildLessonAssetMap(activeSection?.imageRefs, documentAssets),
    [activeSection?.imageRefs, documentAssets]
  );
  const activeSectionImageRefsById = useMemo(
    () => buildLessonImageRefMap(activeSection?.imageRefs),
    [activeSection?.imageRefs]
  );

  useEffect(() => {
    if (previousQuizSubmissionSectionIdRef.current === activeSectionId) {
      return;
    }

    previousQuizSubmissionSectionIdRef.current = activeSectionId;
    setIsQuizSubmitted(false);
  }, [activeSectionId]);

  useEffect(() => {
    const sectionChanged = previousQuizSectionIdRef.current !== activeSectionId;
    previousQuizSectionIdRef.current = activeSectionId;

    setQuizAnswers(currentAnswers => {
      const nextAnswers = quiz.length > 0 ? new Array(quiz.length).fill(-1) : [];
      if (
        !sectionChanged &&
        currentAnswers.length === nextAnswers.length &&
        currentAnswers.every(answer => answer === -1)
      ) {
        return currentAnswers;
      }

      return nextAnswers;
    });
  }, [activeSectionId, quiz]);

  const handleSelectQuizAnswer = useCallback(
    (questionIndex: number, optionIndex: number) => {
      if (isQuizSubmitted) {
        return;
      }

      setQuizAnswers(currentAnswers => {
        if (currentAnswers[questionIndex] !== -1) {
          return currentAnswers;
        }

        const nextAnswers = [...currentAnswers];
        nextAnswers[questionIndex] = optionIndex;
        return nextAnswers;
      });
    },
    [isQuizSubmitted]
  );

  return {
    activeSectionAssetsById,
    activeSectionImageRefsById,
    activeSidebarGroup,
    applyUiPreferences,
    contentRef,
    handleSelectQuizAnswer,
    isMusicPlaying,
    isQuizSubmitted,
    musicVolume,
    quizAnswers,
    readerChrome,
    readerContext,
    scrollContainerRef,
    setIsMusicPlaying,
    setIsQuizSubmitted,
    setMusicVolume,
    setPreferredOpenRouterModel,
    preferredModels,
    sidebarGroups,
    ttsPlayer,
    uiPreferences,
  };
};
