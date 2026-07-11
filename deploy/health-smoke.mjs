const HEALTH_ENDPOINTS = [
  ['frontend', 'NOUS_SMOKE_FRONTEND_URL'],
  ['backend', 'NOUS_SMOKE_BACKEND_URL'],
  ['supabase-auth', 'NOUS_SMOKE_SUPABASE_AUTH_URL'],
];

export const checkHealthEndpoints = async (env, request = fetch) => {
  const results = [];
  for (const [name, key] of HEALTH_ENDPOINTS) {
    const url = env[key];
    if (!url) {
      throw new Error(`Missing ${key}.`);
    }
    const response = await request(url, { signal: AbortSignal.timeout(10_000) });
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
