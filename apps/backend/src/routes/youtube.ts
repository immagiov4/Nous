import { type NextFunction, type Request, type Response, Router } from 'express';
import { getCurrentUser } from '../auth/currentUser.js';
import {
  ApifyProviderError,
  buildYouTubeResearchDiagnostic,
  buildYouTubeResearchOutcome,
  isYouTubeResearchConfigured,
} from '../services/youtubeResearch.js';

const router = Router();
const MAX_QUERY_LENGTH = 500;
const MAX_CONTEXT_TOKEN_INPUT = 2_000_000;
const areVideoClipsEnabled = isYouTubeResearchConfigured;
const ADMIN_REQUIRED_MESSAGE = 'Solo un amministratore puo eseguire questa operazione.';

const researchFailure = (error: unknown) => ({
  ...(error instanceof ApifyProviderError ? { code: error.code } : {}),
  error:
    error instanceof ApifyProviderError && error.code === 'youtube_provider_allowance_exhausted'
      ? 'Ricerca YouTube non disponibile: il credito del servizio è esaurito.'
      : 'Ricerca YouTube non disponibile. Riprova tra poco.',
});

const requireAdminUser = (req: Request, res: Response, next: NextFunction): void => {
  if (getCurrentUser(req).role === 'admin') {
    next();
    return;
  }

  res.status(403).json({ success: false, error: ADMIN_REQUIRED_MESSAGE });
};

const readTokenBudgetValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_CONTEXT_TOKEN_INPUT, Math.floor(value))
    : undefined;

const readResearchInput = (body: unknown) => {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return {
    budget: {
      contextWindowTokens: readTokenBudgetValue(record.contextWindowTokens),
      nonYouTubePromptTokens: readTokenBudgetValue(record.nonYouTubePromptTokens),
      reservedOutputTokens: readTokenBudgetValue(record.reservedOutputTokens),
    },
    language: typeof record.language === 'string' ? record.language.trim() : 'Italiano',
    query: typeof record.query === 'string' ? record.query.trim() : '',
  };
};

const isValidQuery = (query: string): boolean => Boolean(query && query.length <= MAX_QUERY_LENGTH);

const researchDisconnectSignal = (res: Response): AbortSignal => {
  const controller = new AbortController();
  if (res.destroyed) controller.abort();
  else {
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
  }
  return controller.signal;
};

router.get('/config', (_req, res) =>
  res.json({ success: true, videoClipsEnabled: areVideoClipsEnabled() })
);

router.post('/research-context', async (req, res) => {
  const { language, query } = readResearchInput(req.body);
  if (!isValidQuery(query)) {
    return res.status(400).json({ success: false, error: 'Query YouTube non valida.' });
  }

  const signal = researchDisconnectSignal(res);
  try {
    const research = await buildYouTubeResearchOutcome(query, language, { signal });
    if (signal.aborted) return;
    const videoClipsEnabled = areVideoClipsEnabled();
    // Model context and clip candidates are both derived from the authoritative timed segments.
    return res.json({
      success: true,
      context: research.context,
      discoveredVideoCount: research.discoveredVideoCount,
      rationale: research.rationale,
      videoClipsEnabled,
      videoCandidates: videoClipsEnabled ? research.videoCandidates : [],
    });
  } catch (error) {
    if (signal.aborted) return;
    console.warn('[Backend] YouTube research unavailable:', error);
    return res.status(502).json({
      success: false,
      ...researchFailure(error),
    });
  }
});

router.post('/admin/research-lab', requireAdminUser, async (req, res) => {
  const { budget, language, query } = readResearchInput(req.body);
  if (!isValidQuery(query)) {
    return res.status(400).json({ success: false, error: 'Query YouTube non valida.' });
  }

  const signal = researchDisconnectSignal(res);
  try {
    const videoClipsEnabled = areVideoClipsEnabled();
    const diagnostic = await buildYouTubeResearchDiagnostic(query, language, { budget, signal });
    if (signal.aborted) return;
    return res.json({
      success: true,
      diagnostic,
      productionVideoClipsEnabled: videoClipsEnabled,
    });
  } catch (error) {
    if (signal.aborted) return;
    console.warn('[Backend] YouTube research lab unavailable:', error);
    return res.status(502).json({
      success: false,
      ...researchFailure(error),
    });
  }
});

export default router;
