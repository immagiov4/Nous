export const MARKDOWN_RENDERING_CONTROL_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]|\u007f`,
  'gu'
);

/** Remove display controls with a map from projected UTF-16 boundaries to authored offsets. */
export const projectMarkdownRenderingControls = (
  content: string
): { content: string; sourceOffsets: number[] | null } => {
  const controls = Array.from(content.matchAll(MARKDOWN_RENDERING_CONTROL_PATTERN), match => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  if (!controls.length) return { content, sourceOffsets: null };
  const parts: string[] = [];
  const sourceOffsets: number[] = [];
  let cursor = 0;
  for (const range of [...controls, { start: content.length, end: content.length }]) {
    parts.push(content.slice(cursor, range.start));
    for (let offset = cursor; offset < range.start; offset += 1) sourceOffsets.push(offset);
    cursor = range.end;
  }
  sourceOffsets.push(content.length);
  return { content: parts.join(''), sourceOffsets };
};
