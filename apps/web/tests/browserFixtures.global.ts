import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, preview } from 'vite';
import type { TestProject } from 'vitest/node';
import viteConfig from '../vite.config';

declare module 'vitest' {
  export interface ProvidedContext {
    browserFixtureUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const output = await realpath(await mkdtemp(path.join(tmpdir(), 'nous-browser-fixtures-')));
  const cleanup = async () => {
    assert.equal(path.dirname(output), await realpath(tmpdir()));
    await rm(output, { recursive: true });
  };
  try {
    const config = viteConfig({ command: 'build', mode: 'test' });
    await build({
      ...config,
      configFile: false,
      logLevel: 'error',
      build: {
        ...config.build,
        outDir: output,
        rollupOptions: {
          input: [
            path.resolve('apps/web/tests/fixtures/playbackLayout.html'),
            path.resolve('apps/web/tests/fixtures/playbackOnset.html'),
            path.resolve('apps/web/tests/fixtures/audio-path.html'),
          ],
        },
      },
    });
    const server = await preview({
      configFile: false,
      root: path.resolve('apps/web'),
      build: { outDir: output },
      preview: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
    });
    try {
      const baseUrl = server.resolvedUrls?.local[0];
      assert(baseUrl, 'Browser fixture server must expose a local URL');
      project.provide('browserFixtureUrl', baseUrl);
    } catch (error) {
      await server.close();
      throw error;
    }
    return async () => {
      try {
        await server.close();
      } finally {
        await cleanup();
      }
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
