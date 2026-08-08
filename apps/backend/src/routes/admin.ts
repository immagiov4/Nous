import { type NextFunction, type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  type GlobalModelConfigPatch,
  isAiProvider,
  isReasoningEffort,
  isTextModelSlot,
  loadPersistedGlobalModelConfig,
  patchAndPersistGlobalModelConfig,
  readModelProviderOverrides,
} from '../config/modelConfig.js';
import { imageClient } from '../services/imageClient.js';
import { requestSupabaseAdmin, SUPABASE_ADMIN_USERS_PATH } from '../services/supabaseAdmin.js';
import { sendErrorResponse } from '../utils/httpResponses.js';
import { isRecord, readOptionalString } from '../utils/validation.js';

const ADMIN_REQUIRED_MESSAGE = 'Solo un amministratore puo eseguire questa operazione.';
const ADMIN_ACCESS_EMAIL_FAILED_MESSAGE = "Invio dell'email di accesso non riuscito.";
const ADMIN_MAGIC_LINK_FAILED_MESSAGE = 'Invio del link di accesso non riuscito.';
const ADMIN_USER_LIST_PAGE_SIZE = 1000;
const DEFAULT_ADMIN_USER_PAGE_SIZE = 8;
const MAX_ADMIN_USER_PAGE_SIZE = 100;

const router = Router();

const requireAdminUser = (req: Request, res: Response, next: NextFunction): void => {
  if (getCurrentUser(req).role === 'admin') {
    next();
    return;
  }

  res.status(403).json({
    success: false,
    error: ADMIN_REQUIRED_MESSAGE,
  });
};

const readAdminRole = (value: unknown): 'admin' | 'user' => (value === 'admin' ? 'admin' : 'user');

const readCreateUserBody = (body: unknown) => {
  if (!isRecord(body)) {
    throw new Error('Corpo della richiesta non valido.');
  }

  const email = readOptionalString(body.email)?.toLowerCase();
  const password = readOptionalString(body.password);
  if (!email || !password) {
    throw new Error('Email e password sono obbligatorie.');
  }

  return {
    aiProvider: readAiProviderPatch(body.aiProvider),
    aiProviderOverrides: readModelProviderOverrides(body.aiProviderOverrides),
    email,
    password,
    role: readAdminRole(body.role),
  };
};

const readAccessEmailBody = (body: unknown): string => {
  if (!isRecord(body)) {
    throw new Error('Corpo della richiesta non valido.');
  }

  const email = readOptionalString(body.email)?.toLowerCase();
  if (!email) {
    throw new Error('Email obbligatoria.');
  }
  return email;
};

const readAdminUserPatch = (body: Record<string, unknown>) => {
  const role = readOptionalString(body.role);
  const hasAiProviderPatch = Object.hasOwn(body, 'aiProvider');
  const hasAiProviderOverridesPatch = Object.hasOwn(body, 'aiProviderOverrides');
  const aiProvider = body.aiProvider === null ? null : readAiProviderPatch(body.aiProvider);
  if (hasAiProviderPatch && body.aiProvider !== null && !aiProvider) {
    throw new Error('Provider AI non valido.');
  }

  const password = readOptionalString(body.password);
  const disabled = typeof body.disabled === 'boolean' ? body.disabled : undefined;
  const hasMetadataPatch =
    Boolean(role) || hasAiProviderPatch || hasAiProviderOverridesPatch || Boolean(password);
  return {
    ...(hasMetadataPatch
      ? {
          app_metadata: {
            ...(hasAiProviderPatch ? { ai_provider: aiProvider } : {}),
            ...(hasAiProviderOverridesPatch
              ? { ai_provider_overrides: readModelProviderOverrides(body.aiProviderOverrides) }
              : {}),
            ...(role ? { role: readAdminRole(role) } : {}),
            ...(password ? { password_setup_required: null } : {}),
          },
        }
      : {}),
    ...(password ? { password } : {}),
    ...(disabled === undefined ? {} : { ban_duration: disabled ? '876000h' : 'none' }),
  };
};

const readSupabaseUsers = (data: Record<string, unknown>): Array<Record<string, unknown>> =>
  Array.isArray(data.users) ? data.users.filter(isRecord) : [];

const readPositiveInteger = (value: unknown, fallback: number, maximum?: number): number => {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return maximum ? Math.min(parsed, maximum) : parsed;
};

const findSupabaseUserByEmail = async (email: string): Promise<Record<string, unknown> | null> => {
  let page = 1;

  while (true) {
    const data = await requestSupabaseAdmin({
      method: 'GET',
      path: `${SUPABASE_ADMIN_USERS_PATH}?page=${page}&per_page=${ADMIN_USER_LIST_PAGE_SIZE}`,
    });
    const users = readSupabaseUsers(data);
    const matchingUser = users.find(
      user => readOptionalString(user.email)?.toLowerCase() === email
    );
    if (matchingUser) {
      return matchingUser;
    }
    if (users.length < ADMIN_USER_LIST_PAGE_SIZE) {
      return null;
    }
    page += 1;
  }
};

const sendSupabaseMagicLink = (email: string) =>
  requestSupabaseAdmin({
    method: 'POST',
    path: '/auth/v1/otp',
    body: {
      create_user: false,
      email,
      type: 'magiclink',
    },
  });

const sendSupabaseRecoveryLink = (email: string) =>
  requestSupabaseAdmin({
    method: 'POST',
    path: '/auth/v1/recover',
    body: { email },
  });

const requiresPasswordSetup = (user: Record<string, unknown>): boolean =>
  isRecord(user.app_metadata) && user.app_metadata.password_setup_required === true;

const getRouteParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] || '' : value || '';

const readReasoningEffortPatch = (value: unknown) => {
  const effort = readOptionalString(value);
  if (!effort) {
    return undefined;
  }
  if (!isReasoningEffort(effort)) {
    throw new Error('Forza di ragionamento non valida.');
  }
  return effort;
};

const readAiProviderPatch = (value: unknown) => {
  const provider = readOptionalString(value);
  if (!provider) {
    return undefined;
  }
  if (!isAiProvider(provider)) {
    throw new Error('Provider AI non valido.');
  }
  return provider;
};

router.use(requireAdminUser);

router.get('/model-config', async (_req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      config: await loadPersistedGlobalModelConfig(),
    });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to read model config');
  }
});

router.patch('/model-config', async (req: Request, res: Response) => {
  try {
    if (!isRecord(req.body)) {
      throw new Error('Corpo della richiesta non valido.');
    }

    const patch: GlobalModelConfigPatch = {
      aiProvider: readAiProviderPatch(req.body.aiProvider),
      aiProviderOverrides: Object.hasOwn(req.body, 'aiProviderOverrides')
        ? readModelProviderOverrides(req.body.aiProviderOverrides)
        : undefined,
      artifactModel: readOptionalString(req.body.artifactModel),
      artifactInteractiveModel: readOptionalString(req.body.artifactInteractiveModel),
      artifactInteractiveReasoningEffort: readReasoningEffortPatch(
        req.body.artifactInteractiveReasoningEffort
      ),
      artifactReasoningEffort: readReasoningEffortPatch(req.body.artifactReasoningEffort),
      artifactVisualReviewEnabled:
        typeof req.body.artifactVisualReviewEnabled === 'boolean'
          ? req.body.artifactVisualReviewEnabled
          : undefined,
      artifactVisualReviewMaxRounds:
        typeof req.body.artifactVisualReviewMaxRounds === 'number'
          ? req.body.artifactVisualReviewMaxRounds
          : undefined,
      assessmentModel: readOptionalString(req.body.assessmentModel),
      assessmentReasoningEffort: readReasoningEffortPatch(req.body.assessmentReasoningEffort),
      codexAssessmentModel: readOptionalString(req.body.codexAssessmentModel),
      codexArtifactModel: readOptionalString(req.body.codexArtifactModel),
      codexArtifactInteractiveModel: readOptionalString(req.body.codexArtifactInteractiveModel),
      codexContextModel: readOptionalString(req.body.codexContextModel),
      codexCourseModel: readOptionalString(req.body.codexCourseModel),
      codexFastModelSlots: Array.isArray(req.body.codexFastModelSlots)
        ? req.body.codexFastModelSlots.filter(isTextModelSlot)
        : undefined,
      codexLessonModel: readOptionalString(req.body.codexLessonModel),
      codexProgressModel: readOptionalString(req.body.codexProgressModel),
      codexResearchModel: readOptionalString(req.body.codexResearchModel),
      contextModel: readOptionalString(req.body.contextModel),
      contextReasoningEffort: readReasoningEffortPatch(req.body.contextReasoningEffort),
      courseModel: readOptionalString(req.body.courseModel),
      courseReasoningEffort: readReasoningEffortPatch(req.body.courseReasoningEffort),
      imageModel: readOptionalString(req.body.imageModel),
      lessonModel: readOptionalString(req.body.lessonModel),
      lessonReasoningEffort: readReasoningEffortPatch(req.body.lessonReasoningEffort),
      openAiAssessmentModel: readOptionalString(req.body.openAiAssessmentModel),
      openAiArtifactModel: readOptionalString(req.body.openAiArtifactModel),
      openAiArtifactInteractiveModel: readOptionalString(req.body.openAiArtifactInteractiveModel),
      openAiContextModel: readOptionalString(req.body.openAiContextModel),
      openAiCourseModel: readOptionalString(req.body.openAiCourseModel),
      openAiImageModel: readOptionalString(req.body.openAiImageModel),
      openAiLessonModel: readOptionalString(req.body.openAiLessonModel),
      openAiProgressModel: readOptionalString(req.body.openAiProgressModel),
      openAiResearchModel: readOptionalString(req.body.openAiResearchModel),
      progressModel: readOptionalString(req.body.progressModel),
      progressReasoningEffort: readReasoningEffortPatch(req.body.progressReasoningEffort),
      researchModel: readOptionalString(req.body.researchModel),
      researchReasoningEffort: readReasoningEffortPatch(req.body.researchReasoningEffort),
      ttsModel: readOptionalString(req.body.ttsModel),
      ttsVoice: readOptionalString(req.body.ttsVoice),
    };

    if (patch.imageModel) {
      await imageClient.assertModelSupportsImage(patch.imageModel);
    }
    if (patch.openAiImageModel) {
      imageClient.assertOpenAiModelSupportsImage(patch.openAiImageModel);
    }

    res.json({
      success: true,
      config: await patchAndPersistGlobalModelConfig(patch),
    });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to update model config');
  }
});

router.get('/users', async (req: Request, res: Response) => {
  const page = readPositiveInteger(req.query.page, 1);
  const pageSize = readPositiveInteger(
    req.query.pageSize,
    DEFAULT_ADMIN_USER_PAGE_SIZE,
    MAX_ADMIN_USER_PAGE_SIZE
  );
  try {
    const data = await requestSupabaseAdmin({
      method: 'GET',
      path: `${SUPABASE_ADMIN_USERS_PATH}?page=${page}&per_page=${pageSize}`,
    });
    const users = readSupabaseUsers(data);

    res.json({
      success: true,
      hasMore: users.length === pageSize,
      page,
      pageSize,
      users,
    });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to list Supabase users');
  }
});

router.post('/users', async (req: Request, res: Response) => {
  try {
    const body = readCreateUserBody(req.body);
    const user = await requestSupabaseAdmin({
      method: 'POST',
      path: SUPABASE_ADMIN_USERS_PATH,
      body: {
        email: body.email,
        password: body.password,
        email_confirm: true,
        app_metadata: {
          ...(body.aiProvider ? { ai_provider: body.aiProvider } : {}),
          ...(Object.keys(body.aiProviderOverrides).length > 0
            ? { ai_provider_overrides: body.aiProviderOverrides }
            : {}),
          role: body.role,
        },
      },
    });

    res.status(201).json({
      success: true,
      user,
    });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to create Supabase user');
  }
});

router.post('/users/access-email', async (req: Request, res: Response) => {
  try {
    const email = readAccessEmailBody(req.body);
    const existingUser = await findSupabaseUserByEmail(email);

    if (existingUser) {
      const passwordSetupRequired = requiresPasswordSetup(existingUser);
      await (passwordSetupRequired
        ? sendSupabaseRecoveryLink(email)
        : sendSupabaseMagicLink(email));
      res.json({ success: true, delivery: passwordSetupRequired ? 'setup' : 'access' });
      return;
    }

    const invitedUser = await requestSupabaseAdmin({
      method: 'POST',
      path: SUPABASE_ADMIN_USERS_PATH,
      body: {
        email,
        email_confirm: true,
        app_metadata: { password_setup_required: true },
      },
    });
    const invitedUserId = readOptionalString(invitedUser.id);
    if (!invitedUserId) {
      throw new Error('Supabase invite did not return a user identifier.');
    }
    try {
      await sendSupabaseMagicLink(email);
    } catch (error) {
      try {
        await requestSupabaseAdmin({
          method: 'DELETE',
          path: `${SUPABASE_ADMIN_USERS_PATH}/${encodeURIComponent(invitedUserId)}`,
        });
      } catch (rollbackError) {
        console.error(
          '[Nous][Admin] Failed to roll back an undelivered invited user.',
          rollbackError
        );
      }
      throw error;
    }
    res.json({ success: true, delivery: 'invitation' });
  } catch (error) {
    console.error('[Nous][Admin] Failed to send a Supabase access email.', error);
    res.status(502).json({
      success: false,
      error: ADMIN_ACCESS_EMAIL_FAILED_MESSAGE,
    });
  }
});

router.post('/users/:id/magic-link', async (req: Request, res: Response) => {
  try {
    const userId = encodeURIComponent(getRouteParam(req.params.id));
    const user = await requestSupabaseAdmin({
      method: 'GET',
      path: `${SUPABASE_ADMIN_USERS_PATH}/${userId}`,
    });
    const email = readOptionalString(user.email);
    if (!email) {
      throw new Error('Supabase user email is required to generate a magic link.');
    }

    const passwordSetupRequired = requiresPasswordSetup(user);
    await (passwordSetupRequired ? sendSupabaseRecoveryLink(email) : sendSupabaseMagicLink(email));

    res.json({
      success: true,
      delivery: passwordSetupRequired ? 'setup' : 'access',
      sent: true,
    });
  } catch (error) {
    console.error('[Nous][Admin] Failed to send a Supabase magic link.', error);
    res.status(502).json({
      success: false,
      error: ADMIN_MAGIC_LINK_FAILED_MESSAGE,
    });
  }
});

router.patch('/users/:id', async (req: Request, res: Response) => {
  try {
    if (!isRecord(req.body)) {
      throw new Error('Corpo della richiesta non valido.');
    }

    const user = await requestSupabaseAdmin({
      method: 'PUT',
      path: `${SUPABASE_ADMIN_USERS_PATH}/${encodeURIComponent(getRouteParam(req.params.id))}`,
      body: readAdminUserPatch(req.body),
    });

    res.json({
      success: true,
      user,
    });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to update Supabase user');
  }
});

export default router;
