import { memo, useEffect, useMemo, useRef } from 'react';
import type { LessonGeneratedVisual } from '../../types.ts';
import { isSafeGeneratedImageDataUrl } from '../../utils/visuals/generatedImage.ts';
import { GENERATED_VISUAL_HOST_STYLES } from '../../utils/visuals/generatedVisualHost.ts';
import { findMissingStaticHtmlElementIds } from '../../utils/visuals/htmlElementReferences.ts';

interface GeneratedVisualFrameProps {
  className?: string;
  isDarkMode?: boolean;
  title: string;
  visual: LessonGeneratedVisual;
}

const GENERATED_VISUAL_TRANSPARENT_HOST_OVERRIDE = `
html, body {
  background: transparent !important;
}
/* Strip background from the outermost AI-generated widget wrapper so it
   blends with the transparent iframe instead of creating a visible lighter
   rectangle. Nested containers (shell, card) keep their own backgrounds. */
body > * {
  background: transparent !important;
}
#nous-generated-visual-root,
#nous-generated-visual-root > * {
  background: transparent !important;
}
`;

const GENERATED_VISUAL_ROOT_ID = 'nous-generated-visual-root';

const toSafeScriptJson = (value: string): string => JSON.stringify(value).replace(/<\//g, '<\\/');

const buildGeneratedVisualBootstrapScript = (visual: LessonGeneratedVisual): string => `
const visualCode = ${toSafeScriptJson(visual.code)};
const visualId = ${toSafeScriptJson(visual.id)};
const visualTitle = ${toSafeScriptJson(visual.title)};
const missingStaticElementIds = ${JSON.stringify(findMissingStaticHtmlElementIds(visual.code))};
const root = document.getElementById('${GENERATED_VISUAL_ROOT_ID}');
let hasShownGeneratedVisualError = false;

function showGeneratedVisualError(error) {
  if (hasShownGeneratedVisualError) {
    return;
  }
  hasShownGeneratedVisualError = true;
  const message = error && error.message ? error.message : 'Errore nello script del visuale.';
  const errorDetails = {
    message,
    missingElementIds: missingStaticElementIds,
    stack: error && error.stack ? error.stack : null,
    visualId,
    visualTitle,
  };
  window.parent.postMessage({ type: 'generated-visual-error', error: errorDetails }, '*');
  const warning = document.createElement('div');
  warning.setAttribute('role', 'status');
  warning.style.cssText = 'margin:12px auto;padding:12px 14px;max-width:720px;border:1px solid #fecaca;border-radius:14px;background:#fef2f2;color:#991b1b;font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;';
  const hasRenderedContent = Boolean(root && Array.from(root.children).some(element => !['LINK', 'SCRIPT', 'STYLE'].includes(element.tagName)));
  warning.textContent = hasRenderedContent
    ? "Una parte interattiva dell'artefatto ha avuto un errore. Puoi rigenerarlo o sostituirlo."
    : 'Questo artefatto interattivo non e riuscito a caricarsi. Puoi rigenerarlo o sostituirlo.';
  root?.prepend(warning);
  window.parent.postMessage({ type: 'generated-visual-resize', height: document.body.scrollHeight }, '*');
}

window.addEventListener('error', event => {
  showGeneratedVisualError(event.error || event.message);
});
window.addEventListener('unhandledrejection', event => {
  showGeneratedVisualError(event.reason);
});

function notifyGeneratedVisualReady() {
  window.__nousGeneratedVisualReady = true;
  window.dispatchEvent(new Event('generated-visual-ready'));
}

function replayGeneratedVisualScript(script) {
  return new Promise(resolve => {
    const isExternalScript = Boolean(script.getAttribute('src'));
    const replayedScript = document.createElement('script');
    Array.from(script.attributes).forEach(attribute => {
      replayedScript.setAttribute(attribute.name, attribute.value);
    });
    replayedScript.async = false;
    replayedScript.textContent = script.textContent || '';

    if (isExternalScript) {
      replayedScript.addEventListener('load', () => resolve(), { once: true });
      replayedScript.addEventListener('error', event => {
        showGeneratedVisualError(event.error || event.message || 'Script esterno non caricato.');
        resolve();
      }, { once: true });
    }

    try {
      script.replaceWith(replayedScript);
    } catch (error) {
      showGeneratedVisualError(error);
      resolve();
      return;
    }

    if (!isExternalScript) {
      resolve();
    }
  });
}

async function replayGeneratedVisualScripts(container) {
  const scripts = Array.from(container.querySelectorAll('script'));
  for (const script of scripts) {
    await replayGeneratedVisualScript(script);
  }
}

(async () => {
  try {
    const template = document.createElement('template');
    template.innerHTML = visualCode;
    root?.appendChild(template.content.cloneNode(true));
    if (root) {
      await replayGeneratedVisualScripts(root);
    }
  } catch (error) {
    showGeneratedVisualError(error);
  } finally {
    notifyGeneratedVisualReady();
  }
})();
`;

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
  const match = normalizeColor(value).match(
    /^rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:[,/\\s]+([\\d.]+%?))?/
  );
  if (!match) {
    return null;
  }

  const alpha = match[4]?.endsWith('%')
    ? Number.parseFloat(match[4]) / 100
    : match[4]
      ? Number.parseFloat(match[4])
      : 1;

  if (Number.isFinite(alpha) && alpha <= 0.05) {
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
function getLuminance(rgb) {
  const [r, g, b] = rgb;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
function isDarkReadableLightModeText(value) {
  const rgb = parseColor(value);
  if (!rgb) {
    return false;
  }

  return getLuminance(rgb) < 0.38;
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
  const luminance = getLuminance(rgb);
  const channelSpread = Math.max(r, g, b) - Math.min(r, g, b);
  return luminance > 0.82 && channelSpread < 34;
}
function isBrightLightModeSurface(value) {
  const rgb = parseColor(value);
  if (!rgb) {
    return false;
  }

  return getLuminance(rgb) > 0.72;
}
function isLightText(value) {
  const rgb = parseColor(value);
  if (!rgb) {
    return false;
  }

  return getLuminance(rgb) > 0.62;
}
function toDarkSurfaceColor(value) {
  const rgb = parseColor(value);
  if (!rgb) {
    return 'var(--bg-surface)';
  }

  const [r, g, b] = rgb;
  const channelSpread = Math.max(r, g, b) - Math.min(r, g, b);
  if (channelSpread < 34) {
    return 'var(--bg-surface)';
  }

  return 'rgb(' + Math.round(r * 0.26) + ', ' + Math.round(g * 0.26) + ', ' + Math.round(b * 0.26) + ')';
}
function readCssColor(element, property) {
  const explicitValue = element.style.getPropertyValue(property);
  if (explicitValue) {
    return normalizeColor(explicitValue);
  }

  return normalizeColor(window.getComputedStyle(element).getPropertyValue(property));
}
function writeCssColor(element, property, value) {
  element.style.setProperty(property, value, 'important');
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
    } else if (isBrightLightModeSurface(fill)) {
      writePaint(element, 'fill', toDarkSurfaceColor(fill));
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
    } else if (isBrightLightModeSurface(fill)) {
      writePaint(element, 'fill', toDarkSurfaceColor(fill));
    }
    if (connectorStrokes.has(stroke) || isDarkReadableLightModeText(stroke)) {
      writePaint(element, 'stroke', 'var(--ink-secondary)');
    }
  });
}
function normalizeDarkHtmlTheme() {
  if (!isDarkHost) {
    return;
  }

  document.body
    .querySelectorAll(':scope *:not(svg):not(svg *):not(script):not(style)')
    .forEach(element => {
      const backgroundColor = readCssColor(element, 'background-color');
      const color = readCssColor(element, 'color');
      const borderColor = readCssColor(element, 'border-color');
      const hasBrightBackground = isBrightLightModeSurface(backgroundColor);

      if (hasBrightBackground) {
        writeCssColor(element, 'background-color', toDarkSurfaceColor(backgroundColor));
      }

      if (hasBrightBackground || isDarkReadableLightModeText(color) || isLightText(color)) {
        writeCssColor(element, 'color', 'var(--ink-primary)');
      }

      if (isBrightLightModeSurface(borderColor) || isDarkReadableLightModeText(borderColor)) {
        writeCssColor(element, 'border-color', 'var(--border-strong)');
      }
    });
}
function normalizeContent() {
  removeOuterSvgBackgrounds();
  normalizeDarkSvgTheme();
  normalizeDarkHtmlTheme();
}
let lastReportedHeight = 0;
function updateHeight() {
  const body = document.body;
  const childBottom = Array.from(body.children).reduce((bottom, child) => {
    const rect = child.getBoundingClientRect();
    return Math.max(bottom, rect.bottom);
  }, 0);
  const height = Math.ceil(Math.max(childBottom, body.scrollHeight, body.offsetHeight));
  // Dedup: stop the resize-observer feedback loop where setting the parent
  // iframe height triggers a body reflow that re-fires the observer.
  if (Math.abs(height - lastReportedHeight) <= 1) return;
  lastReportedHeight = height;
  window.parent.postMessage({ type: 'generated-visual-resize', height }, '*');
}
function normalizeAndMeasure() {
  normalizeContent();
  updateHeight();
}
window.addEventListener('load', normalizeAndMeasure);
window.addEventListener('generated-visual-ready', normalizeAndMeasure);
const resizeObserver = new ResizeObserver(updateHeight);
resizeObserver.observe(document.body);
document.querySelectorAll('svg, canvas, .mermaid').forEach(element => resizeObserver.observe(element));
window.addEventListener('resize', updateHeight);
if (window.__nousGeneratedVisualReady) {
  setTimeout(normalizeAndMeasure, 0);
}
setTimeout(normalizeAndMeasure, 100);
setTimeout(normalizeAndMeasure, 500);
setTimeout(normalizeAndMeasure, 1500);
`;

const buildMermaidHost = (visual: LessonGeneratedVisual, isDarkMode: boolean): string => `
<!DOCTYPE html>
<html class="${isDarkMode ? 'dark' : ''}">
  <head>
    <meta charset="utf-8">
    <style>${GENERATED_VISUAL_HOST_STYLES}
      body { padding: 0; }
      .mermaid { display: flex; justify-content: center; }
      ${GENERATED_VISUAL_TRANSPARENT_HOST_OVERRIDE}
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

export const buildVisualHost = (visual: LessonGeneratedVisual, isDarkMode: boolean): string => `
<!DOCTYPE html>
<html class="${isDarkMode ? 'dark' : ''}">
  <head>
    <meta charset="utf-8">
    <style>${GENERATED_VISUAL_HOST_STYLES}</style>
  </head>
  <body>
    <div id="${GENERATED_VISUAL_ROOT_ID}"></div>
    <style>${GENERATED_VISUAL_TRANSPARENT_HOST_OVERRIDE}</style>
    <script>${buildGeneratedVisualBootstrapScript(visual)}</script>
    <script>${RESIZE_SCRIPT}</script>
  </body>
</html>`;

const GeneratedVisualFrame = ({
  className = 'my-10',
  isDarkMode = false,
  title,
  visual,
}: GeneratedVisualFrameProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostDocument = useMemo(() => {
    if (visual.kind === 'image') {
      return '';
    }

    return visual.kind === 'mermaid'
      ? buildMermaidHost(visual, isDarkMode)
      : buildVisualHost(visual, isDarkMode);
  }, [isDarkMode, visual]);

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
        return;
      }

      if (event.data?.type === 'generated-visual-error') {
        console.error('[Nous] Generated visual runtime error', event.data.error);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  if (visual.kind === 'image') {
    const imageAltText =
      visual.altText?.trim() || visual.title.replace(/[_-]+/g, ' ').trim() || title;

    return (
      <figure className={`${className} overflow-hidden bg-transparent`} data-nous-speech="ignore">
        {isSafeGeneratedImageDataUrl(visual.code) ? (
          <img
            src={visual.code}
            alt={imageAltText}
            className="mx-auto block max-h-[72dvh] w-full rounded-[1.2rem] object-contain"
            decoding="async"
            loading="lazy"
          />
        ) : (
          <output className="block rounded-2xl border border-stone-200 bg-stone-50 px-4 py-8 text-center text-sm text-stone-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
            Immagine non disponibile
          </output>
        )}
      </figure>
    );
  }

  return (
    <figure className={`${className} overflow-hidden bg-transparent`} data-nous-speech="ignore">
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
