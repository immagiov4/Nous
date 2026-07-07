// fallow-ignore-file unused-files
/* @refresh reset */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AudioPanelTab,
  LearningPlan,
  LearningSection,
  PdfDocumentAssets,
  QuizQuestion,
  SettingsPanelSectionId,
  SyllabusItem,
  UiPreferences,
} from '../../types.ts';
import {
  buildLessonAssetMap,
  buildLessonImageRefMap,
  buildSidebarGroups,
} from '../../utils/reader/workspaceReader.ts';
import { useReaderChrome } from '../reader/useReaderChrome.ts';
import { useReaderContext } from '../reader/useReaderContext.ts';
import { useReaderSpeechBlocks } from '../reader/useReaderSpeech.ts';
import { useTtsPlayer } from '../reader/useTtsPlayer.ts';

interface UseWorkspaceReaderStateArgs {
  activeSection: LearningSection | null;
  activeSectionId: string | null;
  documentAssets: PdfDocumentAssets | null;
  learningPlan: LearningPlan | null;
  quiz: QuizQuestion[];
  sectionContent: string;
  syllabus: SyllabusItem[];
}

const areSettingsSectionsEqual = (
  currentSections: SettingsPanelSectionId[],
  nextSections: SettingsPanelSectionId[]
) =>
  currentSections.length === nextSections.length &&
  currentSections.every((sectionId, index) => sectionId === nextSections[index]);

// fallow-ignore-next-line unused-exports — used by App.tsx
export const useWorkspaceReaderState = ({
  activeSection,
  activeSectionId,
  documentAssets,
  learningPlan,
  quiz,
  sectionContent,
  syllabus,
}: UseWorkspaceReaderStateArgs) => {
  const sidebarGroups = useMemo(
    () => buildSidebarGroups(learningPlan, syllabus),
    [learningPlan, syllabus]
  );
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [musicVolume, setMusicVolume] = useState(20);
  const [quizAnswers, setQuizAnswers] = useState<number[]>([]);
  const [isQuizSubmitted, setIsQuizSubmitted] = useState(false);
  const [settingsPanelExpandedSections, setSettingsPanelExpandedSections] = useState<
    SettingsPanelSectionId[]
  >(['course-notes']);
  const [lastAudioTab, setLastAudioTab] = useState<AudioPanelTab>('voce');
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
  const { setIsDarkMode } = readerChrome;
  const { handleSpeedChange, handleVoiceChange } = ttsPlayer;

  const applyUiPreferences = useCallback(
    (preferences: Partial<UiPreferences>) => {
      if (typeof preferences.isDarkMode === 'boolean') {
        setIsDarkMode(preferences.isDarkMode);
      }

      const preferredVoice = preferences.preferredTtsVoice || preferences.preferredVoice;
      if (preferredVoice) {
        handleVoiceChange(preferredVoice);
      }

      if (typeof preferences.playbackRate === 'number') {
        handleSpeedChange(preferences.playbackRate);
      }

      if (preferences.lastAudioTab === 'voce' || preferences.lastAudioTab === 'ambiente') {
        setLastAudioTab(preferences.lastAudioTab);
      }

      if (Array.isArray(preferences.settingsPanelExpandedSections)) {
        setSettingsPanelExpandedSections(currentSections =>
          areSettingsSectionsEqual(currentSections, preferences.settingsPanelExpandedSections || [])
            ? currentSections
            : preferences.settingsPanelExpandedSections || []
        );
      }
    },
    [handleSpeedChange, handleVoiceChange, setIsDarkMode]
  );

  const uiPreferences = useMemo<UiPreferences>(
    () => ({
      isDarkMode: readerChrome.isDarkMode,
      lastAudioTab,
      preferredVoice: ttsPlayer.audioState.currentVoice,
      playbackRate: ttsPlayer.audioState.playbackRate,
      preferredTtsVoice: ttsPlayer.audioState.currentVoice,
      settingsPanelExpandedSections,
    }),
    [
      lastAudioTab,
      readerChrome.isDarkMode,
      settingsPanelExpandedSections,
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
  const activeSectionGeneratedVisualsById = useMemo(
    () =>
      Object.fromEntries(
        (activeSection?.generatedVisuals || []).map(visual => [visual.id, visual])
      ),
    [activeSection?.generatedVisuals]
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
    activeSectionGeneratedVisualsById,
    activeSectionImageRefsById,
    activeSidebarGroup,
    applyUiPreferences,
    contentRef,
    handleSelectQuizAnswer,
    isMusicPlaying,
    isQuizSubmitted,
    lastAudioTab,
    musicVolume,
    quizAnswers,
    readerChrome,
    readerContext,
    scrollContainerRef,
    setIsMusicPlaying,
    setIsQuizSubmitted,
    setLastAudioTab,
    setMusicVolume,
    setSettingsPanelExpandedSections,
    settingsPanelExpandedSections,
    sidebarGroups,
    ttsPlayer,
    uiPreferences,
  };
};
