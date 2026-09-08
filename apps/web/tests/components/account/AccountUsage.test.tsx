// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import AccountUsage from '../../../components/account/AccountUsage.tsx';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../../services/auth/supabaseAuth.ts', () => ({ fetchWithSupabaseAuth: request }));
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
});
