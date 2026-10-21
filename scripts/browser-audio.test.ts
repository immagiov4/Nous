import { describe, expect, it } from 'vitest';
import { withMutedAudio } from './browser-audio';

describe('withMutedAudio', () => {
  it('mutes Chromium, Chrome and Firefox by default', () => {
    expect(withMutedAudio()).toEqual({
      args: ['--mute-audio'],
      ignoreDefaultArgs: undefined,
      firefoxUserPrefs: { 'media.volume_scale': '0.0' },
    });
  });

  it('enforces muting while preserving other launch settings and caller input', () => {
    const options = {
      headless: true,
      channel: 'chrome',
      args: ['--mute-audio=false', '--disable-gpu'],
      ignoreDefaultArgs: ['--mute-audio', '--enable-automation'],
      firefoxUserPrefs: { 'media.volume_scale': '1.0', 'media.autoplay.default': 0 },
    };
    expect(withMutedAudio(options)).toEqual({
      ...options,
      args: ['--disable-gpu', '--mute-audio'],
      ignoreDefaultArgs: ['--enable-automation'],
      firefoxUserPrefs: { 'media.volume_scale': '0.0', 'media.autoplay.default': 0 },
    });
    expect(options.args).toEqual(['--mute-audio=false', '--disable-gpu']);
    expect(options.ignoreDefaultArgs).toEqual(['--mute-audio', '--enable-automation']);
    expect(options.firefoxUserPrefs['media.volume_scale']).toBe('1.0');
  });

  it('keeps explicit muting when all default arguments are disabled', () => {
    expect(withMutedAudio({ ignoreDefaultArgs: true })).toMatchObject({
      args: ['--mute-audio'],
      ignoreDefaultArgs: true,
    });
  });
});
