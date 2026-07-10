import { type NextFunction, type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  type GlobalModelConfigPatch,
  isReasoningEffort,
  loadPersistedGlobalModelConfig,
  patchAndPersistGlobalModelConfig,
} from '../config/modelConfig.js';
import { sendErrorResponse } from '../utils/httpResponses.js';
import { isRecord, readOptionalString } from '../utils/validation.js';

const ADMIN_REQUIRED_MESSAGE = 'Solo un amministratore puo eseguire questa operazione.';
const ADMIN_USER_CREATE_PATH = '/auth/v1/admin/users';

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

const getSupabaseAdminConfig = () => {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for admin actions.');
  }

  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ''),
    serviceRoleKey,
  };
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
    email,
    password,
    role: readAdminRole(body.role),
  };
};

const buildSupabaseAdminHeaders = (serviceRoleKey: string) => ({
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  'Content-Type': 'application/json',
});

const requestSupabaseAdmin = async ({
  body,
  method,
  path,
}: {
  body?: unknown;
  method: 'GET' | 'PATCH' | 'POST';
  path: string;
}) => {
  const { serviceRoleKey, supabaseUrl } = getSupabaseAdminConfig();
  const response = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: buildSupabaseAdminHeaders(serviceRoleKey),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    throw new Error(`Supabase admin request failed with status ${response.status}.`);
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
};

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
      assessmentModel: readOptionalString(req.body.assessmentModel),
      assessmentReasoningEffort: readReasoningEffortPatch(req.body.assessmentReasoningEffort),
      contextModel: readOptionalString(req.body.contextModel),
      contextReasoningEffort: readReasoningEffortPatch(req.body.contextReasoningEffort),
      lessonModel: readOptionalString(req.body.lessonModel),
      lessonReasoningEffort: readReasoningEffortPatch(req.body.lessonReasoningEffort),
      ttsModel: readOptionalString(req.body.ttsModel),
      ttsVoice: readOptionalString(req.body.ttsVoice),
    };

    res.json({
      success: true,
      config: await patchAndPersistGlobalModelConfig(patch),
    });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to update model config');
  }
});

router.get('/users', async (_req: Request, res: Response) => {
  try {
    const data = await requestSupabaseAdmin({
      method: 'GET',
      path: ADMIN_USER_CREATE_PATH,
    });

    res.json({
      success: true,
      users: data.users || [],
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
      path: ADMIN_USER_CREATE_PATH,
      body: {
        email: body.email,
        password: body.password,
        email_confirm: true,
        app_metadata: {
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

router.post('/users/:id/magic-link', async (req: Request, res: Response) => {
  try {
    const userId = encodeURIComponent(getRouteParam(req.params.id));
    const user = await requestSupabaseAdmin({
      method: 'GET',
      path: `${ADMIN_USER_CREATE_PATH}/${userId}`,
    });
    const email = readOptionalString(user.email);
    if (!email) {
      throw new Error('Supabase user email is required to generate a magic link.');
    }

    await requestSupabaseAdmin({
      method: 'POST',
      path: '/auth/v1/otp',
      body: {
        type: 'magiclink',
        email,
      },
    });

    res.json({
      success: true,
      sent: true,
    });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to generate Supabase magic link');
  }
});

router.patch('/users/:id', async (req: Request, res: Response) => {
  try {
    if (!isRecord(req.body)) {
      throw new Error('Corpo della richiesta non valido.');
    }

    const userId = encodeURIComponent(getRouteParam(req.params.id));
    const role = readOptionalString(req.body.role);
    const password = readOptionalString(req.body.password);
    const disabled = typeof req.body.disabled === 'boolean' ? req.body.disabled : undefined;
    const body = {
      ...(role ? { app_metadata: { role: readAdminRole(role) } } : {}),
      ...(password ? { password } : {}),
      ...(disabled === undefined ? {} : { ban_duration: disabled ? '876000h' : 'none' }),
    };

    const user = await requestSupabaseAdmin({
      method: 'PATCH',
      path: `${ADMIN_USER_CREATE_PATH}/${userId}`,
      body,
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
