// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import WorkspaceReaderSettingsPanel from '../../../../components/workspace/shell/WorkspaceReaderSettingsPanel.tsx';

vi.mock('../../../../components/shared/OpenRouterModelPanel.tsx', () => ({
  default: ({ className, actions }: { className?: string; actions?: ReactNode }) => (
    <div className={className} data-testid="model-panel">
      {actions}
    </div>
  ),
}));

describe('WorkspaceReaderSettingsPanel', () => {
  test('keeps the floating panel interactive inside the mobile header', () => {
    render(
      <WorkspaceReaderSettingsPanel
        canRegenerate
        onRegenerate={vi.fn()}
        expandedSections={[]}
        onClose={vi.fn()}
        onSectionToggle={vi.fn()}
      />
    );

    expect(screen.getByTestId('model-panel')).toHaveClass('pointer-events-auto');
  });

  test('asks for confirmation before regenerating the active lesson', async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    render(
      <WorkspaceReaderSettingsPanel
        canRegenerate
        onRegenerate={onRegenerate}
        expandedSections={[]}
        onClose={vi.fn()}
        onSectionToggle={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /^Rigenera$/i }));
    expect(onRegenerate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Sì, rigenera/i }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });
});
