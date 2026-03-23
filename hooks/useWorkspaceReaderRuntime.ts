/* @refresh reset */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReaderChrome } from './useReaderChrome.ts';
import { useReaderContext } from './useReaderContext.ts';
import { useReaderSpeechBlocks } from './useReaderSpeech.ts';
import { useTtsPlayer } from './useTtsPlayer.ts';
import {
  buildLessonAssetMap,
  buildLessonImageRefMap,
  buildSidebarGroups,
} from '../utils/workspaceReader.ts';
import type {
  LearningPlan,
  LearningSection,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
  PdfDocumentAssets,
  QuizQuestion,
  SyllabusItem,
  UiPreferences,
} from '../types.ts';

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
    setIsQuizSubmitted(false);
  }, [activeSectionId]);

  useEffect(() => {
    setQuizAnswers(quiz.length > 0 ? new Array(quiz.length).fill(-1) : []);
  }, [activeSectionId, quiz]);

  const handleSelectQuizAnswer = useCallback(
    (questionIndex: number, optionIndex: number) => {
      if (isQuizSubmitted) {
        return;
      }

      setQuizAnswers(currentAnswers => {
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
