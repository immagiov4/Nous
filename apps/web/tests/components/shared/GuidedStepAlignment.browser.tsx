import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { renderToStaticMarkup } from 'react-dom/server';
import { withMutedAudio } from '../../../../../scripts/browser-audio';
import { guidedPathScene } from '../../../../backend/tests/helpers/animatedLessonScenes';
import { LessonSceneVisual } from '../../../components/shared/lessonScene/LessonSceneVisual';

const browser = await chromium.launch(withMutedAudio({ headless: true }));
try {
  const page = await browser.newPage();
  const css = await readFile('apps/web/components/shared/lessonScene/lessonScene.css', 'utf8');
  const scene = {
    ...guidedPathScene,
    steps: guidedPathScene.steps.map(step => ({
      ...step,
      label: 'Sostegno ridotto progressivamente durante ogni passaggio',
    })),
  };
  for (const [width, expectedDirection] of [[900, 'column'], [375, 'row']] as const) {
    for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(
        `<style>body { font-family: sans-serif; --bg-paper: ${dark ? '#222' : '#fff'}; --bg-surface: ${dark ? '#111' : '#eee'}; --ink-primary: ${dark ? '#eee' : '#222'}; } ${css}</style><div class="${dark ? 'dark' : ''}">${renderToStaticMarkup(<LessonSceneVisual scene={scene} isDarkMode={dark} />)}</div>`
      );
      assert.equal(await page.locator('.dark .lesson-scene').count(), dark ? 1 : 0);
      if (process.env.SCENE_SCREENSHOT) {
        await mkdir(process.env.SCENE_SCREENSHOT, { recursive: true });
        await page.screenshot({ path: `${process.env.SCENE_SCREENSHOT}/${width}-${dark}.png` });
      }
      const alignment = await page
        .locator('.guided-stop')
        .first()
        .evaluate(stop => {
          const badgeElement = stop.querySelector('.stop-number');
          const label = stop.querySelector('strong');
          if (!badgeElement || !label) throw new Error('Step badge and label must exist');
          const badge = badgeElement.getBoundingClientRect();
          const rect = label.getBoundingClientRect();
          return {
            direction: getComputedStyle(stop).flexDirection,
            text: getComputedStyle(label).textAlign,
            badgeCenter: badge.x + badge.width / 2,
            labelCenter: rect.x + rect.width / 2,
            badgeY: badge.y + badge.height / 2,
            labelY: rect.y + rect.height / 2,
          };
        });
      assert.equal(alignment.direction, expectedDirection, `Step layout at ${width}px`);
      if (expectedDirection === 'column') {
        assert.equal(alignment.badgeCenter, alignment.labelCenter);
        assert.equal(alignment.text, 'center', 'Wrapped label lines must center beneath badge');
      } else {
        assert.equal(alignment.badgeY, alignment.labelY);
        assert.equal(alignment.text, 'left', 'Wrapped mobile labels must stay left-aligned');
      }
    }
  }
} finally {
  await browser.close();
}
