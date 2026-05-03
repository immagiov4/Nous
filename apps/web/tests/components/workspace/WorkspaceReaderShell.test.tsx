// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderShellProps } from '../../../components/workspace/shell/types.ts';
import WorkspaceReaderShell from '../../../components/workspace/WorkspaceReaderShell.tsx';

vi.mock('../../../components/workspace/AudioPlayer.tsx', () => ({
  default: (props: { currentVoice: string; isPlaying: boolean }) => (
    <div
      data-testid="audio-player"
      data-playing={String(props.isPlaying)}
      data-voice={props.currentVoice}
    />
  ),
}));

vi.mock('../../../components/workspace/shell/WorkspaceReaderBanners.tsx', () => ({
  default: () => <div data-testid="workspace-banners" />,
}));

vi.mock('../../../components/workspace/shell/WorkspaceReaderContent.tsx', () => ({
  default: () => <div data-testid="workspace-content" />,
}));

vi.mock('../../../components/workspace/shell/WorkspaceReaderHeader.tsx', () => ({
  default: () => <div data-testid="workspace-header" />,
}));

vi.mock('../../../components/workspace/shell/WorkspaceReaderOverlays.tsx', () => ({
  default: () => <div data-testid="workspace-overlays" />,
}));

vi.mock('../../../components/workspace/shell/WorkspaceReaderSidebar.tsx', () => ({
  default: () => <div data-testid="workspace-sidebar" />,
}));

const buildProps = (): WorkspaceReaderShellProps => {
  const scrollContainerRef = createRef<HTMLDivElement>();
  const scrollTo = vi.fn();
  scrollContainerRef.current = { scrollTo } as unknown as HTMLDivElement;

  return {
    banners: {
      needsSourceFile: false,
      onAttachSourceFile: vi.fn(),
      onBackToLibrary: vi.fn(),
      onExportProject: vi.fn(),
      pdfMappingWarning: null,
      storageError: null,
    },
    content: {
      activeLaboratoryExercise: null,
      activeSectionAssetsById: {},
      activeSectionImageRefsById: {},
      contentRef: createRef<HTMLDivElement>(),
      isDarkMode: false,
      isFocusMode: false,
      isLoading: false,
      isLaboratoryEvaluating: false,
      isLaboratoryGenerating: false,
      isLaboratoryView: false,
      isMobileViewport: false,
      isQuizSubmitted: false,
      laboratoryActivityMessage: undefined,
      laboratoryErrorMessage: undefined,
      laboratoryStatus: null,
      laboratorySummary: '',
      laboratoryTitle: 'Laboratorio',
      onAddLaboratoryTextAttachment: vi.fn(),
      onAttachLaboratoryFiles: vi.fn(),
      onCompleteSection: vi.fn(),
      onContentClick: vi.fn(),
      onContentContextMenu: vi.fn(),
      onContentPointerDownCapture: vi.fn(),
      onEvaluateActiveLaboratoryExercise: vi.fn(),
      onGenerateLaboratory: vi.fn(),
      onRemoveLaboratoryAttachment: vi.fn(),
      onSelectQuizAnswer: vi.fn(),
      onSetIsQuizSubmitted: vi.fn(),
      onUpdateLaboratoryAttachmentMetadata: vi.fn(),
      onUpdateLaboratoryTextAttachment: vi.fn(),
      quiz: [],
      quizAnswers: [],
      scrollContainerRef,
      sectionAnnotations: [],
      sectionContent: '# Lezione',
    },
    header: {
      activeLaboratoryExercise: null,
      activeSectionId: null,
      activeSectionTitle: null,
      activeSidebarGroup: null,
      hasActiveSection: false,
      courseGenerationNotes: '',
      isDarkMode: false,
      isFocusMode: false,
      isLoading: false,
      isLaboratoryView: false,
      isMobileSidebarOpen: false,
      isMobileViewport: false,
      isMusicPlaying: false,
      isSettingsOpen: false,
      syncState: 'saved',
      laboratoryTitle: 'Laboratorio',
      learningPlanTitle: 'Titolo',
      loadingStatus: '',
      modelDefaults: {
        assessmentModel: 'a',
        contextModel: 'c',
        lessonModel: 'l',
        ttsModel: 'openai/gpt-4o-mini-tts-2025-12-15',
        ttsVoice: 'coral',
      },
      musicUrl: '',
      musicVolume: 0.3,
      onBackToLibrary: vi.fn(),
      onOpenSidebar: vi.fn(),
      onRegenerateActiveLaboratoryExercise: vi.fn(),
      onRegenerateActiveSection: vi.fn(),
      onSetDarkMode: vi.fn(),
      onSetCourseGenerationNotes: vi.fn(),
      onSetFocusMode: vi.fn(),
      onSetIsMusicPlaying: vi.fn(),
      onSetMusicUrl: vi.fn(),
      onSetMusicVolume: vi.fn(),
      onSetPreferredOpenRouterModel: vi.fn(),
      onSetSettingsOpen: vi.fn(),
      onSetSettingsPanelExpandedSections: vi.fn(),
      preferredModels: {
        preferredAssessmentModel: '',
        preferredContextModel: '',
        preferredLessonModel: '',
        preferredTtsModel: 'openai/gpt-4o-mini-tts-2025-12-15',
        preferredTtsVoice: 'coral',
      },
      settingsPanelExpandedSections: ['course-notes'],
      tts: {
        availableVoices: [],
        currentTime: 0,
        currentVoice: 'coral' as const,
        duration: 0,
        isPlaying: false,
        isLoading: false,
        playbackRate: 1,
        sectionContent: '',
        ttsConnected: false,
        onPlayPause: vi.fn(),
        onSeek: vi.fn(),
        onSkipChunk: vi.fn(),
        onSpeedChange: vi.fn(),
        onVoiceChange: vi.fn(),
      },
    },
    overlays: {
      contextAnswer: null,
      contextAnswerPanelRef: createRef<HTMLDivElement>(),
      contextAnswerResizePreviewRef: createRef<HTMLDivElement>(),
      contextAnswerSize: { width: 320, height: 220 },
      contextMenu: {
        type: 'selection',
        placement: 'desktop-floating',
        selectedText: '',
        visible: false,
        contextBefore: '',
        contextAfter: '',
      },
      contextMenuRef: createRef<HTMLDivElement>(),
      handleContextAnswerResizeStart: vi.fn(),
      isContextLoading: false,
      isDarkMode: false,
      isMobileViewport: false,
      onAskContextQuestion: vi.fn(),
      onCloseContextAnswer: vi.fn(),
      onCloseContextMenu: vi.fn(),
      onCreateLesson: vi.fn(),
      onDeleteAnnotation: vi.fn(),
      onHighlight: vi.fn(),
      preferredModels: {
        preferredAssessmentModel: '',
        preferredContextModel: '',
        preferredLessonModel: '',
        preferredTtsModel: 'openai/gpt-4o-mini-tts-2025-12-15',
        preferredTtsVoice: 'coral',
      },
      onSaveConversationNote: vi.fn(),
      onUpdateConversationNote: vi.fn(),
      onSaveNote: vi.fn(),
    },
    shouldUseDesktopSidebar: true,
    sidebar: {
      activeLaboratoryExerciseId: null,
      activeSectionId: null,
      expandedModuleId: null,
      generatingSectionId: null,
      isLoading: false,
      isMobileViewport: false,
      laboratoryExercises: [],
      laboratoryStatus: null,
      laboratoryTitle: 'Laboratorio',
      learningPlanTitle: 'Titolo',
      onBackToLibrary: vi.fn(),
      onExportProject: vi.fn(),
      onGenerateLaboratory: vi.fn(),
      onModuleToggle: vi.fn(),
      onSelectLaboratoryExercise: vi.fn(),
      onSelectSection: vi.fn(),
      onSetFocusMode: vi.fn(),
      onSetIsMobileSidebarOpen: vi.fn(),
      shouldShowSidebar: true,
      sidebarGroups: [],
    },
  };
};

describe('WorkspaceReaderShell', () => {
  test('resets both window and content scroll positions on mount', () => {
    const props = buildProps();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    render(<WorkspaceReaderShell {...props} />);

    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(props.content.scrollContainerRef.current?.scrollTo).toHaveBeenCalledWith({
      behavior: 'auto',
      left: 0,
      top: 0,
    });
  });

  test('locks document scrolling while the reader shell is mounted', () => {
    const props = buildProps();

    document.documentElement.style.overflow = 'auto';
    document.body.style.overflow = 'auto';
    document.documentElement.style.overscrollBehavior = 'auto';
    document.body.style.overscrollBehavior = 'auto';

    const { unmount } = render(<WorkspaceReaderShell {...props} />);

    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.overscrollBehavior).toBe('none');
    expect(document.body.style.overscrollBehavior).toBe('none');

    unmount();

    expect(document.documentElement.style.overflow).toBe('auto');
    expect(document.body.style.overflow).toBe('auto');
    expect(document.documentElement.style.overscrollBehavior).toBe('auto');
    expect(document.body.style.overscrollBehavior).toBe('auto');
  });

  test('applies desktop sidebar spacing to the main reading column', () => {
    const props = buildProps();
    render(<WorkspaceReaderShell {...props} />);

    const shellColumn = screen.getByTestId('workspace-header').parentElement;

    expect(shellColumn).toHaveStyle({ marginLeft: '384px' });
    expect(screen.getByTestId('workspace-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-overlays')).toBeInTheDocument();
  });
});
