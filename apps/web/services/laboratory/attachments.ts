import JSZip from 'jszip';
import type { LaboratoryAttachment } from '../../types.ts';
import { createEntityId } from '../../utils/ids.ts';
import { isBinaryFile } from '../../utils/project/codebaseBundle.ts';
import { clipText, normalizeLineEndings } from '../../utils/text.ts';
import { timestampIso } from '../../utils/time.ts';
import {
  decodeBase64Bytes,
  decodeTextBase64,
  detectSourceFileKind,
  encodeBytesBase64,
  encodeTextBase64,
  normalizeSourceFileMimeType,
} from '../projects/projectSource.ts';

const MAX_ARCHIVE_CONTEXT_CHARS = 72_000;
const MAX_ARCHIVE_TEXT_FILES = 12;
const MAX_TEXT_ATTACHMENT_CHARS = 48_000;

const createLaboratoryAttachmentId = () => createEntityId({ fallbackPrefix: 'lab-attachment' });

export const createLaboratoryTextAttachment = ({
  content,
  mimeType = 'text/markdown',
  name,
}: {
  content?: string;
  mimeType?: string;
  name: string;
}): LaboratoryAttachment => {
  const now = timestampIso();

  return {
    id: createLaboratoryAttachmentId(),
    name,
    mimeType,
    kind: 'text',
    data: encodeTextBase64(content || ''),
    createdAt: now,
    updatedAt: now,
  };
};

export const updateLaboratoryTextAttachment = (
  attachment: LaboratoryAttachment,
  content: string,
  name?: string
): LaboratoryAttachment => ({
  ...attachment,
  name: name || attachment.name,
  kind: 'text',
  mimeType: attachment.mimeType || 'text/markdown',
  data: encodeTextBase64(content),
  updatedAt: timestampIso(),
});

export const readLaboratoryTextAttachment = (attachment: LaboratoryAttachment): string => {
  if (attachment.kind !== 'text') {
    return '';
  }

  try {
    return decodeTextBase64(attachment.data);
  } catch {
    return '';
  }
};

export const createLaboratoryAttachmentFromFile = async (
  file: File
): Promise<LaboratoryAttachment> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = (() => {
    const normalizedMimeType = file.type.split(';', 1)[0]?.trim().toLowerCase() || '';
    if (normalizedMimeType.startsWith('image/')) {
      return 'image' as const;
    }

    const sourceKind = detectSourceFileKind({
      name: file.name,
      mimeType: file.type,
      bytes,
    });

    if (sourceKind === 'zip') {
      return 'archive' as const;
    }

    if (sourceKind === 'text') {
      return 'text' as const;
    }

    return 'binary' as const;
  })();

  const now = timestampIso();

  return {
    id: createLaboratoryAttachmentId(),
    name: file.name,
    mimeType: normalizeSourceFileMimeType(
      file.name,
      file.type,
      kind === 'archive' ? 'zip' : kind === 'text' ? 'text' : 'unsupported'
    ),
    kind,
    data: encodeBytesBase64(bytes),
    createdAt: now,
    updatedAt: now,
  };
};

const buildTextAttachmentContext = (attachment: LaboratoryAttachment): string => {
  const text = normalizeLineEndings(readLaboratoryTextAttachment(attachment).trim());
  if (!text) {
    return `FILE: ${attachment.name}\nTipo: ${attachment.mimeType}\nContenuto testuale vuoto o non leggibile.`;
  }

  return `FILE: ${attachment.name}\nTipo: ${attachment.mimeType}\n\n${clipText(text, MAX_TEXT_ATTACHMENT_CHARS, '[file testuale troncato]')}`;
};

const buildBinaryAttachmentContext = (attachment: LaboratoryAttachment): string => {
  const lines = [
    `FILE: ${attachment.name}`,
    `Tipo: ${attachment.mimeType}`,
    'Contenuto binario non leggibile direttamente dal valutatore.',
  ];

  if (attachment.description?.trim()) {
    lines.push(`Descrizione fornita dall'utente: ${attachment.description.trim()}`);
  }

  return lines.join('\n');
};

const buildArchiveAttachmentContext = async (attachment: LaboratoryAttachment): Promise<string> => {
  const zip = await JSZip.loadAsync(decodeBase64Bytes(attachment.data));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = Object.values(zip.files)
    .filter(entry => !entry.dir)
    .sort((left, right) => left.name.localeCompare(right.name));

  const readableBlocks: string[] = [];
  let includedTextFiles = 0;
  let skippedBinaryFiles = 0;

  for (const entry of entries) {
    if (includedTextFiles >= MAX_ARCHIVE_TEXT_FILES) {
      break;
    }

    const raw = await entry.async('uint8array');
    if (isBinaryFile(raw)) {
      skippedBinaryFiles += 1;
      continue;
    }

    try {
      const decoded = normalizeLineEndings(decoder.decode(raw).trim());
      if (!decoded) {
        continue;
      }

      readableBlocks.push(
        `--- START OF FILE: ${entry.name} ---\n${clipText(decoded, 12_000, '[file archivio troncato]')}`
      );
      includedTextFiles += 1;
    } catch {
      skippedBinaryFiles += 1;
    }
  }

  const header = [
    `FILE: ${attachment.name}`,
    `Tipo: ${attachment.mimeType}`,
    `Archivio con ${includedTextFiles} file testuali letti e ${skippedBinaryFiles} file binari o non leggibili ignorati.`,
  ];

  if (attachment.description?.trim()) {
    header.push(`Descrizione fornita dall'utente: ${attachment.description.trim()}`);
  }

  if (readableBlocks.length === 0) {
    header.push('Nessun file testuale leggibile trovato nell archivio.');
    return header.join('\n');
  }

  return clipText(
    `${header.join('\n')}\n\n${readableBlocks.join('\n\n')}`,
    MAX_ARCHIVE_CONTEXT_CHARS,
    '[archivio troncato]'
  );
};

export interface LaboratoryAttachmentContextOptions {
  describeImageAttachment?: (attachment: LaboratoryAttachment) => Promise<string>;
}

export interface LaboratoryAttachmentContextResult {
  content: string;
  warnings: string[];
}

export const buildLaboratoryAttachmentContext = async (
  attachments: LaboratoryAttachment[],
  options: LaboratoryAttachmentContextOptions = {}
): Promise<LaboratoryAttachmentContextResult> => {
  const blocks: string[] = [];
  const warnings: string[] = [];

  for (const attachment of attachments) {
    try {
      if (attachment.kind === 'text') {
        blocks.push(buildTextAttachmentContext(attachment));
        continue;
      }

      if (attachment.kind === 'archive') {
        blocks.push(await buildArchiveAttachmentContext(attachment));
        continue;
      }

      if (attachment.kind === 'image') {
        const lines = [`FILE: ${attachment.name}`, `Tipo: ${attachment.mimeType}`];

        if (attachment.description?.trim()) {
          lines.push(`Descrizione fornita dall'utente: ${attachment.description.trim()}`);
        }

        if (options.describeImageAttachment) {
          const imageDescription = await options.describeImageAttachment(attachment);
          if (imageDescription.trim()) {
            lines.push(`Descrizione visiva stimata: ${imageDescription.trim()}`);
          }
        } else if (!attachment.description?.trim()) {
          warnings.push(`L'immagine ${attachment.name} non ha una descrizione testuale allegata.`);
        }

        blocks.push(lines.join('\n'));
        continue;
      }

      blocks.push(buildBinaryAttachmentContext(attachment));
    } catch (error) {
      warnings.push(
        error instanceof Error
          ? `Non sono riuscito a leggere ${attachment.name}: ${error.message}`
          : `Non sono riuscito a leggere ${attachment.name}.`
      );
      blocks.push(buildBinaryAttachmentContext(attachment));
    }
  }

  return {
    content: blocks.join('\n\n===\n\n').trim(),
    warnings,
  };
};
