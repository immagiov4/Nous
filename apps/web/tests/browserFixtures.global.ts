import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import type { TestProject } from 'vitest/node';
import { withMutedAudio } from '../../../scripts/browser-audio';
import viteConfig from '../vite.config';

declare module 'vitest' {
  export interface ProvidedContext {
    browserFixtureUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const config = viteConfig({ command: 'serve', mode: 'test' });
  const server = await createServer({
    ...config,
    configFile: false,
    cacheDir: path.resolve('node_modules/.vite/browser-fixtures'),
    root: path.resolve('apps/web'),
    optimizeDeps: {
      entries: ['tests/fixtures/playbackLayout.html', 'tests/fixtures/audio-path.html'],
      include: ['signalsmith-stretch'],
    },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  try {
    await server.listen();
    const baseUrl = server.resolvedUrls?.local[0];
    if (!baseUrl) throw new Error('Browser fixture server must expose a local URL.');
    const browser = await chromium.launch(withMutedAudio({ headless: true }));
    try {
      const page = await browser.newPage();
      // Finish cold optimization and fixture transforms once, before timed suite hooks run.
      await page.goto(`${baseUrl}tests/fixtures/playbackLayout.html?case=prices`);
      await page.locator('.scene-host h2').waitFor();
      await page.goto(`${baseUrl}tests/fixtures/audio-path.html`);
      await page.waitForFunction(() => typeof window.renderUnity === 'function');
    } finally {
      await browser.close();
    }
    project.provide('browserFixtureUrl', baseUrl);
  } catch (error) {
    await server.close();
    throw error;
  }
  return () => server.close();
}
