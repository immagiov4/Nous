import {
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
} from '../../services/projects/courseSources.ts';
import { encodeTextBase64 } from '../../services/projects/projectSource.ts';

/** Recreate the persisted 8,000-unit text chunks produced before Unicode-safe indexing. */
export const buildLegacySourceFixture = (text: string) => {
  const sources = buildCourseSourceDescriptors([
    { name: 'legacy.txt', mimeType: 'text/plain', data: encodeTextBase64(text) },
  ]);
  const documentIndex = sources[0].documentIndex;
  if (!documentIndex) throw new Error('Missing text source fixture');
  const chunkChars = 8_000;
  documentIndex.chunks = Array.from(
    { length: Math.ceil(text.length / chunkChars) },
    (_, index) => ({
      ...documentIndex.chunks[0],
      id: `legacy-${index}`,
      sequence: index,
      startOffset: index * chunkChars,
      endOffset: Math.min(text.length, (index + 1) * chunkChars),
      text: text.slice(index * chunkChars, (index + 1) * chunkChars),
    })
  );
  return { documentIndex, source: createProjectSourceFromDescriptors(sources) };
};
