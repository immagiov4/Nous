// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderOverlaysModel } from '../../../../components/workspace/shell/types.ts';

vi.mock('../../../../components/workspace/shell/ContextAnswerPanel.tsx', () => ({
  default: () => <div data-testid="context-answer-panel" />,
}));

vi.mock('../../../../components/workspace/ContextMenu.tsx', () => ({
  default: () => <div data-testid="context-menu" />,
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
  onSaveConversationNote: vi.fn().mockResolvedValue({ merged: false, saved: true }),
  onUpdateConversationNote: vi.fn().mockResolvedValue({ merged: false, saved: true }),
  onSaveNote: vi.fn(),
  ...overrides,
});

describe('WorkspaceReaderOverlays', () => {
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

    await user.click(backdrop);

    expect(onCloseContextAnswer).toHaveBeenCalledTimes(1);
  });

  test('does not add the dismissible backdrop to the desktop follow-up', () => {
    render(<WorkspaceReaderOverlays {...buildProps()} />);

    expect(screen.queryByRole('button', { name: 'Chiudi follow-up dallo sfondo' })).toBeNull();
    expect(screen.getByTestId('context-answer-panel')).toBeInTheDocument();
  });
});
