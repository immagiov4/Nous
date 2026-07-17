import { type NextFunction, type Request, type Response, Router } from 'express';
import { getCurrentUser } from '../auth/currentUser.js';
import {
  buildYouTubeResearchBundle,
  buildYouTubeResearchDiagnostic,
  type YouTubeTranscriptOverride,
  YouTubeTranscriptOverrideProvider,
} from '../services/youtubeResearch.js';

const router = Router();
const MAX_QUERY_LENGTH = 500;
const MAX_CONTEXT_TOKEN_INPUT = 2_000_000;
const MAX_TRANSCRIPT_OVERRIDES = 30;
const MAX_TRANSCRIPT_SEGMENTS = 5_000;
const MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH = 2_000;
const MAX_TRANSCRIPT_TOTAL_CHARACTERS = 1_000_000;
const MAX_VIDEO_ID_LENGTH = 128;
const MAX_LANGUAGE_LENGTH = 32;
const MAX_TRANSCRIPT_TIMESTAMP_SECONDS = 7 * 24 * 60 * 60;
const MAX_TRANSCRIPT_SEGMENT_DURATION_SECONDS = 24 * 60 * 60;
const DEFAULT_TRANSCRIPT_SEGMENT_DURATION_SECONDS = 4;
const videoClipsEnabled = process.env.YOUTUBE_VIDEO_CLIPS_ENABLED === 'true';
const ADMIN_REQUIRED_MESSAGE = 'Solo un amministratore puo eseguire questa operazione.';

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

const readTranscriptOverrides = (value: unknown): YouTubeTranscriptOverride[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TRANSCRIPT_OVERRIDES) return null;

  let totalCharacters = 0;
  const videoIds = new Set<string>();
  const overrides: YouTubeTranscriptOverride[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;
    const videoId = typeof record.videoId === 'string' ? record.videoId.trim() : '';
    const language = typeof record.language === 'string' ? record.language.trim() : 'en';
    if (
      !videoId ||
      videoId.length > MAX_VIDEO_ID_LENGTH ||
      videoIds.has(videoId) ||
      !language ||
      language.length > MAX_LANGUAGE_LENGTH ||
      !Array.isArray(record.segments) ||
      record.segments.length === 0 ||
      record.segments.length > MAX_TRANSCRIPT_SEGMENTS
    ) {
      return null;
    }

    const rawSegments = record.segments as unknown[];
    const segments = rawSegments.map((segment, index) => {
      if (!segment || typeof segment !== 'object') return null;
      const segmentRecord = segment as Record<string, unknown>;
      const text = typeof segmentRecord.text === 'string' ? segmentRecord.text.trim() : '';
      const startSeconds = segmentRecord.startSeconds;
      const explicitDuration = segmentRecord.durationSeconds;
      const nextSegment = rawSegments[index + 1];
      const nextStart =
        nextSegment && typeof nextSegment === 'object'
          ? (nextSegment as Record<string, unknown>).startSeconds
          : undefined;
      if (
        !text ||
        text.length > MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH ||
        typeof startSeconds !== 'number' ||
        !Number.isFinite(startSeconds) ||
        startSeconds < 0 ||
        startSeconds > MAX_TRANSCRIPT_TIMESTAMP_SECONDS ||
        (explicitDuration !== undefined &&
          (typeof explicitDuration !== 'number' ||
            !Number.isFinite(explicitDuration) ||
            explicitDuration < 0 ||
            explicitDuration > MAX_TRANSCRIPT_SEGMENT_DURATION_SECONDS))
      ) {
        return null;
      }

      const derivedDuration =
        typeof nextStart === 'number' && Number.isFinite(nextStart) && nextStart > startSeconds
          ? nextStart - startSeconds
          : DEFAULT_TRANSCRIPT_SEGMENT_DURATION_SECONDS;
      totalCharacters += text.length;
      return {
        durationSeconds: typeof explicitDuration === 'number' ? explicitDuration : derivedDuration,
        startSeconds,
        text,
      };
    });
    if (segments.some(segment => !segment) || totalCharacters > MAX_TRANSCRIPT_TOTAL_CHARACTERS) {
      return null;
    }
    overrides.push({
      language,
      segments: segments as YouTubeTranscriptOverride['segments'],
      videoId,
    });
    videoIds.add(videoId);
  }

  return overrides;
};

router.get('/config', (_req, res) => res.json({ success: true, videoClipsEnabled }));

router.post('/research-context', async (req, res) => {
  const { language, query } = readResearchInput(req.body);
  const transcriptOverrides = readTranscriptOverrides(
    req.body && typeof req.body === 'object'
      ? (req.body as Record<string, unknown>).transcriptOverrides
      : undefined
  );
  if (!isValidQuery(query)) {
    return res.status(400).json({ success: false, error: 'Query YouTube non valida.' });
  }
  if (!transcriptOverrides) {
    return res.status(400).json({ success: false, error: 'Transcript importati non validi.' });
  }

  try {
    const research = await buildYouTubeResearchBundle(query, language, {
      ...(transcriptOverrides.length > 0 && {
        transcripts: new YouTubeTranscriptOverrideProvider(transcriptOverrides),
      }),
    });
    return res.json({
      success: true,
      context: research.context,
      videoClipsEnabled,
      videoCandidates: videoClipsEnabled ? research.videoCandidates : [],
    });
  } catch (error) {
    console.warn('[Backend] YouTube research unavailable:', error);
    return res.json({ success: true, context: '', videoClipsEnabled, videoCandidates: [] });
  }
});

router.post('/admin/research-lab', requireAdminUser, async (req, res) => {
  const { budget, language, query } = readResearchInput(req.body);
  const transcriptOverrides = readTranscriptOverrides(
    req.body && typeof req.body === 'object'
      ? (req.body as Record<string, unknown>).transcriptOverrides
      : undefined
  );
  if (!isValidQuery(query)) {
    return res.status(400).json({ success: false, error: 'Query YouTube non valida.' });
  }
  if (!transcriptOverrides) {
    return res.status(400).json({ success: false, error: 'Transcript importati non validi.' });
  }

  try {
    return res.json({
      success: true,
      diagnostic: await buildYouTubeResearchDiagnostic(query, language, {
        budget,
        ...(transcriptOverrides.length > 0 && {
          transcripts: new YouTubeTranscriptOverrideProvider(transcriptOverrides),
        }),
      }),
      productionVideoClipsEnabled: videoClipsEnabled,
    });
  } catch (error) {
    console.warn('[Backend] YouTube research lab unavailable:', error);
    return res.status(502).json({
      success: false,
      error: 'Ricerca YouTube non disponibile. Controlla i tool del backend e riprova.',
    });
  }
});

export default router;
