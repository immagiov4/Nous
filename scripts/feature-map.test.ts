import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import {
  buildFeatureMap,
  discoverBackendRoutes,
  extractImportEdges,
  renderFeatureMapMarkdown,
} from './feature-map.ts';

const temporaryDirectories: string[] = [];
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
let featureMap: Awaited<ReturnType<typeof buildFeatureMap>>;
let observationDirectory: string;

beforeAll(async () => {
  observationDirectory = await mkdtemp(path.join(os.tmpdir(), 'nous-feature-map-observations-'));
  await writeFile(
    path.join(observationDirectory, 'runtime.json'),
    JSON.stringify({
      auth: { kind: 'supabase-test-jwt', seedUserId: 'seed-user' },
      browser: { assertions: ['rendered'], environment: 'jsdom', viewport: 'desktop' },
      id: 'runtime',
      limitations: [],
      modules: ['apps/web/components/newHome/NewHomeView.tsx'],
      network: [{ method: 'GET', path: '/api/projects/projects', status: 200 }],
      persistence: [{ entity: 'project:seed', kind: 'in-memory-project-store', proof: 'seeded' }],
      title: 'Runtime fixture',
      workflows: [],
    })
  );
  featureMap = await buildFeatureMap(repositoryRoot, observationDirectory);
});

afterAll(async () => {
  await rm(observationDirectory, { force: true, recursive: true });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
  );
});

describe('generated feature map', () => {
  test('resolves dynamic registry imports and reports a missing local target', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'nous-feature-map-'));
    temporaryDirectories.push(repoRoot);
    const sourceDirectory = path.join(repoRoot, 'apps/web');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      path.join(sourceDirectory, 'Registry.ts'),
      `import './Admin.tsx';
      export const registry = {
        admin: () => import('./Admin.tsx'),
        missing: () => import('./Missing.tsx'),
      };
      `
    );
    await writeFile(
      path.join(sourceDirectory, 'Admin.tsx'),
      'export default function Admin() {}\n'
    );

    const edges = extractImportEdges(repoRoot, path.join(sourceDirectory, 'Registry.ts'));

    expect(edges[0]).toMatchObject({
      kind: 'static',
      specifier: './Admin.tsx',
      target: 'apps/web/Admin.tsx',
    });
    expect(edges[1]).toMatchObject({
      kind: 'dynamic',
      specifier: './Admin.tsx',
      target: 'apps/web/Admin.tsx',
    });
    expect(edges[2]).toMatchObject({ kind: 'dynamic', specifier: './Missing.tsx' });
    expect(edges[2]).not.toHaveProperty('target');
  });

  test('discovers production, admin, demo, backend routes and keeps usage unknown', () => {
    expect(featureMap.entrypoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'production-shell', path: 'apps/web/index.tsx' }),
        expect.objectContaining({
          id: 'production:authenticated-product',
          path: 'apps/web/app/AppContent.tsx',
        }),
        expect.objectContaining({
          id: 'admin:/admin',
          path: 'apps/web/components/admin/AdminPanel.tsx',
        }),
        expect.objectContaining({ kind: 'demo', path: 'apps/web/remotion/landingDemos.entry.tsx' }),
      ])
    );
    expect(featureMap.usage.status).toBe('unknown');
    expect(featureMap.generatedFrom.command).toBe('bun run feature-map');
    expect(featureMap.modules.some(module => module.path.includes('/dist/'))).toBe(false);
    expect(
      featureMap.modules.find(
        module => module.path === 'apps/web/components/newHome/NewHomeView.tsx'
      )?.classifications
    ).toContain('runtime-observed');
    expect(featureMap.backendRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'GET', path: '/api/projects/projects' }),
        expect.objectContaining({ method: 'POST', path: '/api/lesson-workflows/lessons' }),
        expect.objectContaining({ method: 'POST', path: '/api/chat/context' }),
      ])
    );
    expect(
      featureMap.legacyCandidates.every(
        candidate => candidate.status === 'candidate-to-investigate'
      )
    ).toBe(true);
  });

  test('regenerates identical output from the same evidence', async () => {
    const repeatedFeatureMap = await buildFeatureMap(repositoryRoot, observationDirectory);

    expect(repeatedFeatureMap).toEqual(featureMap);
    expect(renderFeatureMapMarkdown(repeatedFeatureMap)).toBe(renderFeatureMapMarkdown(featureMap));
  });

  test('keeps backend route discovery stable and ordered', () => {
    const routes = discoverBackendRoutes(repositoryRoot);
    const routeKeys = routes.map(route => `${route.path}:${route.method}`);
    expect(routeKeys).toEqual([...routeKeys].sort());
  });
});
