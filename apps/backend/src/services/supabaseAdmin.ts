// Calls Supabase Auth Admin endpoints using server-only service-role credentials.
export const SUPABASE_ADMIN_USERS_PATH = '/auth/v1/admin/users';

export class SupabaseAdminRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string
  ) {
    super(`Supabase admin request failed with status ${status}.`);
  }
}

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

const readErrorCode = (text: string): string | undefined => {
  try {
    const body = JSON.parse(text) as { code?: unknown; error_code?: unknown };
    if (typeof body.error_code === 'string') {
      return body.error_code;
    }
    return typeof body.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
};

export const requestSupabaseAdmin = async ({
  body,
  method,
  path,
}: {
  body?: unknown;
  method: 'DELETE' | 'GET' | 'POST' | 'PUT';
  path: string;
}): Promise<Record<string, unknown>> => {
  const { serviceRoleKey, supabaseUrl } = getSupabaseAdminConfig();
  const response = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new SupabaseAdminRequestError(response.status, readErrorCode(text));
  }

  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
};
