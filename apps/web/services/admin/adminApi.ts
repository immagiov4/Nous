import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';

export type AdminReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';
export type AdminAiProvider = 'codex' | 'openai' | 'openrouter';

export interface AdminUser {
  banned_until?: string | null;
  email?: string;
  id: string;
  app_metadata?: {
    ai_provider?: AdminAiProvider;
    password_setup_required?: boolean;
    role?: string;
  };
}

export interface AdminUserCreateInput {
  aiProvider?: AdminAiProvider;
  email: string;
  password: string;
  role: 'admin' | 'user';
}

export interface AdminUserPatch {
  aiProvider?: AdminAiProvider | null;
  disabled?: boolean;
  password?: string;
  role?: 'admin' | 'user';
}

export interface AdminUserPage {
  hasMore: boolean;
  page: number;
  pageSize: number;
  users: AdminUser[];
}

export type AdminAccessEmailDelivery = 'access' | 'invitation' | 'setup';

export type AdminFeedbackStatus = 'failed' | 'pending' | 'processing' | 'submitted';

export interface AdminFeedbackConsoleEntry {
  level: 'debug' | 'error' | 'info' | 'warn';
  message: string;
  timestamp?: string;
}

export interface AdminFeedbackDiagnostics {
  appVersion?: string;
  consoleEntries?: AdminFeedbackConsoleEntry[];
  correlationIds?: string[];
  pageUrl?: string;
  requestId?: string;
  userAgent?: string;
}

export interface AdminFeedbackReport {
  attemptCount: number;
  category: 'bug' | 'enhancement' | 'other';
  createdAt: string;
  description: string;
  diagnostics: AdminFeedbackDiagnostics;
  githubIssueNumber?: number;
  githubIssueState?: 'closed' | 'missing' | 'open';
  githubIssueUrl?: string;
  githubLabels: string[];
  hasScreenshot: boolean;
  id: string;
  reporterEmail?: string;
  source: 'app' | 'github';
  status: AdminFeedbackStatus;
  title?: string;
  updatedAt: string;
  userId?: string;
}

export interface AdminFeedbackPage {
  page: number;
  pageSize: number;
  reports: AdminFeedbackReport[];
  total: number;
}

export interface AdminFeedbackSyncResult {
  issueCount: number;
  synchronizedAt: string;
}

export type CourseCoverRegenerationResultStatus = 'failed' | 'regenerated' | 'skipped';

export interface CourseCoverRegenerationJob {
  completedAt?: string;
  error?: string;
  id: string;
  promptVersion: number;
  results: Array<{
    coverName?: string;
    message?: string;
    projectId: string;
    status: CourseCoverRegenerationResultStatus;
    title: string;
  }>;
  startedAt: string;
  status: 'completed' | 'failed' | 'running';
  summary: {
    failed: number;
    pending: number;
    regenerated: number;
    skipped: number;
    total: number;
  };
  updatedAt: string;
}

export type AdminYouTubeResearchDecision =
  | 'context-included'
  | 'no-transcript'
  | 'playlist-expanded'
  | 'playlist-expansion-failed'
  | 'transcript-budget'
  | 'transcript-not-requested';

export interface AdminYouTubeResearchCandidate {
  channelTitle: string;
  channelVerified: boolean;
  decision: AdminYouTubeResearchDecision;
  durationSeconds?: number;
  estimatedTokens?: number;
  id: string;
  kind: 'playlist' | 'video';
  origins: Array<'playlist' | 'search'>;
  playlistId?: string;
  playlistPosition?: number;
  includedTokens?: number;
  title: string;
  transcript?: {
    characterCount: number;
    kind: 'automatic' | 'manual' | 'translated';
    language: string;
    ranges: Array<{ endSeconds: number; startSeconds: number }>;
    segmentCount: number;
    text: string;
  };
  transcriptAttempts: AdminYouTubeTranscriptAttempt[];
  transcriptCached?: boolean;
  transcriptLookupMs?: number;
  url: string;
  viewCount?: number;
}

export interface AdminYouTubeTranscriptAttempt {
  durationMs: number;
  kind: 'automatic' | 'manual' | 'translated';
  language: string;
  outcome: 'available' | 'empty' | 'unavailable';
}

export interface AdminYouTubeResearchLabResult {
  diagnostic: {
    budget: {
      contextWindowTokens: number;
      nonYouTubePromptTokens: number;
      perTranscriptMaxTokens: number;
      remainingTokens: number;
      reservedOutputTokens: number;
      residualTokens: number;
      transcriptBudgetTokens: number;
      usedTokens: number;
    };
    bundle: {
      context: string;
      videoCandidates: Array<{
        ranges: Array<{ endSeconds: number; startSeconds: number }>;
        title: string;
        transcript: string;
        url: string;
      }>;
    };
    candidates: AdminYouTubeResearchCandidate[];
    errors: Array<'playlist-expansion-failed'>;
    limits: {
      discoveryVideos: number;
      playlistResults: number;
      transcriptConcurrency: number;
    };
    operations: {
      discoveryRequests: number;
      playlistPreviewsExpanded: number;
      transcriptRequests: number;
      transcriptLookups: number;
    };
    preferredLanguages: string[];
    query: string;
    timings: {
      discoveryMs: number;
      playlistExpansionMs: number;
      totalMs: number;
      transcriptsMs: number;
    };
  };
  productionVideoClipsEnabled: boolean;
}

export interface AdminModelConfig {
  aiProvider: AdminAiProvider;
  artifactModel: string;
  artifactInteractiveModel: string;
  artifactInteractiveReasoningEffort: AdminReasoningEffort;
  artifactReasoningEffort: AdminReasoningEffort;
  artifactVisualReviewMaxRounds: number;
  artifactVisualReviewEnabled: boolean;
  assessmentModel: string;
  assessmentReasoningEffort: AdminReasoningEffort;
  codexAssessmentModel: string;
  codexArtifactModel: string;
  codexArtifactInteractiveModel: string;
  codexContextModel: string;
  codexDraftingModel: string;
  codexFastModelSlots: Array<
    | 'artifact'
    | 'artifactInteractive'
    | 'assessment'
    | 'context'
    | 'drafting'
    | 'lesson'
    | 'progress'
    | 'research'
    | 'structure'
    | 'verification'
  >;
  codexLessonModel: string;
  codexProgressModel: string;
  codexResearchModel: string;
  codexStructureModel: string;
  codexVerificationModel: string;
  contextModel: string;
  contextReasoningEffort: AdminReasoningEffort;
  draftingReasoningEffort: AdminReasoningEffort;
  imageModel: string;
  lessonModel: string;
  lessonReasoningEffort: AdminReasoningEffort;
  openAiAssessmentModel: string;
  openAiArtifactModel: string;
  openAiArtifactInteractiveModel: string;
  openAiContextModel: string;
  openAiImageModel: string;
  openAiLessonModel: string;
  openAiProgressModel: string;
  openAiResearchModel: string;
  progressModel: string;
  progressReasoningEffort: AdminReasoningEffort;
  researchModel: string;
  structureReasoningEffort: AdminReasoningEffort;
  ttsModel: string;
  ttsVoice: string;
  updatedAt: string;
  verificationReasoningEffort: AdminReasoningEffort;
}

export type AdminModelConfigPatch = Partial<
  Pick<
    AdminModelConfig,
    | 'aiProvider'
    | 'artifactModel'
    | 'artifactInteractiveModel'
    | 'artifactInteractiveReasoningEffort'
    | 'artifactReasoningEffort'
    | 'artifactVisualReviewMaxRounds'
    | 'artifactVisualReviewEnabled'
    | 'assessmentModel'
    | 'assessmentReasoningEffort'
    | 'codexAssessmentModel'
    | 'codexArtifactModel'
    | 'codexArtifactInteractiveModel'
    | 'codexContextModel'
    | 'codexDraftingModel'
    | 'codexFastModelSlots'
    | 'codexLessonModel'
    | 'codexProgressModel'
    | 'codexResearchModel'
    | 'codexStructureModel'
    | 'codexVerificationModel'
    | 'contextModel'
    | 'contextReasoningEffort'
    | 'draftingReasoningEffort'
    | 'imageModel'
    | 'lessonModel'
    | 'lessonReasoningEffort'
    | 'openAiAssessmentModel'
    | 'openAiArtifactModel'
    | 'openAiArtifactInteractiveModel'
    | 'openAiContextModel'
    | 'openAiImageModel'
    | 'openAiLessonModel'
    | 'openAiProgressModel'
    | 'openAiResearchModel'
    | 'progressModel'
    | 'progressReasoningEffort'
    | 'researchModel'
    | 'structureReasoningEffort'
    | 'ttsModel'
    | 'ttsVoice'
    | 'verificationReasoningEffort'
  >
>;

export const DEFAULT_ADMIN_MODEL_CONFIG: AdminModelConfig = {
  aiProvider: 'openrouter',
  artifactModel: 'deepseek/deepseek-v4-pro',
  artifactInteractiveModel: 'openai/gpt-5.6-terra',
  artifactInteractiveReasoningEffort: 'low',
  artifactReasoningEffort: 'none',
  artifactVisualReviewMaxRounds: 1,
  artifactVisualReviewEnabled: true,
  assessmentModel: 'google/gemini-3.1-flash-lite',
  assessmentReasoningEffort: 'medium',
  codexAssessmentModel: 'gpt-5.6-luna',
  codexArtifactModel: 'gpt-5.6-sol',
  codexArtifactInteractiveModel: 'gpt-5.6-sol',
  codexContextModel: 'gpt-5.6-luna',
  codexDraftingModel: 'gpt-5.6-luna',
  codexFastModelSlots: ['artifact', 'artifactInteractive', 'drafting', 'structure'],
  codexLessonModel: 'gpt-5.6-terra',
  codexProgressModel: 'gpt-5.6-luna',
  codexResearchModel: 'gpt-5.6-terra',
  codexStructureModel: 'gpt-5.6-luna',
  codexVerificationModel: 'gpt-5.6-terra',
  contextModel: 'google/gemini-3.1-flash-lite',
  contextReasoningEffort: 'medium',
  draftingReasoningEffort: 'high',
  imageModel: 'google/gemini-3.1-flash-lite-image',
  lessonModel: 'openai/gpt-5.6-luna',
  lessonReasoningEffort: 'high',
  openAiAssessmentModel: 'gpt-5.6-luna',
  openAiArtifactModel: 'gpt-5.6-terra',
  openAiArtifactInteractiveModel: 'gpt-5.6-terra',
  openAiContextModel: 'gpt-5.6-luna',
  openAiImageModel: 'gpt-image-2',
  openAiLessonModel: 'gpt-5.6-terra',
  openAiProgressModel: 'gpt-5.6-luna',
  openAiResearchModel: 'gpt-5.6-terra',
  progressModel: 'google/gemini-3.1-flash-lite',
  progressReasoningEffort: 'low',
  researchModel: 'perplexity/sonar-pro-search',
  structureReasoningEffort: 'medium',
  ttsModel: 'x-ai/grok-voice-tts-1.0',
  ttsVoice: 'Ara',
  updatedAt: '',
  verificationReasoningEffort: 'high',
};

const readConfigValue = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const ADMIN_REASONING_EFFORTS = new Set<AdminReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
]);
const ADMIN_AI_PROVIDERS = new Set<AdminAiProvider>(['codex', 'openai', 'openrouter']);

const readAiProvider = (value: unknown): AdminAiProvider =>
  typeof value === 'string' && ADMIN_AI_PROVIDERS.has(value as AdminAiProvider)
    ? (value as AdminAiProvider)
    : DEFAULT_ADMIN_MODEL_CONFIG.aiProvider;

const readReasoningEffort = (
  value: unknown,
  fallback: AdminReasoningEffort
): AdminReasoningEffort =>
  typeof value === 'string' && ADMIN_REASONING_EFFORTS.has(value as AdminReasoningEffort)
    ? (value as AdminReasoningEffort)
    : fallback;

const normalizeAdminModelConfig = (
  config: Partial<AdminModelConfig> | null | undefined
): AdminModelConfig => ({
  aiProvider: readAiProvider(config?.aiProvider),
  artifactModel: readConfigValue(config?.artifactModel, DEFAULT_ADMIN_MODEL_CONFIG.artifactModel),
  artifactInteractiveModel: readConfigValue(
    config?.artifactInteractiveModel,
    DEFAULT_ADMIN_MODEL_CONFIG.artifactInteractiveModel
  ),
  artifactInteractiveReasoningEffort: readReasoningEffort(
    config?.artifactInteractiveReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.artifactInteractiveReasoningEffort
  ),
  artifactReasoningEffort: readReasoningEffort(
    config?.artifactReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.artifactReasoningEffort
  ),
  artifactVisualReviewEnabled:
    typeof config?.artifactVisualReviewEnabled === 'boolean'
      ? config.artifactVisualReviewEnabled
      : DEFAULT_ADMIN_MODEL_CONFIG.artifactVisualReviewEnabled,
  artifactVisualReviewMaxRounds:
    Number.isInteger(config?.artifactVisualReviewMaxRounds) &&
    Number(config?.artifactVisualReviewMaxRounds) >= 1 &&
    Number(config?.artifactVisualReviewMaxRounds) <= 4
      ? Number(config?.artifactVisualReviewMaxRounds)
      : DEFAULT_ADMIN_MODEL_CONFIG.artifactVisualReviewMaxRounds,
  assessmentModel: readConfigValue(
    config?.assessmentModel,
    DEFAULT_ADMIN_MODEL_CONFIG.assessmentModel
  ),
  assessmentReasoningEffort: readReasoningEffort(
    config?.assessmentReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.assessmentReasoningEffort
  ),
  codexAssessmentModel: readConfigValue(
    config?.codexAssessmentModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexAssessmentModel
  ),
  codexArtifactModel: readConfigValue(
    config?.codexArtifactModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexArtifactModel
  ),
  codexArtifactInteractiveModel: readConfigValue(
    config?.codexArtifactInteractiveModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexArtifactInteractiveModel
  ),
  codexContextModel: readConfigValue(
    config?.codexContextModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexContextModel
  ),
  codexDraftingModel: readConfigValue(
    config?.codexDraftingModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexDraftingModel
  ),
  codexFastModelSlots: Array.isArray(config?.codexFastModelSlots)
    ? config.codexFastModelSlots
    : DEFAULT_ADMIN_MODEL_CONFIG.codexFastModelSlots,
  codexLessonModel: readConfigValue(
    config?.codexLessonModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexLessonModel
  ),
  codexProgressModel: readConfigValue(
    config?.codexProgressModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexProgressModel
  ),
  codexResearchModel: readConfigValue(
    config?.codexResearchModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexResearchModel
  ),
  codexStructureModel: readConfigValue(
    config?.codexStructureModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexStructureModel
  ),
  codexVerificationModel: readConfigValue(
    config?.codexVerificationModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexVerificationModel
  ),
  contextModel: readConfigValue(config?.contextModel, DEFAULT_ADMIN_MODEL_CONFIG.contextModel),
  contextReasoningEffort: readReasoningEffort(
    config?.contextReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.contextReasoningEffort
  ),
  draftingReasoningEffort: readReasoningEffort(
    config?.draftingReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.draftingReasoningEffort
  ),
  imageModel: readConfigValue(config?.imageModel, DEFAULT_ADMIN_MODEL_CONFIG.imageModel),
  lessonModel: readConfigValue(config?.lessonModel, DEFAULT_ADMIN_MODEL_CONFIG.lessonModel),
  lessonReasoningEffort: readReasoningEffort(
    config?.lessonReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.lessonReasoningEffort
  ),
  openAiAssessmentModel: readConfigValue(
    config?.openAiAssessmentModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiAssessmentModel
  ),
  openAiArtifactModel: readConfigValue(
    config?.openAiArtifactModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiArtifactModel
  ),
  openAiArtifactInteractiveModel: readConfigValue(
    config?.openAiArtifactInteractiveModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiArtifactInteractiveModel
  ),
  openAiContextModel: readConfigValue(
    config?.openAiContextModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiContextModel
  ),
  openAiImageModel: readConfigValue(
    config?.openAiImageModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiImageModel
  ),
  openAiLessonModel: readConfigValue(
    config?.openAiLessonModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiLessonModel
  ),
  openAiProgressModel: readConfigValue(
    config?.openAiProgressModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiProgressModel
  ),
  openAiResearchModel: readConfigValue(
    config?.openAiResearchModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiResearchModel
  ),
  progressModel: readConfigValue(config?.progressModel, DEFAULT_ADMIN_MODEL_CONFIG.progressModel),
  progressReasoningEffort: readReasoningEffort(
    config?.progressReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.progressReasoningEffort
  ),
  researchModel: readConfigValue(config?.researchModel, DEFAULT_ADMIN_MODEL_CONFIG.researchModel),
  structureReasoningEffort: readReasoningEffort(
    config?.structureReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.structureReasoningEffort
  ),
  ttsModel: readConfigValue(config?.ttsModel, DEFAULT_ADMIN_MODEL_CONFIG.ttsModel),
  ttsVoice: readConfigValue(config?.ttsVoice, DEFAULT_ADMIN_MODEL_CONFIG.ttsVoice),
  updatedAt: readConfigValue(config?.updatedAt, DEFAULT_ADMIN_MODEL_CONFIG.updatedAt),
  verificationReasoningEffort: readReasoningEffort(
    config?.verificationReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.verificationReasoningEffort
  ),
});

const readAdminResponse = async <T>(response: Response): Promise<T> => {
  const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(data.error || response.statusText || 'Richiesta admin non riuscita.');
  }

  return data;
};

const requestAdmin = async <T>(path: string, init: RequestInit = {}): Promise<T> =>
  readAdminResponse<T>(
    await fetchWithSupabaseAuth(`${getBackendUrl()}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  );

export const listAdminUsers = async (page = 1, pageSize = 8): Promise<AdminUserPage> =>
  requestAdmin<AdminUserPage>(
    `/api/admin/users?page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(pageSize)}`
  );

export const listAdminFeedback = async (
  page: number,
  pageSize: number
): Promise<AdminFeedbackPage> =>
  requestAdmin<AdminFeedbackPage>(
    `/api/feedback/admin?page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(pageSize)}`
  );

export const loadAdminFeedbackScreenshot = async (feedbackId: string): Promise<Blob> => {
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/feedback/admin/${encodeURIComponent(feedbackId)}/screenshot`
  );
  if (!response.ok) throw new Error('Screenshot non disponibile.');
  return response.blob();
};

export const retryAdminFeedback = async (feedbackId: string): Promise<void> => {
  await requestAdmin(`/api/feedback/admin/${encodeURIComponent(feedbackId)}/retry`, {
    method: 'POST',
  });
};

export const syncAdminFeedback = async (): Promise<AdminFeedbackSyncResult> =>
  requestAdmin<AdminFeedbackSyncResult>('/api/feedback/admin/sync', { method: 'POST' });

export const loadCourseCoverRegenerationStatus =
  async (): Promise<CourseCoverRegenerationJob | null> => {
    const response = await requestAdmin<{ job: CourseCoverRegenerationJob | null }>(
      '/api/projects/covers/regenerate/status'
    );
    return response.job;
  };

export const startCourseCoverRegeneration = async (): Promise<CourseCoverRegenerationJob> => {
  const response = await requestAdmin<{ job: CourseCoverRegenerationJob }>(
    '/api/projects/covers/regenerate'
  );
  return response.job;
};

export const runAdminYouTubeResearchLab = async (input: {
  contextWindowTokens: number;
  language: string;
  nonYouTubePromptTokens: number;
  query: string;
  reservedOutputTokens: number;
}): Promise<AdminYouTubeResearchLabResult> =>
  requestAdmin<AdminYouTubeResearchLabResult>('/api/youtube/admin/research-lab', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const createAdminUser = async (input: AdminUserCreateInput): Promise<AdminUser> => {
  const response = await requestAdmin<{ user: AdminUser }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.user;
};

export const sendAdminMagicLink = async (userId: string): Promise<AdminAccessEmailDelivery> => {
  const response = await requestAdmin<{ delivery: AdminAccessEmailDelivery }>(
    `/api/admin/users/${encodeURIComponent(userId)}/magic-link`,
    { method: 'POST' }
  );
  return response.delivery;
};

export const sendAdminAccessEmail = async (email: string): Promise<AdminAccessEmailDelivery> => {
  const response = await requestAdmin<{ delivery: AdminAccessEmailDelivery }>(
    '/api/admin/users/access-email',
    {
      method: 'POST',
      body: JSON.stringify({ email }),
    }
  );
  return response.delivery;
};

export const updateAdminUser = async (
  userId: string,
  patch: AdminUserPatch
): Promise<AdminUser> => {
  const response = await requestAdmin<{ user: AdminUser }>(
    `/api/admin/users/${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }
  );
  return response.user;
};

export const getAdminModelConfig = async (): Promise<AdminModelConfig> => {
  const response = await requestAdmin<{ config: AdminModelConfig }>('/api/admin/model-config');
  return normalizeAdminModelConfig(response.config);
};

export const patchAdminModelConfig = async (
  patch: AdminModelConfigPatch
): Promise<AdminModelConfig> => {
  const response = await requestAdmin<{ config: AdminModelConfig }>('/api/admin/model-config', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return normalizeAdminModelConfig(response.config);
};
