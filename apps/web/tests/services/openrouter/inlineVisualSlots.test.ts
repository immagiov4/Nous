import { beforeEach, describe, expect, test, vi } from 'vitest';

const { generateVerifiedVisualSlotsMock } = vi.hoisted(() => ({
  generateVerifiedVisualSlotsMock: vi.fn(),
}));

vi.mock('../../../services/openrouter/visualExamples.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../services/openrouter/visualExamples.ts')>()),
  generateVerifiedVisualSlots: generateVerifiedVisualSlotsMock,
}));

import { materializeGeneratedVisualSlots } from '../../../services/openrouter/lessonImages.ts';
import type { VerifiedVisualSlotPlan } from '../../../services/openrouter/visualExamples.ts';

const plan: VerifiedVisualSlotPlan = {
  slotId: 'slot-001',
  complexity: 'moderate',
  concept: 'Confronto visivo',
  coverage: 'single_complex',
  coverageRationale: 'Mostra il passaggio difficile.',
  factualRequirements: ['Le due varianti devono restare distinguibili.'],
  interactionLevel: 'none',
  pedagogicalGoal: 'Rendere leggibile il confronto.',
  reason: 'Il testo da solo non mostra la differenza.',
  requiresDepiction: true,
  visualDirection: 'Due varianti affiancate.',
  visualType: 'illustrative_image',
};

describe('inline visual slots', () => {
  beforeEach(() => {
    generateVerifiedVisualSlotsMock.mockReset();
  });

  test('materializes a generated visual exactly where the writer placed its slot', async () => {
    generateVerifiedVisualSlotsMock.mockResolvedValue([
      {
        slotId: 'slot-001',
        visual: {
          id: 'visual-001',
          title: 'confronto_visivo',
          kind: 'image',
          code: 'data:image/png;base64,AAAA',
          altText: 'Confronto visivo',
          mediaType: 'image/png',
          createdAt: '2026-07-18T00:00:00.000Z',
        },
      },
    ]);

    const result = await materializeGeneratedVisualSlots({
      contentMarkdown: 'Prima.\n\n{{VISUAL_SLOT:slot-001}}\n\nDopo.',
      hasPdfImages: false,
      sectionDescription: 'Descrizione',
      sectionTitle: 'Titolo',
      visualPlanning: { plans: [plan], rationale: 'Serve qui.' },
    });

    expect(result.content).toBe(
      'Prima.\n\n{{VISUAL_EXAMPLE:visual-001|title=confronto_visivo}}\n\nDopo.'
    );
    expect(result.generatedVisuals).toHaveLength(1);
  });

  test('removes an unresolved slot instead of moving it to the lesson end', async () => {
    generateVerifiedVisualSlotsMock.mockResolvedValue([]);

    const result = await materializeGeneratedVisualSlots({
      contentMarkdown: 'Prima.\n\n{{VISUAL_SLOT:slot-001}}\n\nDopo.',
      hasPdfImages: false,
      sectionDescription: 'Descrizione',
      sectionTitle: 'Titolo',
      visualPlanning: { plans: [plan], rationale: 'Serve qui.' },
    });

    expect(result.content).toBe('Prima.\n\nDopo.');
    expect(result.content).not.toContain('VISUAL_');
  });

  test('converts an SVG plan to an image when the lesson requires a depiction', async () => {
    generateVerifiedVisualSlotsMock.mockResolvedValue([]);

    await materializeGeneratedVisualSlots({
      contentMarkdown: 'Prima.\n\n{{VISUAL_SLOT:slot-001}}\n\nDopo.',
      hasPdfImages: false,
      sectionDescription: 'Descrizione',
      sectionTitle: 'Titolo',
      visualPlanning: {
        plans: [{ ...plan, visualType: 'flowchart_svg' }],
        rationale: 'Mostra un risultato grafico.',
      },
    });

    expect(generateVerifiedVisualSlotsMock).toHaveBeenCalledWith(expect.any(Object), [
      expect.objectContaining({ visualType: 'illustrative_image' }),
    ]);
  });
});
