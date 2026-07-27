import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));
vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'https://api.nous.test',
}));

const { FeedbackSubmissionError, submitFeedback } = await import(
  '../../../services/feedback/feedbackApi.ts'
);

describe('feedback API', () => {
  beforeEach(() => fetchWithSupabaseAuthMock.mockReset());

  test('sends the authenticated feedback contract and returns its persisted state', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, feedback: { id: 'feedback-123', status: 'submitted' } }),
        { status: 200 }
      )
    );

    await expect(
      submitFeedback({
        category: 'bug',
        description: 'Il pulsante non risponde.',
        diagnostics: { consoleEntries: [], pageUrl: 'https://nous.test/library' },
      })
    ).resolves.toEqual({ id: 'feedback-123', status: 'submitted' });

    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith('https://api.nous.test/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'bug',
        description: 'Il pulsante non risponde.',
        diagnostics: { consoleEntries: [], pageUrl: 'https://nous.test/library' },
      }),
    });
  });

  test('returns a stable error instead of exposing backend details', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'secret stack trace' }), { status: 500 })
    );

    await expect(
      submitFeedback({ category: 'enhancement', description: 'Vorrei un nuovo filtro.' })
    ).rejects.toBeInstanceOf(FeedbackSubmissionError);
  });
});
