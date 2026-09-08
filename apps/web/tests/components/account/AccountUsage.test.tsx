// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import AccountUsage from '../../../components/account/AccountUsage.tsx';

const { request, session } = vi.hoisted(() => ({ request: vi.fn(), session: vi.fn() }));
vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: request,
  readSupabaseSession: session,
}));
const unknownUsage = {
  recordedCalls: 1,
  tokens: null,
  missingTokenCalls: 1,
  reportedCostUsd: null,
  estimatedCostUsd: null,
  missingCostCalls: 1,
  firstRecordedAt: null,
  lastRecordedAt: null,
  ratesCheckedAt: null,
};

describe('recorded account consumption display', () => {
  beforeEach(() => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['it']);
    request.mockReset();
    session.mockReturnValue({ user: { id: 'account-a' } });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  test('keeps absent counters and prices visibly unavailable', async () => {
    request.mockResolvedValue(Response.json(unknownUsage));
    render(<AccountUsage />);
    expect(await screen.findByText('Token non disponibili')).toBeInTheDocument();
    expect(screen.getByText('Costo non disponibile')).toBeInTheDocument();
    expect(screen.queryByText(/0 token|\$0/)).toBeNull();
  });

  test('shows an empty account without requesting an estimate', async () => {
    request.mockResolvedValueOnce(
      Response.json({ ...unknownUsage, recordedCalls: 0, missingCostCalls: 0 })
    );
    render(<AccountUsage />);
    expect(await screen.findByText('Nessun consumo registrato')).toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
  });

  test('shows a stable failure when recorded usage cannot load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    request.mockRejectedValueOnce(new Error('offline'));
    render(<AccountUsage />);
    expect(await screen.findByText('Consumo non disponibile')).toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
  });
  test('marks abbreviated partial tokens and partial estimated cost', async () => {
    request.mockResolvedValue(
      Response.json({ ...unknownUsage, tokens: 1500, estimatedCostUsd: 0.02 })
    );
    render(<AccountUsage />);
    expect(await screen.findByText(/1.5K token parziali/)).toBeInTheDocument();
    expect(screen.getByText(/\(\$0.02 stima, parziale\)/)).toBeInTheDocument();
  });
  test('does not round a small positive recorded cost to zero', async () => {
    request.mockResolvedValue(
      Response.json({ ...unknownUsage, reportedCostUsd: 0.0000003, missingCostCalls: 0 })
    );
    render(<AccountUsage />);
    expect(await screen.findByText('($0.0000003)')).toBeInTheDocument();
  });

  test('shows recorded usage while pricing is pending, then replaces the summary without counting twice', async () => {
    let completeEstimate!: (response: Response) => void;
    const recorded = { ...unknownUsage, tokens: 1500, missingTokenCalls: 0, reportedCostUsd: 0.1 };
    request.mockResolvedValueOnce(Response.json(recorded)).mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          completeEstimate = resolve;
        })
    );
    const view = render(<AccountUsage />);
    expect(await screen.findByText('1.5K token')).toBeInTheDocument();
    expect(screen.getByText('($0.1, parziale)')).toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(call => call[2])).toEqual([
      { accountId: 'account-a' },
      { accountId: 'account-a' },
    ]);
    expect(request.mock.calls[1][0]).toMatch(/\/api\/account\/usage\?estimate=true$/);
    view.rerender(<AccountUsage />);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () =>
      completeEstimate(Response.json({ ...recorded, estimatedCostUsd: 0.02, missingCostCalls: 0 }))
    );
    expect(screen.getByText('($0.12 stima)')).toBeInTheDocument();
    expect(screen.getByText('1.5K token')).toBeInTheDocument();
  });

  test('keeps recorded costs when the optional estimate fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    request
      .mockResolvedValueOnce(Response.json({ ...unknownUsage, tokens: 120, reportedCostUsd: 0 }))
      .mockRejectedValueOnce(new Error('offline'));
    render(<AccountUsage />);
    expect(await screen.findByText('($0, parziale)')).toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Consumo non disponibile')).toBeNull();
  });

  test.each([
    'close',
    'switch account',
  ])('cancels pending estimates on %s and ignores late responses', async action => {
    let completeEstimate!: (response: Response) => void;
    request
      .mockResolvedValueOnce(Response.json({ ...unknownUsage, tokens: 120 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>(resolve => {
            completeEstimate = resolve;
          })
      );
    const view = render(<AccountUsage />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const signal = request.mock.calls[1][1].signal as AbortSignal;
    if (action === 'switch account') session.mockReturnValue({ user: { id: 'account-b' } });
    // AccountMenu closes and unmounts this view when the authenticated identity changes.
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () =>
      completeEstimate(Response.json({ ...unknownUsage, tokens: 9999, estimatedCostUsd: 20 }))
    );
    expect(screen.queryByText(/9.9K|\$20/)).toBeNull();
  });
});
