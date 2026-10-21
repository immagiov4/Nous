import type { LessonQuizState } from '@shared/lessonQuizState';
/* @refresh reset */
import { useCallback, useMemo, useRef, useState } from 'react';
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
  deriveQuizFromLessonContentBlocks,
  normalizeLessonContentBlocks,
} from '../../utils/reader/lessonContentBlocks.ts';
import {
  buildLessonAssetMap,
  buildLessonImageRefMap,
  buildSidebarGroups,
} from '../../utils/reader/workspaceReader.ts';
import { useReaderChrome } from '../reader/useReaderChrome.ts';
import { useReaderContext } from '../reader/useReaderContext.ts';
import { useTtsPlayer } from '../reader/useTtsPlayer.ts';
import { useTtsTextPicker } from '../reader/useTtsTextPicker.ts';

interface UseWorkspaceReaderStateArgs {
  projectId?: string | null;
  activeSection: LearningSection | null;
  activeSectionId: string | null;
  documentAssets: PdfDocumentAssets | null;
  learningPlan: LearningPlan | null;
  quiz: QuizQuestion[];
  onQuizStateChange: (sectionId: string, state: LessonQuizState) => void;
  sectionContent: string;
  syllabus: SyllabusItem[];
}

const areSettingsSectionsEqual = (
  currentSections: SettingsPanelSectionId[],
  nextSections: SettingsPanelSectionId[]
) =>
  currentSections.length === nextSections.length &&
  currentSections.every((sectionId, index) => sectionId === nextSections[index]);

export const useWorkspaceReaderState = ({
  projectId,
  activeSection,
  activeSectionId,
  documentAssets,
  learningPlan,
  onQuizStateChange,
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
  const effectiveQuiz = useMemo(() => {
    const blocks = normalizeLessonContentBlocks(activeSection?.contentBlocks);
    return blocks.length > 0 ? deriveQuizFromLessonContentBlocks(blocks) : quiz;
  }, [activeSection?.contentBlocks, quiz]);
  const quizAnswers = useMemo(
    () => effectiveQuiz.map((_, index) => activeSection?.quizState?.answers[index] ?? -1),
    [activeSection?.quizState, effectiveQuiz]
  );
  const isQuizSubmitted = activeSection?.quizState?.isSubmitted ?? false;
  const [settingsPanelExpandedSections, setSettingsPanelExpandedSections] = useState<
    SettingsPanelSectionId[]
  >(['course-notes']);
  const [lastAudioTab, setLastAudioTab] = useState<AudioPanelTab>('voce');

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
    scrollContainerRef,
    sectionAnnotations: activeSection?.annotations,
    sectionContent,
  });
  const ttsPlayer = useTtsPlayer({
    projectId,
    contentBlocks: activeSection?.contentBlocks,
    activeSectionId,
    sectionContent,
  });
  const ttsTextPicker = useTtsTextPicker({
    chunkTexts: ttsPlayer.chunkTexts,
    contentRef,
    onSelectChunk: ttsPlayer.handleSelectChunk,
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

  const handleSelectQuizAnswer = useCallback(
    (questionIndex: number, optionIndex: number) => {
      if (!activeSectionId || isQuizSubmitted || quizAnswers[questionIndex] !== -1) return;
      const question = effectiveQuiz[questionIndex];
      if (
        !question ||
        !Number.isInteger(optionIndex) ||
        optionIndex < 0 ||
        optionIndex >= question.options.length
      )
        return;
      const answers = [...quizAnswers];
      answers[questionIndex] = optionIndex;
      onQuizStateChange(activeSectionId, { answers, isSubmitted: false });
    },
    [activeSectionId, effectiveQuiz, isQuizSubmitted, onQuizStateChange, quizAnswers]
  );
  const setIsQuizSubmitted = useCallback(
    (isSubmitted: boolean) => {
      if (!activeSectionId || isSubmitted === isQuizSubmitted) return;
      onQuizStateChange(activeSectionId, { answers: quizAnswers, isSubmitted });
    },
    [activeSectionId, isQuizSubmitted, onQuizStateChange, quizAnswers]
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
    ttsTextPicker,
    uiPreferences,
  };
};
