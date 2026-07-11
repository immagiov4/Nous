interface SupabaseAdminUser {
  app_metadata?: Record<string, unknown>;
  email?: string;
  id: string;
}

type Environment = Record<string, string | undefined>;
type Fetch = typeof fetch;

const requireValue = (environment: Environment, key: string): string => {
  const value = environment[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
};

const readResponseError = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message || `Supabase Admin API returned ${response.status}.`;
};

export const bootstrapAdmin = async (
  environment: Environment = process.env,
  request: Fetch = fetch
): Promise<'created' | 'updated'> => {
  const supabaseUrl = requireValue(environment, 'SUPABASE_URL').replace(/\/$/, '');
  const serviceRoleKey = requireValue(environment, 'SUPABASE_SERVICE_ROLE_KEY');
  const email = requireValue(environment, 'ADMIN_EMAIL').toLowerCase();
  const password = requireValue(environment, 'ADMIN_PASSWORD');
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  const usersResponse = await request(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1000`, {
    headers,
  });
  if (!usersResponse.ok) {
    throw new Error(await readResponseError(usersResponse));
  }

  const users = ((await usersResponse.json()) as { users?: SupabaseAdminUser[] }).users || [];
  const existingUser = users.find(user => user.email?.toLowerCase() === email);
  const body = JSON.stringify({
    app_metadata: { ...existingUser?.app_metadata, role: 'admin' },
    email,
    email_confirm: true,
    password,
  });
  const response = existingUser
    ? await request(`${supabaseUrl}/auth/v1/admin/users/${existingUser.id}`, {
        body,
        headers,
        method: 'PUT',
      })
    : await request(`${supabaseUrl}/auth/v1/admin/users`, {
        body,
        headers,
        method: 'POST',
      });
  if (!response.ok) {
    throw new Error(await readResponseError(response));
  }

  return existingUser ? 'updated' : 'created';
};

if (import.meta.main) {
  try {
    const outcome = await bootstrapAdmin();
    process.stdout.write(`[setup] Admin account ${outcome}.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Admin bootstrap failed.';
    process.stderr.write(`[setup] ${message}\n`);
    process.exit(1);
  }
}
