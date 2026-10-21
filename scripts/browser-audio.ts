import type { LaunchOptions } from 'playwright';

/** Mute host output while leaving page audio available for analysis and recording. */
export function withMutedAudio(options: LaunchOptions = {}): LaunchOptions {
  return {
    ...options,
    args: [...(options.args ?? []).filter(arg => !arg.startsWith('--mute-audio')), '--mute-audio'],
    ignoreDefaultArgs: Array.isArray(options.ignoreDefaultArgs)
      ? options.ignoreDefaultArgs.filter(arg => !arg.startsWith('--mute-audio'))
      : options.ignoreDefaultArgs,
    firefoxUserPrefs: { ...options.firefoxUserPrefs, 'media.volume_scale': '0.0' },
  };
}
