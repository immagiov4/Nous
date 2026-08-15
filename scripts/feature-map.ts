import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export type FeatureMapClassification =
  | 'demo-test-only'
  | 'runtime-observed'
  | 'static-only'
  | 'unresolved';

export interface FeatureMapObservation {
  auth: {
    kind: 'supabase-test-jwt';
    seedUserId: string;
  };
  browser: {
    assertions: string[];
    environment: 'jsdom';
    viewport: 'desktop' | 'mobile';
  };
  id: string;
  limitations: string[];
  modules: string[];
  network: Array<{ method: string; path: string; status: number }>;
  persistence: Array<{
    entity: string;
    kind: 'in-memory-project-store' | 'not-applicable';
    proof: string;
  }>;
  title: string;
  workflows: Array<{ event: string; runId: string; status: string }>;
}

interface ImportEdge {
  kind: 'dynamic' | 'static';
  source: string;
  sourceLine: number;
  specifier: string;
  target?: string;
}

interface DiscoveredEntrypoint {
  id: string;
  kind: 'admin' | 'demo' | 'production';
  path: string;
  route?: string;
  source: string;
}

interface BackendRoute {
  method: string;
  path: string;
  source: string;
  sourceLine: number;
}

interface FeatureMapModule {
  classifications: FeatureMapClassification[];
  evidence: string[];
  imports: Array<Pick<ImportEdge, 'kind' | 'sourceLine' | 'target'>>;
  path: string;
  reachableFrom: string[];
  runtimeJourneys: string[];
  usage: 'unknown';
}

interface FeatureMap {
  backendRoutes: BackendRoute[];
  entrypoints: DiscoveredEntrypoint[];
  gaps: Array<{ kind: string; source: string; detail: string }>;
  generatedFrom: {
    command: 'bun run feature-map';
    commitSha: string;
    commitTimestamp: string;
    generator: string;
  };
  journeys: FeatureMapObservation[];
  legacyCandidates: Array<{
    negativeEvidence: string[];
    path: string;
    positiveEvidence: string[];
    status: 'candidate-to-investigate';
    usage: 'unknown';
  }>;
  modules: FeatureMapModule[];
  schemaVersion: 1;
  usage: {
    reason: string;
    status: 'unknown';
  };
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const;
const GENERATED_DIRECTORIES = new Set(['dist']);
const LOCAL_PREFIXES = ['.', '@/', '@shared/'] as const;
const HTTP_METHODS = new Set(['delete', 'get', 'patch', 'post', 'put']);

const toRepoPath = (repoRoot: string, absolutePath: string): string =>
  path.relative(repoRoot, absolutePath).replaceAll('\\', '/');

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const collectSourceFiles = (root: string): string[] => {
  if (!statSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap(entry => {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return GENERATED_DIRECTORIES.has(entry.name) ? [] : collectSourceFiles(absolutePath);
      }
      return SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension))
        ? [absolutePath]
        : [];
    })
    .sort(compareText);
};

const resolveWithExtensions = (candidate: string): string | undefined => {
  const withoutJsExtension = candidate.replace(/\.(?:mjs|cjs|js|jsx)$/u, '');
  const candidates = [
    candidate,
    withoutJsExtension,
    ...SOURCE_EXTENSIONS.map(extension => `${withoutJsExtension}${extension}`),
    ...SOURCE_EXTENSIONS.map(extension => path.join(candidate, `index${extension}`)),
  ];
  return candidates.find(filePath => {
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  });
};

const resolveImport = (
  repoRoot: string,
  sourceFile: string,
  specifier: string
): string | undefined => {
  let candidate: string;
  if (specifier.startsWith('.')) candidate = path.resolve(path.dirname(sourceFile), specifier);
  else if (specifier.startsWith('@/'))
    candidate = path.join(repoRoot, 'apps/web', specifier.slice(2));
  else if (specifier.startsWith('@shared/')) {
    candidate = path.join(repoRoot, 'packages/shared-types', specifier.slice('@shared/'.length));
  } else return undefined;
  return resolveWithExtensions(candidate);
};

const readStringLiteral = (expression: ts.Expression | undefined): string | undefined =>
  expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;

export const extractImportEdges = (repoRoot: string, absolutePath: string): ImportEdge[] => {
  const sourceText = readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    absolutePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const source = toRepoPath(repoRoot, absolutePath);
  const edges: ImportEdge[] = [];
  const append = (specifier: string, node: ts.Node, kind: ImportEdge['kind']) => {
    const resolved = resolveImport(repoRoot, absolutePath, specifier);
    edges.push({
      kind,
      source,
      sourceLine: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      specifier,
      ...(resolved ? { target: toRepoPath(repoRoot, resolved) } : {}),
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = readStringLiteral(node.moduleSpecifier);
      if (specifier) append(specifier, node, 'static');
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const specifier = readStringLiteral(node.arguments[0]);
      if (specifier) append(specifier, node, 'dynamic');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edges.sort((left, right) =>
    compareText(`${left.sourceLine}:${left.specifier}`, `${right.sourceLine}:${right.specifier}`)
  );
};

const findHtmlEntrypoint = (repoRoot: string): DiscoveredEntrypoint => {
  const htmlPath = path.join(repoRoot, 'apps/web/index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const scriptPath = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/u)?.[1];
  if (!scriptPath)
    throw new Error('Unable to discover the Vite module entrypoint from index.html.');
  const absolutePath = resolveWithExtensions(
    path.join(repoRoot, 'apps/web', scriptPath.replace(/^\//u, ''))
  );
  if (!absolutePath) throw new Error(`Vite entrypoint does not exist: ${scriptPath}`);
  return {
    id: 'production-shell',
    kind: 'production',
    path: toRepoPath(repoRoot, absolutePath),
    route: '/',
    source: 'apps/web/index.html',
  };
};

const getJsxTag = (node: ts.Node): string | undefined => {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  let result: string | undefined;
  ts.forEachChild(node, child => {
    result ??= getJsxTag(child);
  });
  return result;
};

const discoverAppRoutes = (repoRoot: string): DiscoveredEntrypoint[] => {
  const appPath = path.join(repoRoot, 'apps/web/App.tsx');
  const sourceText = readFileSync(appPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    appPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const lazyTargets = new Map<string, string>();
  sourceFile.forEachChild(node => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = declaration.initializer;
      const dynamicImport = extractImportEdges(repoRoot, appPath).find(
        edge =>
          edge.kind === 'dynamic' &&
          sourceText.slice(initializer.pos, initializer.end).includes(edge.specifier)
      );
      if (dynamicImport?.target) lazyTargets.set(declaration.name.text, dynamicImport.target);
    }
  });
  const routes: DiscoveredEntrypoint[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)) {
      const route =
        readStringLiteral(node.expression.right) ?? readStringLiteral(node.expression.left);
      const tag = getJsxTag(node.thenStatement);
      const target = tag ? lazyTargets.get(tag) : undefined;
      if (route && target) {
        routes.push({
          id: `admin:${route}`,
          kind: 'admin',
          path: target,
          route,
          source: 'apps/web/App.tsx',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const productTarget = lazyTargets.get('AppContent');
  if (!productTarget)
    throw new Error('Unable to discover the authenticated AppContent entrypoint.');
  routes.push({
    id: 'production:authenticated-product',
    kind: 'production',
    path: productTarget,
    route: '/',
    source: 'apps/web/App.tsx',
  });
  return routes.sort((left, right) => compareText(left.id, right.id));
};

const discoverDemoEntrypoints = (repoRoot: string): DiscoveredEntrypoint[] =>
  collectSourceFiles(path.join(repoRoot, 'apps/web/remotion'))
    .filter(filePath => filePath.endsWith('.entry.tsx'))
    .filter(filePath => readFileSync(filePath, 'utf8').includes('registerRoot('))
    .map(filePath => ({
      id: `demo:${path.basename(filePath, '.entry.tsx')}`,
      kind: 'demo' as const,
      path: toRepoPath(repoRoot, filePath),
      source: 'registerRoot',
    }));

const getImportedBindings = (repoRoot: string, absolutePath: string): Map<string, string> => {
  const sourceText = readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, string>();
  sourceFile.forEachChild(node => {
    if (!ts.isImportDeclaration(node)) return;
    const specifier = readStringLiteral(node.moduleSpecifier);
    if (!specifier || !node.importClause) return;
    const target = resolveImport(repoRoot, absolutePath, specifier);
    if (!target) return;
    if (node.importClause.name) bindings.set(node.importClause.name.text, target);
    if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      node.importClause.namedBindings.elements.forEach(element => {
        bindings.set(element.name.text, target);
      });
    }
  });
  return bindings;
};

const routerBindingName = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text;
  }
  return undefined;
};

const extractRouterRoutes = (
  repoRoot: string,
  absolutePath: string,
  prefix: string,
  visited = new Set<string>()
): BackendRoute[] => {
  if (visited.has(absolutePath)) return [];
  visited.add(absolutePath);
  const sourceText = readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
  const bindings = getImportedBindings(repoRoot, absolutePath);
  const routes: BackendRoute[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HTTP_METHODS.has(node.expression.name.text)
    ) {
      const routePath = readStringLiteral(node.arguments[0]);
      if (routePath !== undefined) {
        routes.push({
          method: node.expression.name.text.toUpperCase(),
          path: `${prefix}${routePath === '/' ? '' : routePath}` || '/',
          source: toRepoPath(repoRoot, absolutePath),
          sourceLine: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'use'
    ) {
      const nestedPrefix = readStringLiteral(node.arguments[0]);
      const routerArguments = nestedPrefix ? node.arguments.slice(1) : node.arguments;
      for (const argument of routerArguments) {
        const binding = routerBindingName(argument);
        const target = binding ? bindings.get(binding) : undefined;
        if (target && toRepoPath(repoRoot, target).startsWith('apps/backend/src/routes/')) {
          routes.push(
            ...extractRouterRoutes(repoRoot, target, `${prefix}${nestedPrefix ?? ''}`, visited)
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return routes;
};

export const discoverBackendRoutes = (repoRoot: string): BackendRoute[] => {
  const indexPath = path.join(repoRoot, 'apps/backend/src/index.ts');
  const bindings = getImportedBindings(repoRoot, indexPath);
  const sourceText = readFileSync(indexPath, 'utf8');
  const sourceFile = ts.createSourceFile(indexPath, sourceText, ts.ScriptTarget.Latest, true);
  const mounts: Array<{ prefix: string; target: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'use'
    ) {
      const prefix = readStringLiteral(node.arguments[0]);
      if (prefix) {
        for (const argument of node.arguments.slice(1)) {
          const binding = routerBindingName(argument);
          const target = binding ? bindings.get(binding) : undefined;
          if (target && toRepoPath(repoRoot, target).startsWith('apps/backend/src/routes/')) {
            mounts.push({ prefix, target });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mounts
    .flatMap(mount => extractRouterRoutes(repoRoot, mount.target, mount.prefix))
    .filter(
      (route, index, routes) =>
        routes.findIndex(
          candidate => candidate.method === route.method && candidate.path === route.path
        ) === index
    )
    .sort((left, right) =>
      compareText(`${left.path}:${left.method}`, `${right.path}:${right.method}`)
    );
};

const traverse = (
  entrypoint: DiscoveredEntrypoint,
  edgesBySource: ReadonlyMap<string, ImportEdge[]>
): Set<string> => {
  const visited = new Set<string>();
  const pending = [entrypoint.path];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const edge of edgesBySource.get(current) ?? []) {
      if (entrypoint.id === 'production-shell' && edge.kind === 'dynamic') continue;
      if (edge.target && !visited.has(edge.target)) pending.push(edge.target);
    }
  }
  return visited;
};

const pathMatchesRoute = (observedPath: string, routePath: string): boolean => {
  const routeSegments = routePath.split('/');
  const observedSegments = observedPath.split('?')[0].split('/');
  return (
    routeSegments.length === observedSegments.length &&
    routeSegments.every(
      (segment, index) => segment.startsWith(':') || segment === observedSegments[index]
    )
  );
};

const readObservations = async (observationDirectory: string): Promise<FeatureMapObservation[]> => {
  let entries: string[];
  try {
    entries = await readdir(observationDirectory);
  } catch {
    return [];
  }
  const observations = await Promise.all(
    entries
      .filter(entry => entry.endsWith('.json'))
      .sort(compareText)
      .map(async entry =>
        JSON.parse(await readFile(path.join(observationDirectory, entry), 'utf8'))
      )
  );
  return observations.sort((left, right) => compareText(left.id, right.id));
};

const gitValue = (repoRoot: string, argumentsValue: string[]): string => {
  const result = spawnSync('git', argumentsValue, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

export const buildFeatureMap = async (
  repoRoot: string,
  observationDirectory = path.join(repoRoot, 'tmp/feature-map-observations')
): Promise<FeatureMap> => {
  const webFiles = collectSourceFiles(path.join(repoRoot, 'apps/web')).filter(
    filePath => !filePath.includes(`${path.sep}tests${path.sep}`)
  );
  const testFiles = collectSourceFiles(path.join(repoRoot, 'apps/web/tests'));
  const allFiles = [
    ...webFiles,
    ...testFiles,
    ...collectSourceFiles(path.join(repoRoot, 'packages/shared-types')),
  ];
  const allEdges = allFiles.flatMap(filePath => extractImportEdges(repoRoot, filePath));
  const edgesBySource = new Map<string, ImportEdge[]>();
  allEdges.forEach(edge => {
    edgesBySource.set(edge.source, [...(edgesBySource.get(edge.source) ?? []), edge]);
  });

  const entrypoints = [
    findHtmlEntrypoint(repoRoot),
    ...discoverAppRoutes(repoRoot),
    ...discoverDemoEntrypoints(repoRoot),
  ].sort((left, right) => compareText(left.id, right.id));
  const reachability = new Map(
    entrypoints.map(entrypoint => [entrypoint.id, traverse(entrypoint, edgesBySource)])
  );
  const testEntrypoints = testFiles.map(filePath => ({
    id: `test:${toRepoPath(repoRoot, filePath)}`,
    kind: 'demo' as const,
    path: toRepoPath(repoRoot, filePath),
    source: 'Vitest',
  }));
  const testReachable = new Set(
    testEntrypoints.flatMap(entrypoint => [...traverse(entrypoint, edgesBySource)])
  );
  const journeys = await readObservations(observationDirectory);
  const observedByModule = new Map<string, string[]>();
  journeys.forEach(journey => {
    journey.modules.forEach(modulePath => {
      observedByModule.set(modulePath, [...(observedByModule.get(modulePath) ?? []), journey.id]);
    });
  });

  const repoPaths = webFiles.map(filePath => toRepoPath(repoRoot, filePath));
  const modules: FeatureMapModule[] = repoPaths.map(modulePath => {
    const reachableFrom = entrypoints
      .filter(entrypoint => reachability.get(entrypoint.id)?.has(modulePath))
      .map(entrypoint => entrypoint.id);
    const runtimeJourneys = [...new Set(observedByModule.get(modulePath) ?? [])].sort(compareText);
    const supportedReachability = reachableFrom.filter(id => !id.startsWith('demo:'));
    const demoReachability = reachableFrom.filter(id => id.startsWith('demo:'));
    const classifications = new Set<FeatureMapClassification>();
    if (runtimeJourneys.length > 0) classifications.add('runtime-observed');
    if (supportedReachability.length > 0 && runtimeJourneys.length === 0)
      classifications.add('static-only');
    if (
      supportedReachability.length === 0 &&
      (demoReachability.length > 0 || testReachable.has(modulePath))
    ) {
      classifications.add('demo-test-only');
    }
    if (reachableFrom.length === 0 && !testReachable.has(modulePath))
      classifications.add('unresolved');
    const evidence = [
      ...reachableFrom.map(id => `reachable:${id}`),
      ...runtimeJourneys.map(id => `observed:${id}`),
      ...(testReachable.has(modulePath) ? ['reachable:test'] : []),
    ].sort(compareText);
    return {
      classifications: [...classifications].sort(compareText),
      evidence,
      imports: (edgesBySource.get(modulePath) ?? [])
        .filter(edge => edge.target)
        .map(edge => ({ kind: edge.kind, sourceLine: edge.sourceLine, target: edge.target }))
        .sort((left, right) =>
          compareText(`${left.target}:${left.sourceLine}`, `${right.target}:${right.sourceLine}`)
        ),
      path: modulePath,
      reachableFrom,
      runtimeJourneys,
      usage: 'unknown',
    };
  });

  const backendRoutes = discoverBackendRoutes(repoRoot);
  const gaps = allEdges
    .filter(
      edge => !edge.target && LOCAL_PREFIXES.some(prefix => edge.specifier.startsWith(prefix))
    )
    .map(edge => ({
      kind: 'unresolved-local-import',
      source: `${edge.source}:${edge.sourceLine}`,
      detail: edge.specifier,
    }));
  journeys.forEach(journey => {
    journey.network.forEach(request => {
      if (
        !backendRoutes.some(
          route => route.method === request.method && pathMatchesRoute(request.path, route.path)
        )
      ) {
        gaps.push({
          kind: 'unmatched-runtime-route',
          source: journey.id,
          detail: `${request.method} ${request.path}`,
        });
      }
    });
    journey.limitations.forEach(limitation => {
      gaps.push({ kind: 'journey-infrastructure-limit', source: journey.id, detail: limitation });
    });
  });

  const legacyCandidates = modules
    .filter(
      module => module.path.startsWith('apps/web/components/') && module.path.endsWith('.tsx')
    )
    .filter(module => module.reachableFrom.length === 0)
    .map(module => ({
      negativeEvidence: [
        ...(testReachable.has(module.path) ? ['Referenced by Vitest paths.'] : []),
        'Authenticated real-browser and production-usage evidence is unavailable in this slice.',
      ],
      path: module.path,
      positiveEvidence: [
        'No production, admin, or Remotion entrypoint reaches this module in the generated import graph.',
      ],
      status: 'candidate-to-investigate' as const,
      usage: 'unknown' as const,
    }));

  return {
    backendRoutes,
    entrypoints,
    gaps: gaps.sort((left, right) =>
      compareText(
        `${left.kind}:${left.source}:${left.detail}`,
        `${right.kind}:${right.source}:${right.detail}`
      )
    ),
    generatedFrom: {
      command: 'bun run feature-map',
      commitSha: gitValue(repoRoot, ['rev-parse', 'HEAD']),
      commitTimestamp: gitValue(repoRoot, ['show', '-s', '--format=%cI', 'HEAD']),
      generator: 'scripts/feature-map.ts',
    },
    journeys,
    legacyCandidates,
    modules,
    schemaVersion: 1,
    usage: {
      reason: 'Product analytics are not implemented; AI metering is not feature-usage evidence.',
      status: 'unknown',
    },
  };
};

const FEATURE_MAP_OUTPUT_DIRECTORY = '.temp/feature-map';

export const renderFeatureMapMarkdown = (featureMap: FeatureMap): string => {
  const classificationCounts = new Map<FeatureMapClassification, number>();
  featureMap.modules.forEach(module => {
    module.classifications.forEach(classification => {
      classificationCounts.set(classification, (classificationCounts.get(classification) ?? 0) + 1);
    });
  });
  const lines = [
    '# Generated feature map',
    '',
    `- Rebuild: \`${featureMap.generatedFrom.command}\``,
    `- Commit: \`${featureMap.generatedFrom.commitSha}\``,
    `- Commit timestamp: ${featureMap.generatedFrom.commitTimestamp}`,
    '- Static evidence: TypeScript import/export/dynamic-import reachability from discovered HTML, app, admin, and Remotion entrypoints.',
    '- Routes are correlated evidence, not a proxy for product features.',
    `- Usage: **unknown** — ${featureMap.usage.reason}`,
    '- Removal verdicts: disabled; entries can only be candidates to investigate.',
    '',
    '## Entrypoints',
    '',
    '| Kind | ID | Route | Module | Evidence |',
    '| --- | --- | --- | --- | --- |',
    ...featureMap.entrypoints.map(
      entrypoint =>
        `| ${entrypoint.kind} | ${entrypoint.id} | ${entrypoint.route ?? '—'} | \`${entrypoint.path}\` | \`${entrypoint.source}\` |`
    ),
    '',
    '## Classification summary',
    '',
    '| Classification | Modules |',
    '| --- | ---: |',
    ...[...classificationCounts.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([classification, count]) => `| ${classification} | ${count} |`),
    '',
    '## Authenticated journey observations',
    '',
    '| Journey | Browser | Network | Workflow | Persistence | Limits |',
    '| --- | --- | --- | --- | --- | --- |',
    ...featureMap.journeys.map(
      journey =>
        `| ${journey.title} | ${journey.browser.environment}/${journey.browser.viewport} | ${journey.network.map(request => `${request.method} ${request.path} → ${request.status}`).join('<br>') || '—'} | ${journey.workflows.map(workflow => `${workflow.runId}: ${workflow.status} (${workflow.event})`).join('<br>') || '—'} | ${journey.persistence.map(proof => `${proof.kind}: ${proof.proof}`).join('<br>') || '—'} | ${journey.limitations.join('<br>') || '—'} |`
    ),
    '',
    '## Legacy candidates',
    '',
    '| Module | Status | Usage | Positive evidence | Blocking/negative evidence |',
    '| --- | --- | --- | --- | --- |',
    ...featureMap.legacyCandidates.map(
      candidate =>
        `| \`${candidate.path}\` | ${candidate.status} | ${candidate.usage} | ${candidate.positiveEvidence.join('<br>')} | ${candidate.negativeEvidence.join('<br>')} |`
    ),
    '',
    '## Gaps',
    '',
    '| Kind | Source | Detail |',
    '| --- | --- | --- |',
    ...featureMap.gaps.map(gap => `| ${gap.kind} | \`${gap.source}\` | ${gap.detail} |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
};

export const writeFeatureMap = async (repoRoot: string): Promise<FeatureMap> => {
  const featureMap = await buildFeatureMap(repoRoot);
  const outputDirectory = path.join(repoRoot, FEATURE_MAP_OUTPUT_DIRECTORY);
  const jsonPath = path.join(outputDirectory, 'feature-map.json');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(featureMap, null, 2)}\n`);
  await writeFile(
    path.join(outputDirectory, 'feature-map.md'),
    renderFeatureMapMarkdown(featureMap)
  );
  return featureMap;
};

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, '..');
  const featureMap = await writeFeatureMap(repoRoot);
  process.stdout.write(
    `Generated ${featureMap.modules.length} modules, ${featureMap.journeys.length} journeys, ${featureMap.legacyCandidates.length} legacy candidates in ${FEATURE_MAP_OUTPUT_DIRECTORY}.\n`
  );
}
