import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import { translateUiMessage } from '../../i18n/uiMessages';
import type { ProjectSourceWarning } from '../../types';
import { isZipFileData } from './projectSource';

import { readSourceZipDirectory, ZipEntryCountError } from './zipDirectory';

export { readSourceZipDirectory } from './zipDirectory';

const inspectSourceFile = async (
  file: File
): Promise<{ accepted: boolean; warnings: ProjectSourceWarning[] }> => {
  if (!isZipFileData({ name: file.name, mimeType: file.type }))
    return file.size > COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes
      ? {
          accepted: false,
          warnings: [
            { name: file.name, message: translateUiMessage('Supera il limite di 32 MB per file.') },
          ],
        }
      : { accepted: true, warnings: [] };
  if (file.size > COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes)
    return {
      accepted: false,
      warnings: [
        { name: file.name, message: translateUiMessage('L’archivio supera il limite di 1 GB.') },
      ],
    };
  try {
    const entries = await readSourceZipDirectory(file);
    const invalidEntries = entries.filter(
      entry => entry.byteSize > COURSE_SOURCE_UPLOAD_LIMITS.maxArchiveEntryBytes
    );
    if (invalidEntries.length)
      return {
        accepted: false,
        warnings: invalidEntries.map(entry => ({
          name: entry.name,
          message: translateUiMessage('Supera il limite di 256 MB per file nell’archivio.'),
        })),
      };
    if (
      entries.reduce((bytes, entry) => bytes + entry.byteSize, 0) >
      COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes
    )
      return {
        accepted: false,
        warnings: [
          {
            name: file.name,
            message: translateUiMessage('L’archivio espanso supera il limite di 1 GB.'),
          },
        ],
      };
    return {
      accepted: true,
      warnings: entries
        .filter(
          entry =>
            entry.name.toLowerCase().endsWith('.pdf') &&
            entry.byteSize > COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes
        )
        .map(entry => ({
          name: entry.name,
          message: translateUiMessage('Supera il limite di 32 MB per file.'),
        })),
    };
  } catch (error) {
    if (error instanceof ZipEntryCountError)
      return {
        accepted: false,
        warnings: [
          {
            name: file.name,
            message: translateUiMessage('L’archivio contiene più di 20.000 voci.'),
          },
        ],
      };
    return {
      accepted: false,
      warnings: [
        {
          name: file.name,
          message: translateUiMessage('La struttura dell’archivio ZIP non è leggibile.'),
        },
      ],
    };
  }
};

export const inspectSourceSelection = async (
  files: readonly File[]
): Promise<{ files: File[]; warnings: ProjectSourceWarning[] }> => {
  const accepted: File[] = [];
  const warnings: ProjectSourceWarning[] = [];
  for (const file of files) {
    const result = await inspectSourceFile(file);
    warnings.push(...result.warnings);
    if (result.accepted) accepted.push(file);
  }
  if (
    accepted.reduce((bytes, file) => bytes + file.size, 0) >
    COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes
  )
    return {
      files: [],
      warnings: [
        ...warnings,
        {
          name: 'Materiale selezionato',
          message: translateUiMessage('Supera il limite di 1 GB per caricamento.'),
        },
      ],
    };
  return { files: accepted, warnings };
};
