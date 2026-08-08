import { isProjectAssetId } from '@shared/projectAsset';
import { type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  type ProjectAssetReader,
  ProjectAssetReaderUnavailableError,
} from '../projects/projectAssetReader.js';

const getRouteParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] || '' : value || '';

export const createProjectAssetRouter = (reader: ProjectAssetReader): Router => {
  const router = Router();

  router.get('/:projectId/assets/:assetId', async (req: Request, res: Response) => {
    const assetId = getRouteParam(req.params.assetId);
    const projectId = getRouteParam(req.params.projectId).trim();
    if (!projectId || !isProjectAssetId(assetId)) {
      res.status(400).json({
        code: 'project_asset_request_invalid',
        error: 'Richiesta della risorsa non valida.',
        success: false,
      });
      return;
    }

    try {
      const userId = getCurrentUser(req).id;
      const asset = await reader.readActive({ assetId, projectId, userId });
      if (!asset) {
        res.status(404).json({
          code: 'project_asset_not_found',
          error: 'Risorsa del progetto non trovata.',
          success: false,
        });
        return;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Type': asset.mediaType,
        'X-Content-Type-Options': 'nosniff',
      });
      res.status(200).send(Buffer.from(asset.bytes));
    } catch (error) {
      const unavailable = error instanceof ProjectAssetReaderUnavailableError;
      console.error('[ProjectAsset] Read failed.', {
        assetId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        projectId,
      });
      res.status(unavailable ? 503 : 500).json({
        code: unavailable ? 'project_asset_reader_unavailable' : 'project_asset_read_failed',
        error: unavailable
          ? 'Servizio risorse del progetto non disponibile.'
          : 'Risorsa del progetto non disponibile.',
        success: false,
      });
    }
  });

  return router;
};
