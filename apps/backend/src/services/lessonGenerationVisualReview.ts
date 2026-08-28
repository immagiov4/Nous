import { Resvg } from '@resvg/resvg-js';

const SVG_PREVIEW_WIDTH = 680;
const TEXT_HEIGHT = 18;

export interface ReviewableLessonVisual {
  code: string;
  kind: 'html' | 'image' | 'mermaid' | 'svg';
}

interface EstimatedTextRect {
  bottom: number;
  label: string;
  left: number;
  right: number;
  top: number;
}

const isWhitespace = (character: string | undefined): boolean =>
  character === ' ' || character === '\n' || character === '\r' || character === '\t';

const readAttribute = (attributes: string, name: string): string => {
  const lowercaseAttributes = attributes.toLowerCase();
  for (const quote of ['"', "'"]) {
    const prefix = `${name.toLowerCase()}=${quote}`;
    let searchFrom = 0;
    while (searchFrom < attributes.length) {
      const start = lowercaseAttributes.indexOf(prefix, searchFrom);
      if (start < 0) break;
      if (start === 0 || isWhitespace(attributes[start - 1])) {
        const valueStart = start + prefix.length;
        const valueEnd = attributes.indexOf(quote, valueStart);
        if (valueEnd >= 0) return attributes.slice(valueStart, valueEnd);
      }
      searchFrom = start + prefix.length;
    }
  }
  return '';
};

interface SvgViewBox {
  height: number;
  width: number;
}

const readViewBox = (svgCode: string): SvgViewBox => {
  const svgStart = svgCode.toLowerCase().indexOf('<svg');
  const svgTagEnd = svgCode.indexOf('>', svgStart);
  const attributes =
    svgStart >= 0 && svgTagEnd > svgStart ? svgCode.slice(svgStart + 4, svgTagEnd) : '';
  const [minX, minY, width, rawHeight] = readAttribute(attributes, 'viewBox').trim().split(/\s+/u);
  const parsedWidth = Number.parseFloat(width || '');
  const height = Number.parseFloat(rawHeight || '');
  if (
    !Number.isFinite(parsedWidth) ||
    parsedWidth <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new Error('La bozza SVG non ha una viewBox valida.');
  }
  if (minX !== '0' || minY !== '0') {
    throw new Error('La bozza SVG non usa la viewBox prevista.');
  }
  return { height, width: parsedWidth };
};

const stripMarkup = (value: string): string => {
  let text = '';
  let cursor = 0;
  while (cursor < value.length) {
    if (value[cursor] !== '<') {
      text += value[cursor];
      cursor += 1;
      continue;
    }
    const tagEnd = value.indexOf('>', cursor + 1);
    cursor = tagEnd < 0 ? value.length : tagEnd + 1;
  }
  return text;
};

const getTextLeft = (x: number, estimatedWidth: number, anchor: string): number => {
  if (anchor === 'middle') return x - estimatedWidth / 2;
  if (anchor === 'end') return x - estimatedWidth;
  return x;
};

const collectTextRects = (
  svgCode: string,
  height: number,
  width: number,
  issues: string[]
): EstimatedTextRect[] => {
  const textRects: EstimatedTextRect[] = [];
  const lowercaseSvg = svgCode.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < svgCode.length) {
    const textStart = lowercaseSvg.indexOf('<text', searchFrom);
    if (textStart < 0) break;
    const boundary = svgCode[textStart + 5];
    if (boundary !== '>' && !isWhitespace(boundary)) {
      searchFrom = textStart + 5;
      continue;
    }
    const openingTagEnd = svgCode.indexOf('>', textStart + 5);
    const closingTagStart = lowercaseSvg.indexOf('</text>', openingTagEnd + 1);
    if (openingTagEnd < 0 || closingTagStart < 0) break;
    const attributes = svgCode.slice(textStart + 5, openingTagEnd);
    const label = stripMarkup(svgCode.slice(openingTagEnd + 1, closingTagStart)).trim();
    const x = Number.parseFloat(readAttribute(attributes, 'x') || '0');
    const y = Number.parseFloat(readAttribute(attributes, 'y') || '0');
    const estimatedWidth = label.length * 8;
    const left = getTextLeft(x, estimatedWidth, readAttribute(attributes, 'text-anchor'));
    if (left < 0 || left + estimatedWidth > width || y < 0 || y > height) {
      issues.push(`Text may extend beyond the bounds: "${label}".`);
    }
    if (label.split(/\s+/u).length > 6) {
      issues.push(`Label may be too long: "${label}".`);
    }
    textRects.push({
      bottom: y + TEXT_HEIGHT / 2,
      label,
      left,
      right: left + estimatedWidth,
      top: y - TEXT_HEIGHT / 2,
    });
    searchFrom = closingTagStart + '</text>'.length;
  }
  return textRects;
};

const appendOverlapIssues = (textRects: EstimatedTextRect[], issues: string[]): void => {
  for (let firstIndex = 0; firstIndex < textRects.length; firstIndex += 1) {
    const first = textRects[firstIndex];
    if (!first) continue;
    for (const second of textRects.slice(firstIndex + 1)) {
      if (
        first.left < second.right &&
        first.right > second.left &&
        first.top < second.bottom &&
        first.bottom > second.top
      ) {
        issues.push(`Possible overlap between "${first.label}" and "${second.label}".`);
      }
    }
  }
};

export const lintLessonSvg = (svgCode: string): string[] => {
  const { height, width } = readViewBox(svgCode);
  const issues: string[] = [];
  const textRects = collectTextRects(svgCode, height, width, issues);
  appendOverlapIssues(textRects, issues);
  return issues;
};

const renderLessonSvgPreview = (svgCode: string): string => {
  readViewBox(svgCode);
  const png = new Resvg(svgCode, {
    background: '#ffffff',
    fitTo: { mode: 'width', value: SVG_PREVIEW_WIDTH },
  })
    .render()
    .asPng();
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
};

export interface LessonVisualReviewRequest {
  issues: string[];
  preview?: string;
}

export const inspectLessonVisualForReview = ({
  lintSvg = lintLessonSvg,
  renderSvgPreview = renderLessonSvgPreview,
  visual,
}: {
  lintSvg?: (svgCode: string) => string[];
  renderSvgPreview?: (svgCode: string) => string;
  visual: ReviewableLessonVisual;
}): LessonVisualReviewRequest | null => {
  if (visual.kind === 'html') return { issues: [] };
  if (visual.kind !== 'svg') return null;
  const issues = lintSvg(visual.code);
  return issues.length > 0 ? { issues, preview: renderSvgPreview(visual.code) } : null;
};
