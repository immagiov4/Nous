import { PDF_TEXT_SOURCE_CHUNK_CHARS } from '@shared/pdfDocumentPolicy';
import { buildPdfTextIndex } from '@shared/pdfTextIndex';

import { type CourseSourceMaterial, sortCourseSourceMaterials } from './courseGenerationSources.js';
import type { CourseDocumentIndex } from './courseGenerationWorkflowContract.js';

const buildTextSourceIndex = (
  material: CourseSourceMaterial,
  now: () => string
): CourseDocumentIndex => {
  const chunks: CourseDocumentIndex['chunks'] = [];
  for (let offset = 0; offset < material.text.length; offset += PDF_TEXT_SOURCE_CHUNK_CHARS) {
    const endOffset = Math.min(material.text.length, offset + PDF_TEXT_SOURCE_CHUNK_CHARS);
    const text = material.text.slice(offset, endOffset).trim();
    if (!text) continue;
    chunks.push({
      endOffset,
      headingPath: [material.descriptor.name],
      id: `${material.descriptor.id}:chunk-${String(chunks.length + 1).padStart(3, '0')}`,
      sequence: chunks.length,
      sourceId: material.descriptor.id,
      startOffset: offset,
      text,
    });
  }
  return {
    chunks,
    documentTitle: material.descriptor.name,
    kind: 'pdf-text-index',
    parsedAt: now(),
    sourceHash: material.descriptor.hash,
    sourceIds: [material.descriptor.id],
  };
};

const buildSourceIndex = (
  material: CourseSourceMaterial,
  now: () => string
): CourseDocumentIndex => {
  if (!material.pdf) return buildTextSourceIndex(material, now);
  const index = buildPdfTextIndex(
    material.text,
    material.descriptor.hash,
    material.descriptor.name,
    material.pdf.pages,
    material.descriptor.id,
    now
  );
  return {
    ...index,
    pageCount: material.pdf.pageCount ?? index.pageCount,
  };
};

export const buildCourseDocumentIndex = (
  materials: readonly CourseSourceMaterial[],
  now: () => string
): CourseDocumentIndex | null => {
  const sources = sortCourseSourceMaterials(materials).map(material => ({
    index: buildSourceIndex(material, now),
    material,
  }));
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0].index;
  const chunks = sources.flatMap(({ index, material }) =>
    index.chunks.map(chunk => ({
      ...chunk,
      headingPath:
        chunk.headingPath[0] === material.descriptor.name
          ? chunk.headingPath
          : [material.descriptor.name, ...chunk.headingPath],
    }))
  );
  return {
    chunks: chunks.map((chunk, sequence) => ({ ...chunk, sequence })),
    documentTitle: sources.map(({ material }) => material.descriptor.name).join(', '),
    kind: 'pdf-text-index',
    parsedAt: now(),
    sourceHash: sources.map(({ material }) => material.descriptor.hash).join(':'),
    sourceIds: sources.map(({ material }) => material.descriptor.id),
  };
};
