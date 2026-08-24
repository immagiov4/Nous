// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import WorkspaceReaderSettingsPanel from '../../../../components/workspace/shell/WorkspaceReaderSettingsPanel.tsx';

vi.mock('../../../../components/shared/OpenRouterModelPanel.tsx', () => ({
  default: ({ className }: { className?: string }) => (
    <div className={className} data-testid="model-panel" />
  ),
}));

describe('WorkspaceReaderSettingsPanel', () => {
  test('keeps the floating panel interactive inside the mobile header', () => {
    render(
      <WorkspaceReaderSettingsPanel
        expandedSections={[]}
        onClose={vi.fn()}
        onSectionToggle={vi.fn()}
      />
    );

    expect(screen.getByTestId('model-panel')).toHaveClass('pointer-events-auto');
  });
});
