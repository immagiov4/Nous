import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';
import { LibraryArchiveError } from './libraryArchive.ts';

export const reportLibraryArchiveImportFailure = async (
  error: unknown,
  fileBytes: number
): Promise<string | null> => {
  const correlationId = crypto.randomUUID();
  const archiveError = error instanceof LibraryArchiveError ? error : null;

  try {
    const response = await fetchWithSupabaseAuth(
      `${getBackendUrl()}/api/projects/import-diagnostics`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correlationId,
          code: archiveError?.code || 'LIBRARY_ARCHIVE_UNEXPECTED',
          stage: archiveError?.stage || 'unknown',
          fileBytes,
          projectIndex: archiveError?.projectIndex,
          projectCount: archiveError?.projectCount,
          limitBytes: archiveError?.limitBytes,
        }),
      }
    );
    return response.ok ? correlationId : null;
  } catch (reportError) {
    console.warn('[Nous][Account] Library import diagnostic reporting failed.', reportError);
    return null;
  }
};
