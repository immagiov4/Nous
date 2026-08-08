import { collectProjectAssetReferences } from '@shared/projectBackupAssets';
import type { TransactionSql } from 'postgres';

import { ProjectAssetStoreError } from './projectAsset.js';
import type { ProjectSnapshot } from './types.js';

interface ReachableAssetRow {
  byte_size: number | string;
  content_hash: string;
  id: string;
  media_type: string;
  state: 'active' | 'deletion-pending' | 'staged';
}

export const reconcileProjectAssets = async (
  transaction: TransactionSql,
  input: {
    previousSnapshot: ProjectSnapshot | null;
    projectId: string;
    snapshot: ProjectSnapshot;
    userId: string;
  }
): Promise<number> => {
  const reachableAssets = collectProjectAssetReferences(input.snapshot);
  const reachableAssetIds = reachableAssets.map(asset => asset.id);
  if (reachableAssetIds.length > 0) {
    const reachable = await transaction<ReachableAssetRow[]>`
      select id, state, content_hash, byte_size, media_type
      from public.project_assets
      where id in ${transaction(reachableAssetIds)}
        and user_id = ${input.userId}
        and project_id = ${input.projectId}
      order by id
      for update
    `;
    const storedById = new Map(reachable.map(asset => [asset.id, asset]));
    if (reachable.length !== reachableAssetIds.length) {
      throw new ProjectAssetStoreError('asset-not-adoptable');
    }
    for (const reference of reachableAssets) {
      const stored = storedById.get(reference.id);
      if (
        stored?.state !== 'active' ||
        stored?.content_hash !== reference.hash ||
        Number(stored?.byte_size) !== reference.byteSize ||
        stored?.media_type !== reference.mediaType
      ) {
        throw new ProjectAssetStoreError('asset-not-adoptable');
      }
    }
  }

  const reachableAssetIdSet = new Set(reachableAssetIds);
  const removedAssetIds = input.previousSnapshot
    ? collectProjectAssetReferences(input.previousSnapshot)
        .map(asset => asset.id)
        .filter(assetId => !reachableAssetIdSet.has(assetId))
    : [];
  if (removedAssetIds.length === 0) return 0;

  const queued = await transaction<Array<{ id: string }>>`
    update public.project_assets
    set state = 'deletion-pending',
        deletion_queued_at = coalesce(deletion_queued_at, clock_timestamp())
    where user_id = ${input.userId}
      and project_id = ${input.projectId}
      and state = 'active'
      and id in ${transaction(removedAssetIds)}
    returning id
  `;
  return queued.length;
};
