import assert from 'node:assert/strict';
import * as z from 'zod';

import { buildSha256HexDigest } from '../utils/hash.js';
import { canonicalJson } from '../workflows/schemaFingerprint.js';
import { retryLessonGenerationCorrection } from './lessonGenerationCorrection.js';
import type { ResearchSource } from './lessonGenerationSources.js';
import type { LessonGenerationInput } from './lessonGenerationTypes.js';
import {
  type LessonPrimarySourceIdentity,
  readLessonPrimarySources,
} from './lessonPrimarySourceContext.js';

const UnitRangeSchema = z.object({
  firstUnit: z.number().int().nonnegative(),
  lastUnit: z.number().int().nonnegative(),
});

export const LessonEvidenceSelectionSchema = z.object({
  materials: z.array(
    z.object({
      materialId: z.string().min(1),
      reason: z.string().regex(/\S/),
      passages: z.array(UnitRangeSchema.extend({ claims: z.array(z.string().regex(/\S/)).min(1) })),
      overlaps: z.array(
        UnitRangeSchema.extend({
          retainedMaterialId: z.string().min(1),
          retainedFirstUnit: z.number().int().nonnegative(),
          retainedLastUnit: z.number().int().nonnegative(),
          reason: z.string().regex(/\S/),
        })
      ),
    })
  ),
});

type EvidenceUnit = {
  text: string;
  source?: LessonPrimarySourceIdentity;
  startOffset?: number;
  endOffset?: number;
  startSeconds?: number;
  endSeconds?: number;
};

export interface LessonEvidenceMaterial {
  materialId: string;
  kind: 'primary' | 'research' | 'source';
  sourceIndex?: number;
  source?: Omit<ResearchSource, 'youtubeTranscript' | 'note'>;
  units: EvidenceUnit[];
}

export interface LessonEvidencePacket {
  version: 'lesson-evidence-v1';
  materialHash: string;
  selection: z.infer<typeof LessonEvidenceSelectionSchema>;
  passages: Array<{
    materialId: string;
    kind: LessonEvidenceMaterial['kind'];
    sourceIndex?: number;
    source?: Omit<ResearchSource, 'youtubeTranscript' | 'note'>;
    firstUnit: number;
    lastUnit: number;
    claims: string[];
    units: EvidenceUnit[];
  }>;
}

// Line boundaries retain original bytes and offsets. The model chooses complete
// neighboring units needed for meaning, including qualifiers and counterexamples.
const textUnits = (text: string): EvidenceUnit[] => {
  let startOffset = 0;
  return text
    .split(/(?<=\n)/u)
    .filter(Boolean)
    .map(part => {
      const unit = { text: part, startOffset, endOffset: startOffset + part.length };
      startOffset += part.length;
      return unit;
    });
};

export const buildLessonEvidenceMaterials = (
  input: Pick<LessonGenerationInput, 'sourceContext' | 'researchContext' | 'sources'>
): LessonEvidenceMaterial[] => {
  const materials: LessonEvidenceMaterial[] = [];
  if (input.sourceContext)
    materials.push({
      materialId: 'primary',
      kind: 'primary',
      units:
        readLessonPrimarySources(input.sourceContext)?.flatMap(part =>
          textUnits(part.text).map(unit => ({ ...unit, source: part.source }))
        ) ?? textUnits(input.sourceContext),
    });
  if (input.researchContext) {
    // Dossiers can contain the same full sources as the source catalog.
    const dossier = JSON.parse(input.researchContext) as Record<string, unknown>;
    const {
      sources: _sources,
      youtubeResearch: _youtubeResearch,
      evidencePacketJson: _previousEvidence,
      ...content
    } = dossier;
    materials.push({
      materialId: 'research',
      kind: 'research',
      units: textUnits(JSON.stringify(content, null, 2)),
    });
  }
  input.sources.forEach((source, sourceIndex) => {
    const { youtubeTranscript, note, ...identity } = source;
    materials.push({
      materialId: `source-${sourceIndex}`,
      kind: 'source',
      sourceIndex,
      source: identity,
      units: youtubeTranscript
        ? youtubeTranscript.segments.map(segment => ({ ...segment }))
        : textUnits(note ?? ''),
    });
  });
  return materials;
};

const invalidSelection = () =>
  retryLessonGenerationCorrection({
    code: 'lesson_evidence_selection_invalid',
    feedback:
      'Select evidence using existing material IDs and inclusive unit ranges. Classify every material exactly once. Retained ranges must be disjoint, valid and have supported claims. Every omitted overlap must point to a retained range in another material. Preserve qualifiers and context required for meaning.',
    message: 'The lesson evidence selection contains invalid source references.',
  });

const validRange = (
  range: { firstUnit: number; lastUnit: number },
  material: LessonEvidenceMaterial
) => range.firstUnit <= range.lastUnit && range.lastUnit < material.units.length;

const validateSelectedOverlaps = (
  selection: LessonEvidencePacket['selection'],
  byId: ReadonlyMap<string, LessonEvidenceMaterial>,
  passages: LessonEvidencePacket['passages']
) => {
  for (const selected of selection.materials) {
    const material = byId.get(selected.materialId);
    assert(material);
    for (const overlap of selected.overlaps) {
      if (
        !validRange(overlap, material) ||
        overlap.retainedFirstUnit > overlap.retainedLastUnit ||
        overlap.retainedMaterialId === selected.materialId ||
        selected.passages.some(
          range => range.firstUnit <= overlap.lastUnit && range.lastUnit >= overlap.firstUnit
        ) ||
        !passages.some(
          range =>
            range.materialId === overlap.retainedMaterialId &&
            range.firstUnit <= overlap.retainedFirstUnit &&
            range.lastUnit >= overlap.retainedLastUnit
        )
      )
        throw invalidSelection();
    }
  }
};

const mergeAdjacentPassages = (passages: LessonEvidencePacket['passages']) => {
  const merged: LessonEvidencePacket['passages'] = [];
  for (const passage of passages) {
    const previous = merged.at(-1);
    if (
      previous?.materialId === passage.materialId &&
      previous.lastUnit + 1 === passage.firstUnit
    ) {
      previous.lastUnit = passage.lastUnit;
      previous.claims.push(...passage.claims);
      previous.units.push(...passage.units);
    } else {
      merged.push({ ...passage, claims: [...passage.claims], units: [...passage.units] });
    }
  }
  return merged;
};

/** Resolve model-selected references against immutable source units; never accept generated excerpts. */
export const resolveLessonEvidence = (
  materials: LessonEvidenceMaterial[],
  response: unknown
): LessonEvidencePacket => {
  const parsed = LessonEvidenceSelectionSchema.safeParse(response);
  if (!parsed.success) throw invalidSelection();
  const selection = parsed.data;
  const byId = new Map(materials.map(material => [material.materialId, material]));
  if (
    selection.materials.length !== materials.length ||
    new Set(selection.materials.map(item => item.materialId)).size !== materials.length
  )
    throw invalidSelection();
  const passages: LessonEvidencePacket['passages'] = [];
  for (const selected of selection.materials) {
    const material = byId.get(selected.materialId);
    if (!material) throw invalidSelection();
    const ranges = [...selected.passages].sort((a, b) => a.firstUnit - b.firstUnit);
    let previousEnd = -1;
    for (const range of ranges) {
      if (!validRange(range, material) || range.firstUnit <= previousEnd) throw invalidSelection();
      previousEnd = range.lastUnit;
      const { units, ...identity } = material;
      passages.push({
        ...identity,
        ...range,
        units: units.slice(range.firstUnit, range.lastUnit + 1),
      });
    }
  }
  const retainedPassages = mergeAdjacentPassages(passages);
  validateSelectedOverlaps(selection, byId, retainedPassages);
  return {
    version: 'lesson-evidence-v1',
    materialHash: buildSha256HexDigest(Buffer.from(canonicalJson(materials))),
    selection,
    passages: retainedPassages,
  };
};

export const formatLessonEvidence = (packet: LessonEvidencePacket): string =>
  JSON.stringify(packet.passages);

const StoredSelectionSchema = z.object({
  version: z.literal('lesson-evidence-v1'),
  materialHash: z.string(),
  selection: LessonEvidenceSelectionSchema,
});

/** Reconstruct excerpts from originals after a durable step, rejecting stale selections. */
export const restoreLessonEvidence = (
  input: Pick<LessonGenerationInput, 'sourceContext' | 'researchContext' | 'sources'>,
  serialized: string
): LessonEvidencePacket => {
  const saved = StoredSelectionSchema.parse(JSON.parse(serialized));
  const packet = resolveLessonEvidence(buildLessonEvidenceMaterials(input), saved.selection);
  if (packet.materialHash !== saved.materialHash) throw invalidSelection();
  return packet;
};

export const serializeLessonEvidence = (
  input: LessonGenerationInput,
  packet: LessonEvidencePacket
): string =>
  JSON.stringify({
    version: packet.version,
    materialHash: packet.materialHash,
    selection: packet.selection,
    materials: buildLessonEvidenceMaterials(input),
  });
