// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderOverlaysModel } from '../../../../components/workspace/shell/types.ts';
import { useReaderContext } from '../../../../hooks/reader/useReaderContext.ts';

vi.mock('../../../../components/workspace/shell/ContextAnswerPanel.tsx', () => ({
  default: () => <div data-testid="context-answer-panel" />,
}));

const { default: WorkspaceReaderOverlays } = await import(
  '../../../../components/workspace/shell/WorkspaceReaderOverlays.tsx'
);

const buildProps = (
  overrides: Partial<WorkspaceReaderOverlaysModel> = {}
): WorkspaceReaderOverlaysModel => ({
  contextAnswer: {
    id: 'context-1',
    initialQuestion: 'Spiega meglio',
    selectedText: 'G-buffer',
  },
  contextAnswerPanelRef: createRef<HTMLDivElement>(),
  contextAnswerResizePreviewRef: createRef<HTMLDivElement>(),
  contextAnswerSize: { width: 360, height: 280 },
  contextMenu: {
    placement: 'desktop-floating',
    selectedText: '',
    type: 'selection',
    visible: false,
  },
  contextMenuRef: createRef<HTMLDivElement>(),
  handleContextAnswerResizeStart: vi.fn(),
  isContextLoading: false,
  isDarkMode: false,
  isMobileViewport: false,
  libraryAssistantDataSource: {
    attachedContextRefs: [],
    folders: [],
    loadProjectsById: vi.fn(async () => []),
    projects: [],
    tree: {
      descendantProjectIdsByFolderId: {},
      folderById: {},
      placementByProjectId: {},
      rootNodes: [],
    },
  },
  lessonCreationBlockReason: null,
  currentLessonArtifactPayloads: [],
  onAskContextQuestion: vi.fn(),
  onAttachArtifactToAnnotation: vi.fn(),
  onCloseContextAnswer: vi.fn(),
  onCloseContextMenu: vi.fn(),
  onCreateLesson: vi.fn(),
  onDeleteAnnotation: vi.fn(),
  onDetachArtifactFromAnnotation: vi.fn(),
  onHighlight: vi.fn(),
  onOpenLibraryReference: vi.fn(),
  onSaveConversationNote: vi.fn().mockResolvedValue({ merged: false, saved: true }),
  onUpdateConversationNote: vi.fn().mockResolvedValue({ merged: false, saved: true }),
  onSaveNote: vi.fn(),
  ...overrides,
});

describe('WorkspaceReaderOverlays', () => {
  test('completes preparation through the real menu for initial and replacement selections', () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    const frameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.push(callback);
      return frames.length;
    });
    const highlight = vi.fn();
    const content = 'Alpha beta gamma delta';
    function Reader() {
      const contentRef = useRef<HTMLDivElement>(null);
      const reader = useReaderContext({
        activeSectionId: 'lesson',
        contentRef,
        isMobileViewport: false,
        sectionContent: content,
      });
      const select = (start: number, end: number) => {
        const text = contentRef.current?.firstChild;
        if (!text) throw new Error('Missing lesson text');
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, end);
        range.getBoundingClientRect = () => new DOMRect(32, 64, 48, 18);
        const selection = window.getSelection();
        if (!selection) throw new Error('Missing browser selection');
        selection.removeAllRanges();
        selection.addRange(range);
        reader.openContextMenuFromSelection(selection, 'desktop-floating');
      };
      return (
        <>
          <div ref={contentRef}>{content}</div>
          <button type="button" onClick={() => select(6, 10)}>
            Select beta
          </button>
          <button type="button" onClick={() => select(11, 16)}>
            Select gamma
          </button>
          <WorkspaceReaderOverlays
            {...buildProps({
              contextAnswer: null,
              contextMenu: reader.contextMenu,
              contextMenuMotionProgressOverride: 1,
              contextMenuRef: reader.contextMenuRef,
              onContextMenuEntranceComplete: reader.handleContextMenuEntranceComplete,
              onHighlight: () => highlight(reader.contextMenu),
            })}
          />
        </>
      );
    }
    const view = render(<Reader />);
    try {
      for (const [text, start] of [
        ['beta', 6],
        ['gamma', 11],
      ] as const) {
        fireEvent.click(screen.getByRole('button', { name: `Select ${text}` }));
        const button = screen.getByRole('button', { name: 'Evidenzia selezione' });
        expect(button).toBeDisabled();
        act(() => {
          while (frames.length) frames.shift()?.(0);
          vi.runOnlyPendingTimers();
        });
        expect(button).toBeEnabled();
        fireEvent.click(button);
        expect(highlight).toHaveBeenLastCalledWith(
          expect.objectContaining({
            selectedText: text,
            selectedTextStart: start,
            prepareContext: undefined,
          })
        );
      }
    } finally {
      view.unmount();
      window.getSelection()?.removeAllRanges();
      frameSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('closes the mobile follow-up when its dimmed backdrop is tapped', async () => {
    const user = userEvent.setup();
    const onCloseContextAnswer = vi.fn();

    render(
      <WorkspaceReaderOverlays {...buildProps({ isMobileViewport: true, onCloseContextAnswer })} />
    );

    const backdrop = screen.getByRole('button', { name: 'Chiudi follow-up dallo sfondo' });
    expect(backdrop).toHaveAttribute('data-context-answer-backdrop', 'true');
    expect(backdrop).toHaveClass('absolute', 'inset-0', 'z-40', 'bg-black/40');
    expect(backdrop).not.toHaveClass('fixed', 'backdrop-blur-[1px]');
    expect(screen.getByTestId('context-answer-panel')).toBeInTheDocument();

    fireEvent.click(backdrop);
    expect(onCloseContextAnswer).not.toHaveBeenCalled();

    await user.pointer({ keys: '[MouseLeft]', target: backdrop });

    expect(onCloseContextAnswer).toHaveBeenCalledTimes(1);
  });

  test('does not add the dismissible backdrop to the desktop follow-up', () => {
    render(<WorkspaceReaderOverlays {...buildProps()} />);

    expect(screen.queryByRole('button', { name: 'Chiudi follow-up dallo sfondo' })).toBeNull();
    expect(screen.getByTestId('context-answer-panel')).toBeInTheDocument();
  });
});
