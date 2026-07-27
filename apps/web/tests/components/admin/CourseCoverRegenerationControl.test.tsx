// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import CourseCoverRegenerationControl from '../../../components/admin/CourseCoverRegenerationControl.tsx';
import { setRenderingLocaleOverride } from '../../../i18n/uiMessages.ts';
import {
  loadCourseCoverRegenerationStatus,
  startCourseCoverRegeneration,
} from '../../../services/admin/adminApi.ts';

vi.mock('../../../services/admin/adminApi.ts', () => ({
  loadCourseCoverRegenerationStatus: vi.fn(),
  startCourseCoverRegeneration: vi.fn(),
}));

const runningJob = {
  id: 'course-cover-p2-job',
  promptVersion: 2,
  results: [],
  startedAt: '2026-07-17T00:00:00.000Z',
  status: 'running' as const,
  summary: { failed: 0, pending: 1, regenerated: 0, skipped: 0, total: 1 },
  updatedAt: '2026-07-17T00:00:00.000Z',
};

describe('CourseCoverRegenerationControl', () => {
  beforeEach(() => {
    setRenderingLocaleOverride('it');
    vi.mocked(loadCourseCoverRegenerationStatus).mockReset();
    vi.mocked(startCourseCoverRegeneration).mockReset();
    vi.mocked(loadCourseCoverRegenerationStatus).mockResolvedValue(null);
  });

  afterEach(() => {
    setRenderingLocaleOverride(null);
    vi.useRealTimers();
  });

  test('checks status on return without starting a job', async () => {
    const user = userEvent.setup();
    vi.mocked(startCourseCoverRegeneration).mockResolvedValue(runningJob);
    render(<CourseCoverRegenerationControl />);

    expect(await screen.findByText('Nessuna rigenerazione cover avviata.')).toBeInTheDocument();
    expect(loadCourseCoverRegenerationStatus).toHaveBeenCalledTimes(1);
    expect(startCourseCoverRegeneration).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Rigenera cover' }));
    await waitFor(() => expect(startCourseCoverRegeneration).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Rigenerazione in corso' })).toBeDisabled();
  });

  test('polls status-only while a job is running', async () => {
    vi.useFakeTimers();
    vi.mocked(loadCourseCoverRegenerationStatus)
      .mockResolvedValueOnce(runningJob)
      .mockResolvedValueOnce({
        ...runningJob,
        completedAt: '2026-07-17T00:01:00.000Z',
        status: 'completed',
        summary: { failed: 0, pending: 0, regenerated: 1, skipped: 0, total: 1 },
      });

    render(<CourseCoverRegenerationControl />);
    await act(async () => undefined);
    expect(screen.getByRole('button', { name: 'Rigenerazione in corso' })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(loadCourseCoverRegenerationStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByText('1 cover rigenerate, 0 saltate e 0 non riuscite.')).toBeInTheDocument();
    expect(startCourseCoverRegeneration).not.toHaveBeenCalled();
  });
});
