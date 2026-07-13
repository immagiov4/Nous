const HEALTH_ENDPOINTS = [
  ['frontend', 'NOUS_SMOKE_FRONTEND_URL', false],
  ['backend', 'NOUS_SMOKE_BACKEND_URL', false],
  ['supabase-auth', 'NOUS_SMOKE_SUPABASE_AUTH_URL', true],
];

export const checkHealthEndpoints = async (env, request = fetch) => {
  const results = [];
  for (const [name, key, requiresSupabaseKey] of HEALTH_ENDPOINTS) {
    const url = env[key];
    if (!url) {
      throw new Error(`Missing ${key}.`);
    }
    const headers = requiresSupabaseKey
      ? {
          apikey: env.NOUS_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${env.NOUS_SUPABASE_ANON_KEY}`,
        }
      : undefined;
    if (requiresSupabaseKey && !env.NOUS_SUPABASE_ANON_KEY) {
      throw new Error('Missing NOUS_SUPABASE_ANON_KEY.');
    }
    const response = await request(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`${name} health check returned HTTP ${response.status}.`);
    }
    results.push(name);
  }
  return results;
};

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const results = await checkHealthEndpoints(process.env);
  process.stdout.write(`Healthy: ${results.join(', ')}\n`);
}
