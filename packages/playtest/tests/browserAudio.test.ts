import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { withMutedAudio } from '../../../scripts/browser-audio';

it('mutes the browser process while page audio remains measurable', async () => {
  const browser = await chromium.launch(
    withMutedAudio({ headless: true, args: ['--enable-automation'] })
  );
  try {
    const session = await browser.newBrowserCDPSession();
    const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
    expect(args).toContain('--mute-audio');
    const page = await browser.newPage();
    const hasAudioSignal = await page.evaluate(async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const analyser = context.createAnalyser();
      // Record into an in-page stream rather than a speaker output.
      oscillator.connect(analyser).connect(context.createMediaStreamDestination());
      oscillator.start();
      await context.resume();
      const samples = new Float32Array(analyser.fftSize);
      await new Promise<void>(resolve => {
        function measure() {
          analyser.getFloatTimeDomainData(samples);
          if (samples.some(sample => sample !== 0)) resolve();
          else requestAnimationFrame(measure);
        }
        measure();
      });
      oscillator.stop();
      await context.close();
      return samples.some(sample => sample !== 0);
    });
    expect(hasAudioSignal).toBe(true);
  } finally {
    await browser.close();
  }
});
