import { memo, useEffect, useMemo, useRef } from 'react';
import type { LessonGeneratedVisual } from '../../types.ts';
import { GENERATED_VISUAL_HOST_STYLES } from '../../utils/visuals/generatedVisualHost.ts';

interface GeneratedVisualFrameProps {
  isDarkMode?: boolean;
  title: string;
  visual: LessonGeneratedVisual;
}

const RESIZE_SCRIPT = `
const isDarkHost = document.documentElement.classList.contains('dark');
const darkTextFills = new Set([
  '#000', '#000000', '#111', '#111111', '#1f1f1f', '#1e293b',
  '#0f172a', '#172033', '#1d283d', '#21304a', '#24364f',
  '#2d3f5c', '#334155', '#374151', '#4a4a4a', '#555', '#555555'
]);
const paleFills = new Set([
  'white', '#fff', '#ffffff', '#f8f8f8', '#f4f4f4', '#f3f4f6',
  '#f1f5f9', '#f9fafb', '#fafafa', '#e5e7eb', '#e2e8f0',
  '#f5f5f4', '#f4efe6', '#eee7da'
]);
const connectorStrokes = new Set([
  '#888', '#888888', '#999', '#999999', '#94a3b8', '#64748b',
  '#718096', '#6b7280', '#7b8798', '#8090aa', '#8a98ad'
]);

function normalizeColor(value) {
  return (value || '').trim().toLowerCase();
}
function readPaint(element, property) {
  const explicitValue = element.style.getPropertyValue(property) || element.getAttribute(property);
  if (explicitValue) {
    return normalizeColor(explicitValue);
  }

  return normalizeColor(window.getComputedStyle(element).getPropertyValue(property));
}
function writePaint(element, property, value) {
  element.setAttribute(property, value);
  element.style.setProperty(property, value, 'important');
}
function parseHexColor(value) {
  const color = normalizeColor(value);
  if (!color.startsWith('#')) {
    return null;
  }

  if (color.length === 4) {
    const r = Number.parseInt(color[1] + color[1], 16);
    const g = Number.parseInt(color[2] + color[2], 16);
    const b = Number.parseInt(color[3] + color[3], 16);
    return [r, g, b];
  }

  if (color.length === 7) {
    const r = Number.parseInt(color.slice(1, 3), 16);
    const g = Number.parseInt(color.slice(3, 5), 16);
    const b = Number.parseInt(color.slice(5, 7), 16);
    return [r, g, b];
  }

  return null;
}
function parseRgbColor(value) {
  const match = normalizeColor(value).match(/^rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/);
  if (!match) {
    return null;
  }

  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}
function parseColor(value) {
  return parseHexColor(value) || parseRgbColor(value);
}
function isDarkReadableLightModeText(value) {
  const rgb = parseColor(value);
  if (!rgb) {
    return false;
  }

  const [r, g, b] = rgb;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.38;
}
function isPaleLightModeFill(value) {
  const color = normalizeColor(value);
  if (paleFills.has(color)) {
    return true;
  }

  const rgb = parseColor(color);
  if (!rgb) {
    return false;
  }

  const [r, g, b] = rgb;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const channelSpread = Math.max(r, g, b) - Math.min(r, g, b);
  return luminance > 0.82 && channelSpread < 34;
}

function removeOuterSvgBackgrounds() {
  document.querySelectorAll('svg').forEach(svg => {
    const viewBox = svg.viewBox?.baseVal;
    const canvasWidth = viewBox?.width || 680;
    const canvasHeight = viewBox?.height || 0;
    Array.from(svg.children).forEach(child => {
      if (child.tagName.toLowerCase() !== 'rect') {
        return;
      }

      const rect = child;
      const x = rect.getAttribute('x') || '0';
      const y = rect.getAttribute('y') || '0';
      const width = rect.getAttribute('width') || '';
      const height = rect.getAttribute('height') || '';
      const fill = readPaint(rect, 'fill');
      const isWhiteFill = fill === 'white' || fill === '#fff' || fill === '#ffffff';
      const coversWidth = width === '100%' || Number.parseFloat(width) >= canvasWidth - 1;
      const coversHeight =
        height === '100%' || (canvasHeight > 0 && Number.parseFloat(height) >= canvasHeight - 1);

      if (x === '0' && y === '0' && isWhiteFill && coversWidth && coversHeight) {
        rect.remove();
      }
    });
  });
}
function normalizeDarkSvgTheme() {
  if (!isDarkHost) {
    return;
  }

  document.querySelectorAll('svg text, svg tspan').forEach(element => {
    const fill = readPaint(element, 'fill');
    const usesHostTextClass =
      element.classList.contains('t') ||
      element.classList.contains('ts') ||
      element.classList.contains('th');
    if (
      (!fill && !usesHostTextClass) ||
      fill === 'none' ||
      fill === 'currentcolor' ||
      darkTextFills.has(fill) ||
      isDarkReadableLightModeText(fill)
    ) {
      writePaint(element, 'fill', 'var(--ink-primary)');
    }
  });

  document.querySelectorAll('svg rect, svg circle, svg ellipse').forEach(element => {
    const fill = readPaint(element, 'fill');
    const stroke = readPaint(element, 'stroke');
    if (isPaleLightModeFill(fill)) {
      writePaint(element, 'fill', 'var(--bg-surface)');
    }
    if (connectorStrokes.has(stroke) || isDarkReadableLightModeText(stroke)) {
      writePaint(element, 'stroke', 'var(--border-strong)');
    }
  });

  document.querySelectorAll('svg path, svg polygon, svg polyline, svg line').forEach(element => {
    const fill = readPaint(element, 'fill');
    const stroke = readPaint(element, 'stroke');
    if (isPaleLightModeFill(fill)) {
      writePaint(element, 'fill', 'var(--bg-paper)');
    }
    if (connectorStrokes.has(stroke) || isDarkReadableLightModeText(stroke)) {
      writePaint(element, 'stroke', 'var(--ink-secondary)');
    }
  });
}
function updateHeight() {
  removeOuterSvgBackgrounds();
  normalizeDarkSvgTheme();
  const body = document.body;
  const childBottom = Array.from(body.children).reduce((bottom, child) => {
    const rect = child.getBoundingClientRect();
    return Math.max(bottom, rect.bottom);
  }, 0);
  const height = Math.ceil(Math.max(childBottom, body.scrollHeight, body.offsetHeight));
  window.parent.postMessage({ type: 'generated-visual-resize', height }, '*');
}
window.addEventListener('load', updateHeight);
const resizeObserver = new ResizeObserver(updateHeight);
resizeObserver.observe(document.body);
document.querySelectorAll('svg, canvas, .mermaid').forEach(element => resizeObserver.observe(element));
window.addEventListener('resize', updateHeight);
setTimeout(updateHeight, 100);
setTimeout(updateHeight, 500);
setTimeout(updateHeight, 1500);
`;

const buildMermaidHost = (visual: LessonGeneratedVisual, isDarkMode: boolean): string => `
<!DOCTYPE html>
<html class="${isDarkMode ? 'dark' : ''}">
  <head>
    <meta charset="utf-8">
    <style>${GENERATED_VISUAL_HOST_STYLES}
      body { padding: 0; }
      .mermaid { display: flex; justify-content: center; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  </head>
  <body>
    <div class="mermaid"></div>
    <script>
      const diagramCode = ${JSON.stringify(visual.code)};
      document.querySelector('.mermaid').textContent = diagramCode;
      mermaid.initialize({ startOnLoad: true, securityLevel: 'strict', theme: ${JSON.stringify(
        isDarkMode ? 'dark' : 'default'
      )} });
    </script>
    <script>${RESIZE_SCRIPT}</script>
  </body>
</html>`;

const buildVisualHost = (visual: LessonGeneratedVisual, isDarkMode: boolean): string => `
<!DOCTYPE html>
<html class="${isDarkMode ? 'dark' : ''}">
  <head>
    <meta charset="utf-8">
    <style>${GENERATED_VISUAL_HOST_STYLES}</style>
  </head>
  <body>
    ${visual.code}
    <script>${RESIZE_SCRIPT}</script>
  </body>
</html>`;

const GeneratedVisualFrame = ({ isDarkMode = false, title, visual }: GeneratedVisualFrameProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostDocument = useMemo(
    () =>
      visual.kind === 'mermaid'
        ? buildMermaidHost(visual, isDarkMode)
        : buildVisualHost(visual, isDarkMode),
    [isDarkMode, visual]
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (iframeRef.current?.contentWindow !== event.source) {
        return;
      }

      if (event.data?.type === 'generated-visual-resize') {
        const nextHeight = Math.max(Number(event.data.height) || 0, 180);
        const currentHeight = Number.parseFloat(iframeRef.current.style.height || '0');
        if (Math.abs(currentHeight - nextHeight) > 1) {
          iframeRef.current.style.height = `${nextHeight}px`;
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <figure className="my-10 overflow-hidden bg-transparent" data-nous-speech="ignore">
      <iframe
        key={`${visual.id}-${visual.kind}-${isDarkMode ? 'dark' : 'light'}`}
        ref={iframeRef}
        title={title}
        className="block w-full border-0 bg-transparent"
        sandbox="allow-scripts allow-forms"
        srcDoc={hostDocument}
        scrolling="no"
        style={{ minHeight: visual.kind === 'html' ? 240 : 180, overflow: 'hidden' }}
      />
    </figure>
  );
};

export default memo(GeneratedVisualFrame);
