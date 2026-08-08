import {
  isValidProjectAssetRef,
  normalizeProjectAssetMediaType,
  type ProjectAssetRef,
} from '@shared/projectAsset';

import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';

export class ProjectAssetDownloadError extends Error {
  constructor(
    readonly code:
      | 'asset-content-invalid'
      | 'asset-reference-invalid'
      | 'asset-request-failed'
      | 'project-id-missing'
  ) {
    super(`Project asset download failed: ${code}.`);
    this.name = 'ProjectAssetDownloadError';
  }
}

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

export const downloadProjectAssetBytes = async (
  projectId: string,
  ref: ProjectAssetRef,
  signal?: AbortSignal
): Promise<Uint8Array> => {
  if (!projectId.trim()) throw new ProjectAssetDownloadError('project-id-missing');
  if (!isValidProjectAssetRef(ref)) {
    throw new ProjectAssetDownloadError('asset-reference-invalid');
  }

  let response: Response;
  try {
    response = await fetchWithSupabaseAuth(
      `${getBackendUrl()}/api/projects/${encodeURIComponent(projectId)}/assets/${ref.id}`,
      signal ? { signal } : undefined
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ProjectAssetDownloadError('asset-request-failed');
  }
  if (!response.ok) throw new ProjectAssetDownloadError('asset-request-failed');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes.byteLength !== ref.byteSize ||
    normalizeProjectAssetMediaType(response.headers.get('content-type')) !==
      normalizeProjectAssetMediaType(ref.mediaType) ||
    (await sha256(bytes)) !== ref.hash
  ) {
    throw new ProjectAssetDownloadError('asset-content-invalid');
  }
  return bytes;
};
