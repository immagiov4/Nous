import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findLessonSceneProblems, type LessonScene } from '@shared/lessonScene';
import { devices, type Locator } from 'playwright';
import { unavailableCourseGenerationApi } from '../../../apps/backend/src/workflows/courseGenerationApi';
import { UI_PREFERENCES_KEY } from '../../../apps/web/services/preferences/uiPreferencesStorage';
import { dataRoot, withMemoryProjectBrowserStack } from '../stack';
import { syntheticCourse } from '../syntheticCourse';

const base = { body: '', items: [], groups: [], quote: '', note: '' };
const matrix = (title: string, items: string[][]): LessonScene => ({
  ...base,
  title,
  type: 'matrix',
  criteria: ['Avvio', 'Controllo'],
  groups: items.map((cells, index) => ({
    label: ['Stampo', 'Tornio'][index],
    items: cells,
    icon: '',
    icons: cells.map(() => ''),
  })),
});
const scenes: LessonScene[] = [
  matrix('Produzione in ceramica', [
    [
      'La miscela viene versata nello stampo e lasciata asciugare prima di estrarre il pezzo.',
      'Ogni stampo ripete la forma iniziale. La consistenza della miscela determina quanto bene si riproducono i dettagli.',
    ],
    [
      'La persona al tornio centra l’argilla e regola l’acqua mentre modella le pareti.',
      'Lo spessore va verificato durante tutta la lavorazione perché piccole variazioni cambiano il risultato.',
    ],
  ]),
  matrix('Confronto breve', [
    ['Stampo pronto', 'Forma fissa'],
    ['Argilla centrata', 'Forma libera'],
  ]),
  {
    ...base,
    title: 'Accesso all’archivio',
    type: 'security',
    columns: ['Amministratore', 'Redattore', 'Ospite'],
    rows: [
      { label: 'Dati aggregati', values: ['Modifica', 'Pubblicazione', 'Sola lettura'] },
      { label: 'Configurazione', values: ['Gestione', 'Nessun accesso', 'Nessun accesso'] },
    ],
  },
  {
    ...base,
    title: 'Esiti della verifica',
    type: 'heatmap',
    unit: 'casi',
    max: 10,
    columns: ['API', 'Servizio', 'Archivio'],
    rows: [
      { label: 'Successo', values: [10, 8, 6] },
      { label: 'Errore', values: [6, 9, 4] },
      { label: 'Ripetizione', values: [0, 7, 8] },
    ],
  },
];

async function inspectTable(table: Locator) {
  return table.evaluate(element => {
    const table = element as HTMLTableElement;
    const wrapper = table.parentElement as HTMLElement;
    const cells = Array.from(table.rows).flatMap(row => Array.from(row.cells));
    const context = document.createElement('canvas').getContext('2d');
    if (!context) throw new Error('Contrast measurement requires a canvas context.');
    function luminance(...colors: string[]) {
      context?.clearRect(0, 0, 1, 1);
      for (const color of colors) {
        if (!context) throw new Error('Missing color context.');
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
      }
      const channels = context?.getImageData(0, 0, 1, 1).data.slice(0, 3) ?? [];
      const weights = [0.2126, 0.7152, 0.0722];
      return Array.from(channels).reduce((total, channel, index) => {
        const linear = channel / 255;
        return (
          total +
          weights[index] * (linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4)
        );
      }, 0);
    }
    function contrast(first: number, second: number) {
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    }
    function brokenWords(cell: HTMLTableCellElement) {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const broken: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const word of (node.textContent ?? '').matchAll(/\p{L}+/gu)) {
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          if (range.getClientRects().length > 1) broken.push(word[0]);
        }
      }
      return broken;
    }
    const dataCells = cells.filter(
      cell => cell.parentElement?.parentElement?.tagName === 'TBODY' && cell.tagName === 'TD'
    );
    const paper = getComputedStyle(table).getPropertyValue('--surface');
    const backgrounds = dataCells.map(cell =>
      luminance(paper, getComputedStyle(cell).backgroundColor)
    );
    const marks = dataCells.map(cell =>
      cell.querySelector<HTMLElement>('span[aria-hidden="true"]')
    );
    return {
      width: wrapper.clientWidth,
      scrollWidth: wrapper.scrollWidth,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      rowHeight: Math.max(
        ...Array.from(table.tBodies[0].rows, row => row.getBoundingClientRect().height)
      ),
      columns: Array.from(table.rows[0].cells)
        .slice(1)
        .map(cell => [cell.scope, cell.textContent]),
      rows: Array.from(table.tBodies[0].rows, row =>
        Array.from(row.cells, cell => [cell.scope, cell.textContent])
      ),
      brokenWords: cells.flatMap(brokenWords),
      scale: table.caption?.textContent ?? null,
      marks: marks.map(mark => {
        const fill = mark?.firstElementChild;
        if (!fill || !mark) return null;
        const trackWidth = mark.getBoundingClientRect().width;
        const fillWidth = fill.getBoundingClientRect().width;
        return {
          portion: fillWidth / trackWidth,
          fillWidth,
          trackWidth,
          contrast: contrast(luminance(getComputedStyle(fill).backgroundColor), luminance(paper)),
        };
      }),
      adjacentBackgroundContrast: contrast(backgrounds[0], backgrounds[1]),
      worstTextContrast: Math.min(
        ...dataCells.map((cell, index) =>
          contrast(backgrounds[index], luminance(getComputedStyle(cell).color))
        )
      ),
    };
  });
}

const evidence = dataRoot();
await mkdir(evidence, { recursive: true });
const recordVideo = process.argv.includes('--video');
const userId = 'matrix-reader-proof';
const project = syntheticCourse();
const lesson = project.learningPlan?.modules?.[0]?.children?.[0];
assert(lesson?.kind === 'lesson');
const lessonText =
  'Le tabelle confrontano lavorazioni, autorizzazioni ed esiti. Su una scala da 0 a 10 casi, API, servizio e archivio hanno rispettivamente 10, 8 e 6 successi, 6, 9 e 4 errori e 0, 7 e 8 ripetizioni.';
lesson.content = lessonText;
const visuals = scenes.map((scene, index) => {
  assert.deepEqual(findLessonSceneProblems(scene, lessonText), [], scene.title);
  const id = `table-${index}`;
  const slotId = `slot-${index}`;
  return { id, slotId, createdAt: new Date(0).toISOString(), render: { kind: 'scene', scene } };
});
lesson.generatedVisuals = visuals;
lesson.contentBlocks = [
  { type: 'markdown', markdown: lessonText },
  ...visuals.map(({ id, slotId }) => ({
    type: 'generated-visual',
    slotId,
    visualId: id,
  })),
];
if (recordVideo) await writeFile(join(evidence, 'project.json'), JSON.stringify(project));

const failures: string[] = [];
const results: object[] = [];
await withMemoryProjectBrowserStack(
  {
    userId,
    appOptions: {
      courseGenerationApi: { ...unavailableCourseGenerationApi, getActive: async () => null },
    },
  },
  async ({ page, store, url }) => {
    const browser = page.context().browser();
    assert(browser);
    await store.saveProject(userId, project);
    for (const mobile of [false, true]) {
      for (const dark of [false, true]) {
        const label = `${mobile ? 'phone' : 'desktop'}-${dark ? 'dark' : 'light'}`;
        const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
        const context = await browser.newContext({
          ...(mobile ? devices['Pixel 7'] : {}),
          viewport,
          ...(recordVideo ? { recordVideo: { dir: evidence, size: viewport } } : {}),
          deviceScaleFactor: 1,
          locale: 'it-IT',
          colorScheme: dark ? 'dark' : 'light',
          reducedMotion: 'reduce',
        });
        await context.route(/\/api\/(openrouter|images)\//u, route =>
          route.fulfill({ status: 503, body: '{}' })
        );
        await context.addInitScript(
          ({ url, dark, preferenceKey }) => {
            Object.assign(globalThis, {
              __NOUS_RUNTIME_CONFIG__: { authMode: 'local-bypass', backendUrl: url },
            });
            localStorage.setItem(preferenceKey, JSON.stringify({ isDarkMode: dark }));
          },
          { url, dark, preferenceKey: UI_PREFERENCES_KEY }
        );
        await context.tracing.start({ screenshots: true, snapshots: true });
        try {
          const reader = await context.newPage();
          reader.on('pageerror', error => failures.push(`${label}: ${error.message}`));
          const startedAt = performance.now();
          await reader.goto(`${url}/?project=${project.id}`);
          const tables = reader.locator('.lesson-scene table');
          await tables.last().waitFor();
          const readerReadyMs = performance.now() - startedAt;
          assert.equal(await tables.count(), scenes.length);
          assert.equal(await reader.locator('html.dark').count(), Number(dark));
          await reader.evaluate(() => document.fonts.ready);
          const metrics = [];
          for (const [index, scene] of scenes.entries()) {
            const table = tables.nth(index);
            const figure = table.locator('xpath=ancestor::figure');
            await figure.screenshot({ path: join(evidence, `${label}-${index}.png`) });
            const observed = await inspectTable(table);
            metrics.push(observed);
            if (recordVideo) await reader.waitForTimeout(2500);
            const columns = scene.columns ?? scene.groups.map(group => group.label);
            const rows =
              scene.rows ??
              (scene.criteria ?? []).map((criterion, row) => ({
                label: criterion,
                values: scene.groups.map(group => group.items[row]),
              }));
            assert.deepEqual(
              observed.columns,
              columns.map(column => ['col', column])
            );
            assert.deepEqual(
              observed.rows,
              rows.map(row => [['row', row.label], ...row.values.map(value => ['', String(value)])])
            );
            assert(observed.pageWidth <= observed.viewportWidth, `${label}: page overflow`);
            if (observed.scrollWidth > observed.width && scene.type !== 'heatmap') {
              const wrapper = table.locator('..');
              const row = table.getByRole('rowheader').first();
              const beforeScroll = await row.boundingBox();
              assert(beforeScroll);
              await wrapper.press('ArrowRight');
              await reader.waitForFunction(
                name =>
                  Array.from(document.querySelectorAll('section')).some(
                    section => section.getAttribute('aria-label') === name && section.scrollLeft > 0
                  ),
                scene.title
              );
              const lastHeading = table.getByRole('columnheader').last();
              await lastHeading.scrollIntoViewIfNeeded();
              const afterScroll = await row.boundingBox();
              assert(afterScroll);
              assert.equal(Math.round(afterScroll.x), Math.round(beforeScroll.x));
              await figure.screenshot({ path: join(evidence, `${label}-${index}-end.png`) });
              if (recordVideo) await reader.waitForTimeout(2500);
            }
          }
          const [dense, compact, security, heatmap] = metrics;
          if (compact.width !== compact.scrollWidth)
            failures.push(`${label}: compact table scrolls`);
          if (dense.brokenWords.length || compact.brokenWords.length)
            failures.push(`${label}: broken matrix text`);
          if (mobile && dense.width === dense.scrollWidth)
            failures.push(`${label}: dense table squeezes both alternatives into view`);
          if (security.brokenWords.length)
            failures.push(`${label}: split permission terms: ${security.brokenWords.join(', ')}`);
          if (heatmap.scale !== '0–10 casi')
            failures.push(`${label}: missing heatmap scale or unit`);
          const [ten, eight] = heatmap.marks;
          if (!ten || !eight || eight.fillWidth >= ten.fillWidth) {
            failures.push(`${label}: 8 and 10 lack distinct rendered lengths`);
          } else {
            const values = scenes[3].rows?.flatMap(row => row.values) ?? [];
            assert.deepEqual(
              heatmap.marks.map(mark => Number(mark?.portion.toFixed(2))),
              values.map(value => Number(value) / 10)
            );
            assert(heatmap.marks.every(mark => mark && mark.trackWidth === ten.trackWidth));
            assert(heatmap.marks.every(mark => mark && mark.contrast >= 3));
          }
          assert(heatmap.worstTextContrast >= 4.5, `${label}: heatmap numbers fail text contrast`);
          await reader.reload();
          await tables.last().waitFor();
          assert.deepEqual((await inspectTable(tables.last())).rows, heatmap.rows);
          results.push({ label, readerReadyMs, metrics });
        } finally {
          await context.tracing.stop({ path: join(evidence, `${label}.zip`) });
          const video = context.pages()[0]?.video();
          await context.close();
          await video?.saveAs(join(evidence, `${label}.webm`));
        }
      }
    }
  }
);
await writeFile(join(evidence, 'result.json'), JSON.stringify({ failures, results }, null, 2));
assert.deepEqual(failures, []);
