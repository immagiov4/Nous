import { type NextFunction, type Request, type Response, Router, urlencoded } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import type { LibraryExportApi } from '../projects/libraryExport.js';
import { createCorrelationId, getCorrelationId } from '../workflows/requestObservability.js';

const EXPORT_START_ERROR = 'Impossibile avviare il backup completo.';
const EXPORT_STATUS_ERROR = 'Impossibile leggere lo stato del backup completo.';
const EXPORT_DOWNLOAD_ERROR = 'Il backup completo non è pronto per il download.';

const getRouteParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] || '' : value || '';

const getSafeErrorType = (error: unknown): string =>
  error instanceof Error ? error.name : 'UnknownError';

const getDownloadAccessToken = (body: unknown): string => {
  if (!body || typeof body !== 'object' || !('downloadToken' in body)) return '';
  return typeof body.downloadToken === 'string' ? body.downloadToken : '';
};

export const createLibraryExportRouter = (api: LibraryExportApi): Router => {
  const router = Router();

  router.post('/library-exports', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const run = await api.startOrResume(
        getCurrentUser(req).id,
        getCorrelationId() ?? createCorrelationId()
      );
      res.status(run.status === 'completed' ? 200 : 202).json({ run, success: true });
    } catch (error) {
      console.error('[LibraryExport] Start route failed.', { errorType: getSafeErrorType(error) });
      res.status(500).json({ error: EXPORT_START_ERROR, success: false });
    }
  });

  router.get('/library-exports/:runId', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const run = await api.getStatus(getCurrentUser(req).id, getRouteParam(req.params.runId));
      if (!run) {
        res.status(404).json({ error: EXPORT_STATUS_ERROR, success: false });
        return;
      }
      res.json({ run, success: true });
    } catch (error) {
      console.error('[LibraryExport] Status route failed.', { errorType: getSafeErrorType(error) });
      res.status(500).json({ error: EXPORT_STATUS_ERROR, success: false });
    }
  });

  router.post('/library-exports/:runId/download-access', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const runId = getRouteParam(req.params.runId);
    try {
      const downloadToken = await api.createDownloadAccess(getCurrentUser(req).id, runId);
      if (!downloadToken) {
        res.status(409).json({ error: EXPORT_DOWNLOAD_ERROR, success: false });
        return;
      }
      res.json({ downloadToken, success: true });
    } catch (error) {
      console.error('[LibraryExport] Download access route failed.', {
        errorType: getSafeErrorType(error),
        runId,
      });
      res.status(500).json({ error: EXPORT_DOWNLOAD_ERROR, success: false });
    }
  });

  return router;
};

export const createLibraryExportDownloadRouter = (api: LibraryExportApi): Router => {
  const router = Router();

  router.post(
    '/library-exports/:runId/download',
    urlencoded({ extended: false }),
    async (req: Request, res: Response, next: NextFunction) => {
      res.set('Cache-Control', 'no-store');
      const runId = getRouteParam(req.params.runId);
      try {
        const download = await api.getDownload(runId, getDownloadAccessToken(req.body));
        if (!download) {
          res.status(409).json({ error: EXPORT_DOWNLOAD_ERROR, success: false });
          return;
        }
        res.set('Content-Length', String(download.archiveBytes));
        res.download(download.archivePath, download.filename, error => {
          if (error) {
            console.error('[LibraryExport] Download failed.', {
              errorType: getSafeErrorType(error),
              runId,
              userId: download.userId,
            });
            if (!res.headersSent) {
              res.status(500).json({ error: EXPORT_DOWNLOAD_ERROR, success: false });
            } else {
              next(error);
            }
            return;
          }
          void api.completeDownload(download.userId, runId).catch(cleanupError => {
            console.error('[LibraryExport] Download cleanup failed.', {
              errorType: getSafeErrorType(cleanupError),
              runId,
              userId: download.userId,
            });
          });
        });
      } catch (error) {
        console.error('[LibraryExport] Download route failed.', {
          errorType: getSafeErrorType(error),
          runId,
        });
        if (!res.headersSent) {
          res.status(500).json({ error: EXPORT_DOWNLOAD_ERROR, success: false });
        } else {
          next(error);
        }
      }
    }
  );

  return router;
};
