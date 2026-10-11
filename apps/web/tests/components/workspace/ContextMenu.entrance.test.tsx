// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import type { HTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import ContextMenu from '../../../components/workspace/ContextMenu.tsx';

const motion = vi.hoisted(() => ({ complete: () => {}, shouldAnimate: true }));

vi.mock('../../../utils/motion/useShouldAnimate.ts', () => ({
  useShouldAnimate: () => motion.shouldAnimate,
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({
      onAnimationComplete,
      initial: _initial,
      animate: _animate,
      transition: _transition,
      ...props
    }: HTMLAttributes<HTMLDivElement> & {
      onAnimationComplete: () => void;
      initial: unknown;
      animate: unknown;
      transition: unknown;
    }) => {
      motion.complete = onAnimationComplete;
      return <div {...props} />;
    },
    input: ({
      initial: _initial,
      animate: _animate,
      transition: _transition,
      ...props
    }: InputHTMLAttributes<HTMLInputElement> & {
      initial?: unknown;
      animate?: unknown;
      transition?: unknown;
    }) => <input {...props} />,
    textarea: ({
      initial: _initial,
      animate: _animate,
      transition: _transition,
      ...props
    }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
      initial?: unknown;
      animate?: unknown;
      transition?: unknown;
    }) => <textarea {...props} />,
  },
}));

const buildProps = () => ({
  isLoading: true,
  lessonCreationBlockReason: null,
  onAsk: vi.fn(),
  onClose: vi.fn(),
  onCreateLesson: vi.fn(),
  onDeleteAnnotation: vi.fn(),
  onEntranceComplete: vi.fn(),
  onHighlight: vi.fn(),
  onSaveNote: vi.fn(),
  placement: 'desktop-floating' as const,
  selectedText: 'Energy is conserved.',
  type: 'selection' as const,
});

beforeEach(() => {
  motion.shouldAnimate = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

test.each([
  'desktop-floating',
  'mobile-sheet',
] as const)('signals readiness after entrance and for new requests on the mounted %s menu', placement => {
  const props = { ...buildProps(), placement };
  const { rerender } = render(<ContextMenu {...props} />);
  expect(props.onEntranceComplete).not.toHaveBeenCalled();

  act(() => motion.complete());
  expect(props.onEntranceComplete).toHaveBeenCalledOnce();

  const nextEntranceComplete = vi.fn();
  rerender(
    <ContextMenu
      {...props}
      selectedText="A different selection"
      onEntranceComplete={nextEntranceComplete}
    />
  );
  expect(nextEntranceComplete).toHaveBeenCalledOnce();
  act(() => motion.complete());
  expect(nextEntranceComplete).toHaveBeenCalledOnce();
});

test('signals readiness when reduced motion disables entrance', () => {
  motion.shouldAnimate = false;
  const props = buildProps();
  render(<ContextMenu {...props} />);
  expect(props.onEntranceComplete).toHaveBeenCalledOnce();
});

test('signals readiness for a deterministic preview without an animation callback', () => {
  const props = buildProps();
  render(<ContextMenu {...props} motionProgressOverride={1} />);
  expect(props.onEntranceComplete).toHaveBeenCalledOnce();
});
