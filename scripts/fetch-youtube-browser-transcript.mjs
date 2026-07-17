import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const DEFAULT_SEGMENT_DURATION_SECONDS = 4;
const TRANSCRIPT_BUTTON_SELECTOR =
  'ytd-video-description-transcript-section-renderer button, ytd-video-description-transcript-section-renderer tp-yt-paper-button';
const TRANSCRIPT_SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer';
const DESCRIPTION_EXPANDER_SELECTOR =
  'ytd-text-inline-expander #expand:visible, #description-inline-expander #expand:visible';
const CONSENT_BUTTON_SELECTOR =
  'ytd-consent-bump-v2-lightbox button, ytd-consent-bump-v2-lightbox tp-yt-paper-button';

const readArgument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const parseOptions = () => ({
  authStatePath: readArgument('--auth-state') || process.env.YOUTUBE_BROWSER_AUTH_STATE_PATH,
  captureAuth: process.argv.includes('--capture-auth'),
  executablePath:
    readArgument('--executable') || process.env.YOUTUBE_BROWSER_EXECUTABLE || '/usr/bin/chromium',
  language: readArgument('--language') || 'en',
  videoId: readArgument('--video-id'),
});

export const parseTimestamp = value => {
  const parts = value
    .trim()
    .split(':')
    .map(part => Number.parseInt(part, 10));
  if (parts.some(part => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
};

const waitForEnter = async () => {
  process.stderr.write(
    'Accedi a YouTube nel browser, poi premi Invio qui per salvare la sessione.\n'
  );
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
};

const openContext = async options => {
  if (!existsSync(options.executablePath)) {
    throw new Error(`Chromium non trovato: ${options.executablePath}`);
  }
  const browser = await chromium.launch({
    executablePath: options.executablePath,
    headless: !options.captureAuth,
  });
  return browser.newContext({
    locale: options.language,
    ...(options.authStatePath && existsSync(options.authStatePath)
      ? { storageState: options.authStatePath }
      : {}),
  });
};

const dismissConsent = async page => {
  await page.waitForTimeout(1_500);
  const buttons = page.locator(CONSENT_BUTTON_SELECTOR);
  if ((await buttons.count()) === 0) return;
  const labels = await buttons.allTextContents();
  const rejectButtonIndex = labels.findIndex(label => label.trim().length > 5);
  if (rejectButtonIndex >= 0) {
    await buttons.nth(rejectButtonIndex).click();
  }
};

const captureAuthentication = async (context, page, authStatePath) => {
  if (!authStatePath) {
    throw new Error('Usa --auth-state per indicare dove salvare la sessione.');
  }
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
  await dismissConsent(page);
  await waitForEnter();
  await mkdir(dirname(authStatePath), { recursive: true });
  await context.storageState({ path: authStatePath });
};

const extractTranscript = async (page, videoId, language) => {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', videoId);
  url.searchParams.set('hl', language);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await dismissConsent(page);

  await page.locator('ytd-watch-metadata').waitFor({ state: 'visible', timeout: 15_000 });
  const descriptionExpander = page.locator(DESCRIPTION_EXPANDER_SELECTOR).first();
  await descriptionExpander.waitFor({ state: 'visible', timeout: 15_000 });
  await descriptionExpander.click();
  const transcriptButton = page.locator(TRANSCRIPT_BUTTON_SELECTOR).first();
  await transcriptButton.waitFor({ state: 'visible', timeout: 15_000 });
  await transcriptButton.click();
  await page.locator(TRANSCRIPT_SEGMENT_SELECTOR).first().waitFor({
    state: 'visible',
    timeout: 15_000,
  });

  const rawSegments = await page.locator(TRANSCRIPT_SEGMENT_SELECTOR).evaluateAll(nodes =>
    nodes.map(node => ({
      text: node.querySelector('.segment-text')?.textContent?.trim() || '',
      timestamp: node.querySelector('.segment-timestamp')?.textContent?.trim() || '',
    }))
  );
  const parsed = rawSegments.flatMap(segment => {
    const start = parseTimestamp(segment.timestamp);
    return segment.text && start !== null ? [{ start, text: segment.text }] : [];
  });
  return parsed.map((segment, index) => ({
    duration: Math.max(
      0.1,
      (parsed[index + 1]?.start ?? segment.start + DEFAULT_SEGMENT_DURATION_SECONDS) - segment.start
    ),
    start: segment.start,
    text: segment.text,
  }));
};

const main = async () => {
  const options = parseOptions();
  const context = await openContext(options);
  try {
    const page = await context.newPage();
    if (options.captureAuth) {
      await captureAuthentication(context, page, options.authStatePath);
      return;
    }
    if (!options.videoId) throw new Error('Parametro --video-id mancante.');
    const segments = await extractTranscript(page, options.videoId, options.language);
    process.stdout.write(JSON.stringify([segments]));
  } finally {
    await context.browser()?.close();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Trascrizione browser non disponibile.'}\n`
    );
    process.exitCode = 1;
  });
}
