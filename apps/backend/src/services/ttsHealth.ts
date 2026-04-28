import { buildTTSServerUrl } from '../config/serverConfig.js';
import type { ServerConfig } from '../types/index.js';
import { getErrorMessage } from '../utils/errors.js';

export interface ServiceHealthResult {
  message: string;
  ok: boolean;
}

async function checkEndpoint(
  serverUrl: string,
  path: string,
  successMessage: string,
  failurePrefix: string
): Promise<ServiceHealthResult> {
  try {
    const response = await fetch(`${serverUrl}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      return { ok: true, message: successMessage };
    }

    return {
      ok: false,
      message: `${failurePrefix}: ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Connection failed: ${getErrorMessage(error, 'Unknown error')}`,
    };
  }
}

export async function checkTtsHealth(
  config: Pick<ServerConfig, 'ttsServerHost' | 'ttsServerPort'>
): Promise<{
  healthy: boolean;
  message: string;
}> {
  const result = await checkEndpoint(
    buildTTSServerUrl(config),
    '/health',
    'TTS server is healthy',
    'Health check failed'
  );

  return {
    healthy: result.ok,
    message: result.message,
  };
}

export async function checkTtsReadiness(
  config: Pick<ServerConfig, 'ttsServerHost' | 'ttsServerPort'>
): Promise<{
  message: string;
  ready: boolean;
}> {
  const result = await checkEndpoint(
    buildTTSServerUrl(config),
    '/v1/models',
    'TTS server is ready',
    'Ready check failed'
  );

  return {
    ready: result.ok,
    message: result.message,
  };
}
