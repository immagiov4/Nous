import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import { DEFAULT_MAX_ZIP_ENTRY_NAME_CHARS, isSafeZipEntryPath } from '@shared/zipSafety';
import { translateUiMessage } from '../../i18n/uiMessages';
import type { ProjectSourceWarning } from '../../types';
import { isZipFileData } from './projectSource';

import { readSourceZipDirectory, ZipEntryCountError } from './zipDirectory';

export { readSourceZipDirectory } from './zipDirectory';

/** Shared admission report for the picker and the ingestion gateway. */
export const getSourceFileExclusion = (
  { name, byteSize }: { name: string; byteSize: number },
  archiveMember = false
): ProjectSourceWarning | undefined => {
  if (!isSafeZipEntryPath(name) || name.length > DEFAULT_MAX_ZIP_ENTRY_NAME_CHARS)
    return { name, message: translateUiMessage('Il percorso del file non è valido.') };
  if (byteSize > COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes)
    return { name, message: translateUiMessage('Supera il limite di 32 MB per file.') };
  if (archiveMember && isZipFileData({ name, mimeType: '' }))
    return {
      name,
      message: translateUiMessage(
        'Gli archivi annidati devono essere estratti prima di aggiungere i file.'
      ),
    };
};

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
        .filter(entry => !entry.name.endsWith('/'))
        .flatMap(entry => {
          const exclusion = getSourceFileExclusion(entry, true);
          return exclusion ? [exclusion] : [];
        }),
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
          name: translateUiMessage('Materiale selezionato'),
          message: translateUiMessage('Supera il limite di 1 GB per caricamento.'),
        },
      ],
    };
  return { files: accepted, warnings };
};
