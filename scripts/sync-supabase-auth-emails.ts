import { buildAuthTemplatePatch, loadAuthTemplates } from './supabaseAuthTemplates.ts';

const MANAGEMENT_API_BASE_URL = 'https://api.supabase.com/v1';

interface SyncOptions {
  apply: boolean;
}

const readRequiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
};

const parseOptions = (args: string[]): SyncOptions => ({
  apply: args.includes('--apply'),
});

const getAuthConfigUrl = (projectRef: string): string =>
  `${MANAGEMENT_API_BASE_URL}/projects/${projectRef}/config/auth`;

const fetchHostedAuthConfig = async ({
  accessToken,
  projectRef,
}: {
  accessToken: string;
  projectRef: string;
}): Promise<Record<string, unknown>> => {
  const response = await fetch(getAuthConfigUrl(projectRef), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase auth config read failed with status ${response.status}.`);
  }

  return (await response.json()) as Record<string, unknown>;
};

const patchHostedAuthConfig = async ({
  accessToken,
  patch,
  projectRef,
}: {
  accessToken: string;
  patch: Record<string, string>;
  projectRef: string;
}): Promise<void> => {
  const response = await fetch(getAuthConfigUrl(projectRef), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });

  if (!response.ok) {
    throw new Error(`Supabase auth template sync failed with status ${response.status}.`);
  }
};

const buildDiff = (
  hostedConfig: Record<string, unknown>,
  localPatch: Record<string, string>
): string[] =>
  Object.entries(localPatch)
    .filter(([key, value]) => hostedConfig[key] !== value)
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));

const main = async () => {
  const options = parseOptions(process.argv.slice(2));
  const accessToken = readRequiredEnv('SUPABASE_ACCESS_TOKEN');
  const projectRef = readRequiredEnv('SUPABASE_PROJECT_REF');
  const templates = await loadAuthTemplates();
  const patch = buildAuthTemplatePatch(templates) as Record<string, string>;
  const hostedConfig = await fetchHostedAuthConfig({ accessToken, projectRef });
  const changedKeys = buildDiff(hostedConfig, patch);

  if (changedKeys.length === 0) {
    console.log('Supabase auth templates are already in sync.');
    return;
  }

  console.log(`Supabase auth template drift (${changedKeys.length} keys):`);
  for (const key of changedKeys) {
    console.log(`- ${key}`);
  }

  if (!options.apply) {
    console.log('Dry run only. Re-run with --apply to update hosted Supabase.');
    return;
  }

  await patchHostedAuthConfig({ accessToken, patch, projectRef });
  console.log('Supabase auth templates synced.');
};

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
