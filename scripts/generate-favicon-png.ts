import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const FAVICON_SVG_PATH = path.resolve('apps/web/assets/favicon.svg');
const FAVICON_OUT_PATH = path.resolve('apps/web/assets/favicon-32.png');
const APP_ICON_192_OUT = path.resolve('apps/web/public/icons/nous-app-icon-192.png');
const APP_ICON_512_OUT = path.resolve('apps/web/public/icons/nous-app-icon-512.png');
const APP_ICON_MASK_192_OUT = path.resolve('apps/web/public/icons/nous-app-icon-mask-192.png');
const APP_ICON_MASK_512_OUT = path.resolve('apps/web/public/icons/nous-app-icon-mask-512.png');

const PAPER_BG = '#F3EFE6';
const OWL_FILL = '#1F1A14';
// `any` purpose icons are shown as-is (Firefox install, apple-touch-icon).
const PAPER_OWL_SCALE = 0.8;
// Below the 80% maskable safe zone so the owl keeps visible padding
// after the OS applies its circular/squircle mask (Chrome WebAPK install).
const MASKABLE_OWL_SCALE = 0.48;
const VIEWBOX_SIZE = 150;

const faviconSvg = readFileSync(FAVICON_SVG_PATH, 'utf8');
const pathData = [...faviconSvg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(m => m[1]);
if (pathData.length === 0) {
  throw new Error(`No <path d="..."> found in ${FAVICON_SVG_PATH}`);
}

function buildPaperSvg(scale: number): string {
  const offset = (VIEWBOX_SIZE * (1 - scale)) / 2;
  const paths = pathData.map(d => `<path d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}"><rect width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" fill="${PAPER_BG}"/><g fill="${OWL_FILL}" transform="translate(${offset} ${offset}) scale(${scale})">${paths}</g></svg>`;
}

function renderToPng(svg: string, size: number, outPath: string, transparent: boolean): void {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: transparent ? 'rgba(0,0,0,0)' : PAPER_BG,
  });
  const png = resvg.render().asPng();
  writeFileSync(outPath, png);
  console.log(`Wrote ${outPath} (${png.byteLength} bytes, ${size}x${size}).`);
}

renderToPng(faviconSvg, 32, FAVICON_OUT_PATH, true);

const paperSvg = buildPaperSvg(PAPER_OWL_SCALE);
renderToPng(paperSvg, 192, APP_ICON_192_OUT, false);
renderToPng(paperSvg, 512, APP_ICON_512_OUT, false);

const maskableSvg = buildPaperSvg(MASKABLE_OWL_SCALE);
renderToPng(maskableSvg, 192, APP_ICON_MASK_192_OUT, false);
renderToPng(maskableSvg, 512, APP_ICON_MASK_512_OUT, false);
