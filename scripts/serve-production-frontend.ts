import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface BunFile extends Blob {
  exists(): Promise<boolean>;
}

declare const Bun: {
  file(path: string): BunFile;
  serve(options: {
    fetch(request: Request): Promise<Response>;
    hostname: string;
    port: number;
  }): void;
};

type Environment = Record<string, string | undefined>;

const requireEnvironmentValue = (environment: Environment, key: string): string => {
  const value = environment[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
};

const normalizeHttpUrl = (value: string, key: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${key} must be an HTTP(S) URL.`);
  }
  return url.toString().replace(/\/$/, '');
};

export const buildRuntimeConfigScript = (environment: Environment): string => {
  const backendUrl = normalizeHttpUrl(
    requireEnvironmentValue(environment, 'NOUS_BACKEND_PUBLIC_URL'),
    'NOUS_BACKEND_PUBLIC_URL'
  );
  const runtimeConfig = {
    authMode: 'supabase',
    backendUrl,
    supabaseAnonKey: requireEnvironmentValue(environment, 'NOUS_SUPABASE_ANON_KEY'),
    supabaseUrl: normalizeHttpUrl(
      requireEnvironmentValue(environment, 'NOUS_SUPABASE_PUBLIC_URL'),
      'NOUS_SUPABASE_PUBLIC_URL'
    ),
  };

  return `globalThis.__NOUS_RUNTIME_CONFIG__ = Object.freeze(${JSON.stringify(runtimeConfig)});\nglobalThis.__NOUS_SERVER_CONFIG__ = Object.freeze({backendUrl: ${JSON.stringify(backendUrl)}});\n`;
};

export const resolveStaticFilePath = (
  publicDirectory: string,
  requestPath: string
): string | null => {
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(requestPath).replace(/^[/\\]+/, '') || 'index.html';
  } catch {
    return null;
  }

  const resolvedPublicDirectory = resolve(publicDirectory);
  const filePath = resolve(resolvedPublicDirectory, relativePath);
  return filePath === resolvedPublicDirectory ||
    filePath.startsWith(`${resolvedPublicDirectory}${sep}`)
    ? filePath
    : null;
};

export const getFrontendApiMisrouteResponse = (requestPath: string): Response | null => {
  if (requestPath !== '/api' && !requestPath.startsWith('/api/')) return null;

  return Response.json(
    {
      success: false,
      error: 'API requests must use the configured backend URL.',
    },
    {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
};

const startServer = (environment: Environment = process.env): void => {
  const publicDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'apps',
    'web',
    'dist'
  );
  const runtimeConfigScript = buildRuntimeConfigScript(environment);
  const parsedPort = Number.parseInt(environment.FRONTEND_PORT || '8080', 10);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
    throw new Error('FRONTEND_PORT must be a positive integer.');
  }

  Bun.serve({
    hostname: '0.0.0.0',
    port: parsedPort,
    fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' });
      }
      if (url.pathname === '/config.js') {
        return new Response(runtimeConfigScript, {
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'application/javascript; charset=utf-8',
          },
        });
      }

      const apiMisrouteResponse = getFrontendApiMisrouteResponse(url.pathname);
      if (apiMisrouteResponse) return apiMisrouteResponse;

      const filePath = resolveStaticFilePath(publicDirectory, url.pathname);
      if (filePath) {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          return new Response(file);
        }
      }

      const acceptsHtml = request.headers.get('accept')?.includes('text/html');
      return acceptsHtml
        ? new Response(Bun.file(resolve(publicDirectory, 'index.html')))
        : new Response('Not found', { status: 404 });
    },
  });
};

if (import.meta.main) {
  try {
    startServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Frontend startup failed.';
    process.stderr.write(`[frontend] ${message}\n`);
    process.exit(1);
  }
}
