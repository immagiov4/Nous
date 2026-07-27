import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';
import type { FeedbackDiagnosticsSnapshot } from './browserDiagnostics.ts';

export type FeedbackCategory = 'bug' | 'enhancement';

export interface FeedbackScreenshot {
  dataUrl: string;
}

export interface SubmitFeedbackInput {
  category: FeedbackCategory;
  description: string;
  diagnostics?: FeedbackDiagnosticsSnapshot;
  screenshot?: FeedbackScreenshot;
  title?: string;
}

export interface SubmittedFeedback {
  id: string;
  status: 'pending' | 'submitted';
}

export class FeedbackSubmissionError extends Error {
  constructor() {
    super('Invio della segnalazione non riuscito.');
    this.name = 'FeedbackSubmissionError';
  }
}

export const submitFeedback = async (input: SubmitFeedbackInput): Promise<SubmittedFeedback> => {
  let response: Response;
  try {
    response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new FeedbackSubmissionError();
  }

  if (!response.ok) throw new FeedbackSubmissionError();
  const body = (await response.json().catch(() => null)) as {
    feedback?: SubmittedFeedback;
    success?: boolean;
  } | null;
  if (!body?.success || !body.feedback) throw new FeedbackSubmissionError();
  return body.feedback;
};
