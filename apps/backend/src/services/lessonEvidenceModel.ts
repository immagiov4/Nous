import {
  buildLessonEvidenceMaterials,
  type LessonEvidencePacket,
  resolveLessonEvidence,
} from './lessonEvidence.js';
import type { LessonGenerationInput } from './lessonGenerationTypes.js';

/** Keep every bounded source unit; selection cost more tokens and retries than it saved. */
export const selectLessonEvidence = async (
  input: LessonGenerationInput
): Promise<LessonEvidencePacket> => {
  const materials = buildLessonEvidenceMaterials(input);
  return resolveLessonEvidence(materials, {
    materials: materials.map(material => ({
      materialId: material.materialId,
      reason: 'Bounded source material retained for lesson grounding.',
      passages: material.units.length
        ? [
            {
              firstUnit: 0,
              lastUnit: material.units.length - 1,
              claims: ['Complete bounded source material.'],
            },
          ]
        : [],
      overlaps: [],
    })),
  });
};
