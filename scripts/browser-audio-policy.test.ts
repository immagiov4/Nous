import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

function finalProperty(object: ts.ObjectLiteralExpression, name: string) {
  let result: ts.PropertyAssignment | undefined;
  for (const property of object.properties) {
    if (
      ts.isSpreadAssignment(property) ||
      (property.name && ts.isComputedPropertyName(property.name))
    )
      result = undefined;
    else if (property.name?.getText().replace(/['"]/g, '') === name) {
      result = ts.isPropertyAssignment(property) ? property : undefined;
    }
  }
  return result;
}

function unmutedLaunches(source: string, filename: string): string[] {
  let isConfig = /playwright[^/]*config[^/]*\.[cm]?[jt]s$/.test(filename);
  // Strip identity escapes and line continuations; retain encoded names as candidates.
  const candidateSource = source.replace(/\\(?:\r\n|[\n\r\u2028\u2029])?/g, '');
  if (
    !isConfig &&
    !/launch|chromium|firefox|webkit|browserType|defineConfig/.test(candidateSource) &&
    !/\\[ux0-7]/.test(source)
  )
    return [];
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  let configExports = 0;
  const failures: string[] = [];
  const mutedImports = new Set<string>();
  const browserImports = new Set(['chromium', 'firefox', 'webkit', 'browserType']);
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const modulePath = statement.moduleSpecifier.text;
    const imports = statement.importClause?.namedBindings;
    if (modulePath === '@playwright/test' && imports && ts.isNamedImports(imports)) {
      isConfig ||= imports.elements.some(
        binding => (binding.propertyName ?? binding.name).text === 'defineConfig'
      );
    }
    if (
      ['playwright', '@playwright/test'].includes(modulePath) &&
      imports &&
      ts.isNamespaceImport(imports)
    ) {
      for (const browser of ['chromium', 'firefox', 'webkit'])
        browserImports.add(`${imports.name.text}.${browser}`);
    }
    if (
      ['playwright', '@playwright/test'].includes(modulePath) &&
      imports &&
      ts.isNamedImports(imports)
    ) {
      for (const binding of imports.elements) {
        if (['chromium', 'firefox', 'webkit'].includes((binding.propertyName ?? binding.name).text))
          browserImports.add(binding.name.text);
      }
    }
    if (
      resolve(root, filename, '..', modulePath).replace(/\\/g, '/') !==
      `${root.replace(/\\/g, '/')}/scripts/browser-audio`
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === 'withMutedAudio')
          mutedImports.add(binding.name.text);
      }
    }
  }
  function isMuted(node: ts.Node | undefined): boolean {
    return (
      !!node &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      mutedImports.has(node.expression.text)
    );
  }
  function report(node: ts.Node) {
    failures.push(`${filename}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
  }
  function visit(node: ts.Node) {
    let method: string | undefined;
    if (ts.isPropertyAccessExpression(node)) method = node.name.text;
    if (ts.isElementAccessExpression(node)) {
      if (ts.isStringLiteral(node.argumentExpression)) method = node.argumentExpression.text;
      else if (browserImports.has(node.expression.getText(tree))) report(node);
    }
    if (method && ['launch', 'launchPersistentContext', 'launchServer'].includes(method)) {
      const call = node.parent;
      if (ts.isCallExpression(call) && call.expression === node) {
        if (!isMuted(call.arguments[method === 'launchPersistentContext' ? 1 : 0])) report(call);
      } else if (!(ts.isCallExpression(call) && call.expression.getText(tree) === 'expect'))
        report(node);
    }
    if (isConfig) {
      if (ts.isPropertyAssignment(node) && node.name.getText(tree).replace(/['"]/g, '') === 'use') {
        const options = node.initializer;
        const launch =
          ts.isObjectLiteralExpression(options) && finalProperty(options, 'launchOptions');
        if (!launch || !ts.isPropertyAssignment(launch) || !isMuted(launch.initializer))
          report(node);
      }
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(tree).replace(/['"]/g, '') === 'projects'
      ) {
        const projects = node.initializer;
        if (
          !ts.isArrayLiteralExpression(projects) ||
          projects.elements.some(
            project =>
              !ts.isObjectLiteralExpression(project) ||
              project.properties.some(
                property =>
                  !ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)
              )
          )
        )
          report(node);
      }
      if (ts.isExportAssignment(node)) {
        configExports++;
        const config = node.expression;
        const options = ts.isCallExpression(config) ? config.arguments[0] : config;
        if (
          !options ||
          !ts.isObjectLiteralExpression(options) ||
          options.properties.some(
            property =>
              !ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)
          ) ||
          !finalProperty(options, 'use') ||
          (ts.isCallExpression(config) && config.arguments.length !== 1)
        )
          report(node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (isConfig && configExports === 0)
    failures.push(`${filename}: explicit default configuration required`);
  return failures;
}

function scanSources(files: string[]) {
  return files
    .filter(filename => existsSync(resolve(root, filename)))
    .flatMap(filename => unmutedLaunches(readFileSync(resolve(root, filename), 'utf8'), filename));
}

describe('browser audio policy', () => {
  it('scans existing sources while skipping locally deleted files', () => {
    expect(scanSources(['scripts/browser-audio.ts', 'scripts/deleted-source.ts'])).toEqual([]);
  });

  it.each([
    'playwright',
    '@playwright/test',
  ])('rejects namespace browser access from %s without the shared policy', modulePath => {
    expect(
      unmutedLaunches(
        `import * as pw from '${modulePath}'; const method = 'launch'; pw.chromium[method]({});`,
        'scripts/example.ts'
      )
    ).toHaveLength(1);
  });

  it('recognizes custom configuration names through Playwright imports', () => {
    expect(
      unmutedLaunches(
        `import { defineConfig } from '@playwright/test'; export default defineConfig({});`,
        'browser.config.ts'
      )
    ).toHaveLength(1);
  });

  it('requires enforced muting at every repository launch and Playwright config', () => {
    const files = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      }
    )
      .split('\0')
      .filter(filename => /\.[cm]?[jt]sx?$/.test(filename));
    expect(scanSources(files)).toEqual([]);
  });

  it.each([
    'chromium.launch()',
    String.raw`other.l\u0061unch({})`,
    String.raw`other["l\x61unch"]({})`,
    String.raw`other["l\141unch"]({})`,
    String.raw`other["l\aunc\h"]({})`,
    'chromium["launch"]({})',
    'const method = "launch"; chromium[method]({});',
    'firefox.launch({ headless: true })',
    'chromium.launchServer({ headless: false })',
    'const start = chromium.launch.bind(chromium); start({ headless: false });',
    'const start = chromium["launch"].bind(chromium); start({ headless: false });',
    'browserType.launchPersistentContext(profile, {})',
    'chromium.launch({ args: ["--mute-audio"] })',
    'chromium.launch({ ...withMutedAudio(), args: [] })',
    'chromium.launch(withMutedAudio())',
  ])('rejects launches that bypass the shared policy: %s', source => {
    expect(unmutedLaunches(source, 'scripts/example.ts')).toHaveLength(1);
  });

  it.each([
    '\n',
    '\r',
    '\r\n',
    '\u2028',
    '\u2029',
  ])('rejects escaped line continuations in launch properties: %j', lineBreak => {
    expect(unmutedLaunches(`other["l\\${lineBreak}aunch"]({})`, 'scripts/example.ts')).toHaveLength(
      1
    );
  });

  it('accepts imported policy calls including persistent contexts and aliases', () => {
    expect(
      unmutedLaunches(
        `import { withMutedAudio as silent } from './browser-audio';
      chromium.launch(silent({ channel: 'chrome' }));
      firefox.launchPersistentContext(profile, silent());`,
        'scripts/example.ts'
      )
    ).toEqual([]);
  });

  it.each([
    'export default defineConfig({});',
    'module.exports = { use: {} };',
    'export default defineConfig({ use: {} });',
    'export default defineConfig({ use: { launchOptions: {} } });',
  ])('rejects Playwright configs without enforced launch options', source => {
    expect(unmutedLaunches(source, 'playwright.config.ts').length).toBeGreaterThan(0);
  });

  it.each([
    'export default defineConfig({ use: { launchOptions: withMutedAudio(), ...overrides } });',
    'export default defineConfig({ use: { launchOptions: withMutedAudio() }, ...overrides });',
    'export default defineConfig({ use: { launchOptions: withMutedAudio() } }, overrides);',
  ])('rejects configuration spreads that can override the audio policy', source => {
    expect(
      unmutedLaunches(
        `import { withMutedAudio } from './scripts/browser-audio'; ${source}`,
        'playwright.config.ts'
      ).length
    ).toBeGreaterThan(0);
  });

  it.each([
    "export default defineConfig({ 'use': { launchOptions: {} } });",
    'export default defineConfig({ ...externalConfig, use: { launchOptions: withMutedAudio() } });',
    'export default defineConfig({ use: { launchOptions: withMutedAudio(), [key]: {} } });',
    'export default defineConfig({ use: { launchOptions: withMutedAudio() }, projects: [{ [key]: {} }] });',
    'const use = { launchOptions: {} }; export default defineConfig({ use: { launchOptions: withMutedAudio() }, projects: [{ use }] });',
    'export default defineConfig({ use: { launchOptions: withMutedAudio() }, projects: externalProjects });',
    'export default defineConfig({ use: { launchOptions: withMutedAudio() }, projects: [...externalProjects] });',
    'export default defineConfig({ use: { launchOptions: withMutedAudio() }, projects: [{ ...externalProject }] });',
  ])('rejects unverified configuration options: %s', source => {
    expect(
      unmutedLaunches(
        `import { withMutedAudio } from './scripts/browser-audio'; ${source}`,
        'playwright.config.ts'
      ).length
    ).toBeGreaterThan(0);
  });

  it('checks project overrides as well as global Playwright defaults', () => {
    const source = `import { withMutedAudio } from './scripts/browser-audio';
      export default defineConfig({ use: { launchOptions: withMutedAudio() },
        projects: [{ use: { browserName: 'firefox' } }] });`;
    expect(unmutedLaunches(source, 'playwright.config.ts')).toHaveLength(1);
    expect(
      unmutedLaunches(
        source.replace("browserName: 'firefox'", 'launchOptions: withMutedAudio()'),
        'playwright.config.ts'
      )
    ).toEqual([]);
  });
});
