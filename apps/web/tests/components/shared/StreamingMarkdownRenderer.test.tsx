// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../components/shared/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

const { default: StreamingMarkdownRenderer } = await import(
  '../../../components/shared/StreamingMarkdownRenderer.tsx'
);

describe('StreamingMarkdownRenderer', () => {
  test('keeps rendering markdown while batching intermediate streaming updates', () => {
    vi.useFakeTimers();

    const { rerender } = render(<StreamingMarkdownRenderer content="Ciao" isStreaming />);

    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('Ciao');

    rerender(<StreamingMarkdownRenderer content="Ciao mondo" isStreaming />);
    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('Ciao');

    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('Ciao mondo');

    vi.useRealTimers();
  });

  test('flushes the final markdown immediately when streaming completes', () => {
    vi.useFakeTimers();

    const { rerender } = render(<StreamingMarkdownRenderer content="Bozza" isStreaming />);

    rerender(<StreamingMarkdownRenderer content="Bozza finale" isStreaming />);
    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('Bozza');

    rerender(<StreamingMarkdownRenderer content="Bozza finale" isStreaming={false} />);
    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('Bozza finale');

    vi.useRealTimers();
  });
});
