import { describe, expect, test } from 'vitest';
import {
  createExerciseAttachmentFromFile,
  validateExerciseDeliverable,
} from '../../../services/exercises/deliverables.ts';
import type { ExerciseAttachment } from '../../../types.ts';

const buildTextAttachment = (index: number): ExerciseAttachment => ({
  id: `attachment-${index}`,
  name: `file-${index}.md`,
  mimeType: 'text/markdown',
  kind: 'text',
  data: `Contenuto ${index}`,
  truncated: false,
  createdAt: '2026-07-11T10:00:00.000Z',
  updatedAt: '2026-07-11T10:00:00.000Z',
});

describe('exercise deliverable validation', () => {
  test('accepts supported text files and rejects unsupported attachments', async () => {
    const attachment = await createExerciseAttachmentFromFile(
      new File(['# Diagnosi\n\nEvidenza osservata.'], 'diagnosi.md', {
        type: 'text/markdown',
      })
    );

    expect(attachment).toMatchObject({
      data: '# Diagnosi\n\nEvidenza osservata.',
      kind: 'text',
      mimeType: 'text/markdown',
      name: 'diagnosi.md',
      truncated: false,
    });
    await expect(
      createExerciseAttachmentFromFile(
        new File(['contenuto non immagine'], 'diagramma.png', { type: 'image/png' })
      )
    ).rejects.toThrow('Puoi allegare solo file testuali supportati o archivi .zip.');
  });

  test('truncates oversized text at a readable block boundary', async () => {
    const firstParagraph = 'a'.repeat(13_000);
    const result = await validateExerciseDeliverable({
      attachments: [],
      internalText: `${firstParagraph}\n\n${'b'.repeat(9_000)}`,
    });

    expect(result.entries).toEqual([
      expect.objectContaining({
        path: 'risposta-interna.md',
        text: firstParagraph,
        truncated: true,
      }),
    ]);
    expect(result.truncations).toHaveLength(1);
    expect(result.totalChars).toBe(firstParagraph.length);
  });

  test('keeps the first ten readable files and reports later files as dropped', async () => {
    const result = await validateExerciseDeliverable({
      attachments: Array.from({ length: 11 }, (_, index) => buildTextAttachment(index + 1)),
    });

    expect(result.entries.map(entry => entry.path)).toEqual(
      Array.from({ length: 10 }, (_, index) => `file-${index + 1}.md`)
    );
    expect(result.dropped).toEqual(['file-11.md: superato il limite di 10 file.']);
  });
});
