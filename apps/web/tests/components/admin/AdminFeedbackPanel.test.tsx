// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import AdminFeedbackPanel from '../../../components/admin/AdminFeedbackPanel.tsx';
import {
  listAdminFeedback,
  loadAdminFeedbackScreenshot,
  retryAdminFeedback,
  syncAdminFeedback,
} from '../../../services/admin/adminApi.ts';

vi.mock('../../../services/admin/adminApi.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/admin/adminApi.ts')>();
  return {
    ...actual,
    listAdminFeedback: vi.fn(),
    loadAdminFeedbackScreenshot: vi.fn(),
    retryAdminFeedback: vi.fn(),
    syncAdminFeedback: vi.fn(),
  };
});

const createReport = (id: string, status: 'failed' | 'pending', hasScreenshot = false) => ({
  attemptCount: status === 'failed' ? 2 : 0,
  category: 'bug' as const,
  createdAt: '2026-07-16T10:00:00.000Z',
  description: `${id} report`,
  diagnostics: {},
  githubLabels: [],
  hasScreenshot,
  id,
  source: 'app' as const,
  status,
  updatedAt: '2026-07-16T10:00:00.000Z',
});

describe('AdminFeedbackPanel', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      return window.setTimeout(() => callback(0), 0);
    });
    vi.mocked(loadAdminFeedbackScreenshot).mockResolvedValue(new Blob(['image']));
    vi.mocked(retryAdminFeedback).mockResolvedValue();
    vi.mocked(syncAdminFeedback).mockResolvedValue({
      issueCount: 2,
      synchronizedAt: '2026-07-16T12:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('moves focus to the selected mobile detail and exposes retry only for failed reports', async () => {
    const user = userEvent.setup();
    vi.mocked(listAdminFeedback).mockResolvedValue({
      page: 1,
      pageSize: 10,
      reports: [createReport('pending', 'pending'), createReport('failed', 'failed')],
      total: 2,
    });
    render(<AdminFeedbackPanel />);

    expect(await screen.findByRole('button', { name: /pending report/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Riprova pubblicazione' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /failed report/ }));

    await waitFor(() => expect(screen.getByRole('article')).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(screen.getByRole('button', { name: 'Riprova pubblicazione' })).toBeEnabled();
  });

  test('revokes the screenshot object URL when the selected detail unmounts', async () => {
    const createObjectUrl = vi.fn(() => 'blob:feedback-screenshot');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    vi.mocked(listAdminFeedback).mockResolvedValue({
      page: 1,
      pageSize: 10,
      reports: [createReport('screenshot', 'pending', true)],
      total: 1,
    });

    const view = render(<AdminFeedbackPanel />);
    expect(await screen.findByAltText('Screenshot della segnalazione')).toHaveAttribute(
      'src',
      'blob:feedback-screenshot'
    );

    view.unmount();

    await waitFor(() => expect(revokeObjectUrl).toHaveBeenCalledWith('blob:feedback-screenshot'));
  });

  test('synchronizes GitHub and reloads the first report page', async () => {
    const user = userEvent.setup();
    vi.mocked(listAdminFeedback).mockResolvedValue({
      page: 1,
      pageSize: 10,
      reports: [
        {
          ...createReport('github', 'pending'),
          githubIssueState: 'closed',
          githubLabels: ['documentation'],
        },
      ],
      total: 1,
    });
    render(<AdminFeedbackPanel />);

    await screen.findByRole('button', { name: /github report/ });
    await user.click(screen.getByRole('button', { name: 'Sincronizza GitHub' }));

    await waitFor(() => expect(syncAdminFeedback).toHaveBeenCalledTimes(1));
    expect(listAdminFeedback).toHaveBeenLastCalledWith(1, 10);
    expect(await screen.findByText(/2 issue sincronizzate da GitHub/)).toBeInTheDocument();
    expect(screen.getAllByText('Chiusa su GitHub').length).toBeGreaterThan(0);
    expect(screen.getByText('documentation')).toBeInTheDocument();
  });
});
