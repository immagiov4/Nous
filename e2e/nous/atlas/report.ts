import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { AtlasFinding, Position } from './checks';

/** Run directories protect renderer assets too; explicit file modes also protect copied evidence. */
export async function writeAtlasArtifact(path: string, content: string | Uint8Array) {
  await writeFile(path, content, { mode: 0o600 });
}

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export interface AtlasTile {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseId: string;
  courseTitle: string;
  blockId: string;
  visualIndex: number | null;
  position: Position;
  viewport: string;
  viewportSize: { width: number; height: number };
  image: string;
  html: string;
  sheet: string;
  caption: string;
  speech: string;
  findings: AtlasFinding[];
  metrics: unknown;
  incomplete: boolean;
  sheetBox?: { x: number; y: number; width: number; height: number };
}
const visualLabel = (index: number | null) =>
  index === null ? 'production selection' : `isolated visual ${index}`;

export const THRESHOLD_DECISIONS = [
  {
    metric: 'speechPunctuationTokens',
    decision:
      'Which standalone punctuation or symbol tokens are orphaned rather than intentional; raw tokens do not fail a run.',
  },
  {
    metric: 'visibleCharacters / visibleWords',
    decision: 'When nonzero textual content is too sparse.',
  },
  { metric: 'minFontPx / sceneScale', decision: 'When fitted content becomes too small to read.' },
  {
    metric: 'canvasPixels',
    decision:
      'When a nonempty canvas has insufficient meaningful content; alpha alone cannot establish meaning.',
  },
  { metric: 'renderMs', decision: 'When rendering is too slow on a specified machine.' },
];

/** One production block or isolated visual per sheet: memory is bounded by the requested positions. */
export async function writeAtlasSheet(
  page: Page,
  directory: string,
  tiles: AtlasTile[],
  pngs: Buffer[]
) {
  const figures = tiles
    .map(
      (tile, index) => `<figure id="${escapeHtml(tile.id)}">
<figcaption>${escapeHtml(tile.lessonTitle)} · block ${escapeHtml(tile.blockId)} · ${visualLabel(tile.visualIndex)} · ${tile.position} · ${tile.viewport}</figcaption>
<img width="${tile.viewportSize.width}" src="data:image/png;base64,${pngs[index].toString('base64')}" alt="">
<p>${escapeHtml(tile.caption)}</p><details><summary>Speech</summary><p>${escapeHtml(tile.speech)}</p></details></figure>`
    )
    .join('');
  await page.setViewportSize({
    width: tiles[0].viewportSize.width * tiles.length,
    height: tiles[0].viewportSize.height,
  });
  const document = `<!doctype html><html><head><meta charset="utf-8"><title>Playback atlas</title><style>
body{margin:0;font-family:system-ui;background:white;color:black}main{display:flex;align-items:flex-start}figure{margin:0;flex:1;min-width:0}figcaption,p{padding:1em;margin:0;overflow-wrap:anywhere}img{display:block;width:100%;height:auto}
</style></head><body><main>${figures}</main></body></html>`;
  await page.setContent(document);
  await page.locator('img').evaluateAll(async images => {
    await Promise.all(images.map(image => (image as HTMLImageElement).decode()));
  });
  const boxes = await page.locator('figure').evaluateAll(elements =>
    elements.map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    })
  );
  tiles.forEach((tile, index) => {
    tile.sheetBox = boxes[index];
  });
  await writeAtlasArtifact(
    join(directory, tiles[0].sheet),
    await page.screenshot({ fullPage: true })
  );
  let localDocument = document;
  pngs.forEach((png, index) => {
    localDocument = localDocument.replace(
      `data:image/png;base64,${png.toString('base64')}`,
      tiles[index].image
    );
  });
  await writeAtlasArtifact(join(directory, tiles[0].html), localDocument);
}

export async function writeAtlasIndex(directory: string, tiles: AtlasTile[]) {
  const sheets = Array.from(new Map(tiles.map(tile => [tile.sheet, tile])).values());
  const links = sheets
    .map(
      tile =>
        `<li><a href="${escapeHtml(tile.html)}">${escapeHtml(tile.courseTitle)} / ${escapeHtml(tile.lessonTitle)} · block ${escapeHtml(tile.blockId)} · ${tile.viewport} · ${visualLabel(tile.visualIndex)}</a></li>`
    )
    .join('');
  await writeAtlasArtifact(
    join(directory, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Playback visual atlas</title></head><body><h1>Playback visual atlas</h1><p>Private local evidence. Captions beneath each tile transcribe the production caption DOM, including when the mobile stage hides it.</p><p><a href="report.json">Structural findings and raw measurements</a></p><ul>${links}</ul></body></html>`
  );
}
