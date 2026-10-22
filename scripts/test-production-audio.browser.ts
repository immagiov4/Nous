import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, firefox, type Page } from 'playwright';
import { build, preview } from 'vite';
import { FIXED_AUDIO_SECONDS, fixedAudio } from '../apps/web/tests/fixtures/fixedAudio';
import { segmentLessonPlayback } from '../packages/shared-types/lessonPlayback';
import { withMutedAudio } from './browser-audio';

declare global {
  interface Window {
    audioContractSchedules: { active?: boolean; input?: number; rate?: number }[];
  }
}

const configFile = resolve('apps/web/vite.config.ts');
let workletFailure: string | null = null;
const bytes = Buffer.from(fixedAudio());
const hash = createHash('sha256').update(bytes).digest('hex');
const blocks = segmentLessonPlayback([{ type: 'markdown', markdown: 'Fixed audio sample.' }]).map(
  block => ({
    ...block,
    audio: ['Kore', 'Puck'].map(voice => ({
      voice,
      model: 'local-sample',
      durationSeconds: FIXED_AUDIO_SECONDS,
      asset: { id: hash, hash, byteSize: bytes.length, mediaType: 'audio/wav' },
    })),
  })
);

async function serveRecordings(page: Page) {
  const requestedVoices: string[] = [];
  await page.route('**/api/projects/audio-contract/**', async route => {
    const url = route.request().url();
    if (url.includes('/assets/')) {
      await route.fulfill({ contentType: 'audio/wav', body: bytes });
    } else if (url.endsWith('/prepare')) {
      const { voice } = route.request().postDataJSON();
      requestedVoices.push(voice);
      await route.fulfill({ json: { block: blocks[0], voice, model: 'local-sample' } });
    } else {
      await route.fulfill({ json: { lessonKey: hash, blocks } });
    }
  });
  return requestedVoices;
}

async function advances(page: Page, previous = 0) {
  await page.waitForFunction(previous => {
    const output = document.querySelector('output');
    return (
      output?.textContent === 'playing' && Number(output.getAttribute('data-position')) > previous
    );
  }, previous);
}

async function failsAndRetries(page: Page, url: string, mode: string) {
  workletFailure = mode;
  await page.goto(`${url}?failure=${mode}`);
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('output')?.textContent === 'failed');
  assert.equal(await page.locator('#play').textContent(), 'Retry');
  workletFailure = null;
  await page.locator('#play').click();
  await advances(page);
}

await build({
  configFile,
  build: {
    rollupOptions: {
      input: {
        app: resolve('apps/web/index.html'),
        audio: resolve('apps/web/tests/fixtures/audio-production.html'),
      },
    },
  },
});
const server = await preview({
  configFile,
  preview: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'audio-contract-failures',
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!workletFailure || !request.url?.startsWith('/assets/signalsmithWorklet-'))
            return next();
          response.setHeader('Cache-Control', 'no-store');
          if (workletFailure === 'module-load') {
            response.statusCode = 503;
            response.end();
          } else {
            response.setHeader('Content-Type', 'text/javascript');
            const asset = readFileSync(resolve('apps/web/dist', `.${request.url}`), 'utf8');
            response.end(`Object.defineProperty(globalThis, 'sampleRate', {
              get() { throw new Error('Constructor failure fixture'); }
            });\n${asset}`);
          }
        });
      },
    },
  ],
});
const address = server.httpServer.address();
assert(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/tests/fixtures/audio-production.html`;
const failures: unknown[] = [];
try {
  for (const browserType of [chromium, firefox]) {
    workletFailure = null;
    const browser = await browserType.launch(withMutedAudio({ headless: true }));
    try {
      const page = await browser.newPage();
      const requestedVoices = await serveRecordings(page);
      await page.addInitScript(() => {
        window.audioContractSchedules = [];
        const post = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (message: unknown, ...options: unknown[]) {
          if (Array.isArray(message) && message[1] === 'schedule')
            window.audioContractSchedules.push(message[2]);
          return Reflect.apply(post, this, [message, ...options]);
        };
      });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') console.error(browserType.name(), message.text());
      });
      await page.goto(url);
      await page.locator('#play').click();
      await advances(page);
      await page.locator('#pause').click();
      const pausedPosition = Number(await page.locator('output').getAttribute('data-position'));
      await page.evaluate(() => {
        window.audioContractSchedules = [];
      });
      await page.locator('#play').click();
      await advances(page, pausedPosition);
      assert.equal(await page.evaluate(() => window.audioContractSchedules.at(-1)?.active), true);
      await page.evaluate(() => {
        window.audioContractSchedules = [];
      });
      await page.locator('#seek').click();
      await advances(page);
      assert.equal(await page.evaluate(() => window.audioContractSchedules.at(-1)?.input), 0);
      await page.evaluate(() => {
        window.audioContractSchedules = [];
      });
      await page.locator('#voice').click();
      const beforeVoice = Number(await page.locator('output').getAttribute('data-position'));
      await advances(page, beforeVoice);
      assert(requestedVoices.includes('Puck'));
      assert.equal(await page.evaluate(() => window.audioContractSchedules.at(-1)?.active), true);
      const beforeSpeed = Number(await page.locator('output').getAttribute('data-position'));
      await page.locator('#speed').click();
      await advances(page, beforeSpeed);
      assert.equal(await page.evaluate(() => window.audioContractSchedules.at(-1)?.rate), 2);
      assert.deepEqual(errors, []);
      console.log(`${browserType.name()}: production playback, resume, seek, voice and speed pass`);
      await page.close();
      const failurePage = await browser.newPage();
      await serveRecordings(failurePage);
      await failsAndRetries(failurePage, url, 'module-load');
      console.log(`${browserType.name()}: addModule failure settles and retry advances`);
      await failurePage.close();
      const constructorPage = await browser.newPage();
      await serveRecordings(constructorPage);
      await failsAndRetries(constructorPage, url, 'processor-constructor');
      console.log(
        `${browserType.name()}: processor constructor failure settles and retry advances`
      );
    } catch (error) {
      console.error(`${browserType.name()}:`, error);
      failures.push(error);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
assert.equal(failures.length, 0, 'Production audio must pass in both browsers');
