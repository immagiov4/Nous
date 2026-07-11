import { GENERATED_VISUAL_HOST_STYLES } from '../../utils/visuals/generatedVisualHost.ts';

const SVG_WIDTH = 680;
const TEXT_HEIGHT = 18;

interface EstimatedTextRect {
  bottom: number;
  label: string;
  left: number;
  right: number;
  top: number;
}

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Impossibile renderizzare la bozza SVG.'));
    image.src = url;
  });

const getViewBoxHeight = (svgCode: string): number => {
  const match = svgCode.match(/viewBox=["']0\s+0\s+680\s+([\d.]+)["']/i);
  const height = match ? Number.parseFloat(match[1]) : 0;
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error('La bozza SVG non ha una viewBox valida.');
  }
  return height;
};

export const renderSvgPreview = async (svgCode: string): Promise<string> => {
  const height = getViewBoxHeight(svgCode);
  const styledSvg = svgCode.replace(
    /<svg\b([^>]*)>/i,
    `<svg$1><style>${GENERATED_VISUAL_HOST_STYLES}</style>`
  );
  const url = URL.createObjectURL(new Blob([styledSvg], { type: 'image/svg+xml' }));

  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = SVG_WIDTH;
    canvas.height = Math.ceil(height);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas non disponibile per la revisione SVG.');
    }
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
};

export const lintSvg = (svgCode: string): string[] => {
  const document = new DOMParser().parseFromString(svgCode, 'image/svg+xml');
  const svg = document.documentElement;
  const issues: string[] = [];
  const height = getViewBoxHeight(svgCode);
  const textRects: EstimatedTextRect[] = [];

  for (const text of Array.from(svg.querySelectorAll('text'))) {
    const label = text.textContent?.trim() || '';
    const x = Number.parseFloat(text.getAttribute('x') || '0');
    const y = Number.parseFloat(text.getAttribute('y') || '0');
    const estimatedWidth = label.length * 8;
    const anchor = text.getAttribute('text-anchor');
    const left =
      anchor === 'middle' ? x - estimatedWidth / 2 : anchor === 'end' ? x - estimatedWidth : x;

    if (left < 0 || left + estimatedWidth > SVG_WIDTH || y < 0 || y > height) {
      issues.push(`Possibile testo fuori dai bordi: "${label}".`);
    }
    if (label.split(/\s+/).length > 6) {
      issues.push(`Etichetta probabilmente troppo lunga: "${label}".`);
    }
    textRects.push({
      bottom: y + TEXT_HEIGHT / 2,
      label,
      left,
      right: left + estimatedWidth,
      top: y - TEXT_HEIGHT / 2,
    });
  }

  for (let firstIndex = 0; firstIndex < textRects.length; firstIndex += 1) {
    const first = textRects[firstIndex];
    for (const second of textRects.slice(firstIndex + 1)) {
      const overlaps =
        first.left < second.right &&
        first.right > second.left &&
        first.top < second.bottom &&
        first.bottom > second.top;
      if (overlaps) {
        issues.push(`Possibile sovrapposizione tra "${first.label}" e "${second.label}".`);
      }
    }
  }

  return issues;
};
