// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../components/shared/StreamingMarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="streaming-markdown-renderer">{content}</div>
  ),
}));

const { default: ThinkingStream } = await import('../../../components/shared/ThinkingStream.tsx');

describe('ThinkingStream', () => {
  test('inserts paragraph breaks before glued chunk titles', () => {
    render(
      <ThinkingStream
        isDarkMode={false}
        text={
          'Spiego le relazioni principali.**Exploring growth terms**\nMi concentro sui casi base.'
        }
      />
    );

    expect(screen.getByTestId('streaming-markdown-renderer').textContent).toBe(
      'Spiego le relazioni principali.\n\n**Exploring growth terms**\nMi concentro sui casi base.'
    );
  });

  test('inserts paragraph breaks before glued markdown headings without regex backtracking tricks', () => {
    render(
      <ThinkingStream
        isDarkMode={false}
        text={'Prima frase utile ## Titolo operativo\nContenuto successivo.'}
      />
    );

    expect(screen.getByTestId('streaming-markdown-renderer').textContent).toBe(
      'Prima frase utile\n\n## Titolo operativo\nContenuto successivo.'
    );
  });

  test('restores literal whitespace tokens without unescaping escaped backslashes', () => {
    render(
      <ThinkingStream
        isDarkMode={false}
        text={'Prima riga\\nSeconda riga e \\\\n token letterale'}
      />
    );

    expect(screen.getByTestId('streaming-markdown-renderer').textContent).toBe(
      'Prima riga\nSeconda riga e \\\\n token letterale'
    );
  });

  test('runs a constant-velocity scroll loop while text is present', () => {
    const requestAnimationFrameMock = vi.fn(() => 1);
    const cancelAnimationFrameMock = vi.fn();

    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);

    const { container, unmount } = render(<ThinkingStream isDarkMode={false} text="Prima riga" />);

    const viewport = container.querySelector('.overflow-hidden') as HTMLDivElement | null;
    expect(viewport).not.toBeNull();
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);

    unmount();
    expect(cancelAnimationFrameMock).toHaveBeenCalled();
  });
});
