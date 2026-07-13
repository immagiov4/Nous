import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';

interface YouTubeResearchResponse {
  context?: unknown;
  success?: unknown;
}

export const getYouTubeResearchContext = async (
  query: string,
  language: string
): Promise<string> => {
  try {
    const response = await fetchWithSupabaseAuth(
      `${getBackendUrl()}/api/youtube/research-context`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language, query }),
      }
    );
    if (!response.ok) {
      return '';
    }

    const payload = (await response.json()) as YouTubeResearchResponse;
    return payload.success === true && typeof payload.context === 'string' ? payload.context : '';
  } catch (error) {
    console.warn('[Nous] YouTube research unavailable:', error);
    return '';
  }
};
