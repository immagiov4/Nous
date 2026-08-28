import type { JSONValue } from 'postgres';

import { normalizeProjectSnapshot } from './projectMeta.js';
import type { ProjectSnapshot, SavedProjectMeta } from './types.js';

export interface StoredProjectMetaRow {
  meta: SavedProjectMeta;
  revision: number | string;
}

export interface StoredProjectSnapshotRow {
  document_index: unknown;
  snapshot: Omit<ProjectSnapshot, 'documentIndex'>;
}

export const toPostgresJson = (value: unknown): JSONValue => value as JSONValue;

export const stripProjectRevision = (
  meta: SavedProjectMeta
): Omit<SavedProjectMeta, 'revision'> => {
  const { revision: _revision, ...storedMeta } = meta;
  return storedMeta;
};

export const mergeProjectMetaRow = (row: StoredProjectMetaRow): SavedProjectMeta => ({
  ...row.meta,
  revision: Number(row.revision),
});

export const splitProjectSnapshot = (snapshot: ProjectSnapshot) => {
  const { documentIndex, ...snapshotWithoutDocumentIndex } = snapshot;
  return { documentIndex: documentIndex ?? null, snapshotWithoutDocumentIndex };
};

export const mergeProjectSnapshotRow = (row: StoredProjectSnapshotRow): ProjectSnapshot =>
  normalizeProjectSnapshot(
    {
      ...row.snapshot,
      ...(row.document_index === null ? {} : { documentIndex: row.document_index }),
    },
    false,
    { recoverHistoricalLessonContentBlocks: true }
  );
