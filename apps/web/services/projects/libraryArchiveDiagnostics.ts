import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';
import { LibraryArchiveError } from './libraryArchive.ts';
import { ProjectStorageError } from './projectRepository.ts';

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

/** Report transport diagnostics without response bodies, user content or credentials. */
export const warnImportRefreshFailed = (error: unknown): void => {
  let errorType = 'Error';
  if (error instanceof TypeError) errorType = 'TypeError';
  else if (error instanceof SyntaxError) errorType = 'SyntaxError';
  console.warn(
    '[Projects] Library reload failed after committed import.',
    error instanceof ProjectStorageError
      ? { code: error.code, httpStatus: error.httpStatus }
      : { code: 'unknown', errorType }
  );
};
