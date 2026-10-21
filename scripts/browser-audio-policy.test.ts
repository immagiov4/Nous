import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

function finalProperty(object: ts.ObjectLiteralExpression, name: string) {
  let result: ts.PropertyAssignment | undefined;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) result = undefined;
    else if (property.name?.getText().replace(/['"]/g, '') === name) {
      result = ts.isPropertyAssignment(property) ? property : undefined;
    }
  }
  return result;
}

function unmutedLaunches(source: string, filename: string): string[] {
  const isConfig = /playwright[^/]*config[^/]*\.[cm]?[jt]s$/.test(filename);
  if (!isConfig && !/launch/.test(source)) return [];
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
    if (modulePath === 'playwright' && imports && ts.isNamedImports(imports)) {
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
    if (
      ts.isPropertyAccessExpression(node) &&
      ['launch', 'launchPersistentContext', 'launchServer'].includes(node.name.text) &&
      !(
        ts.isCallExpression(node.parent) &&
        (node.parent.expression === node || node.parent.expression.getText(tree) === 'expect')
      )
    )
      report(node);
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      let method: string | undefined;
      if (ts.isPropertyAccessExpression(expression)) method = expression.name.text;
      if (
        ts.isElementAccessExpression(expression) &&
        ts.isStringLiteral(expression.argumentExpression)
      ) {
        method = expression.argumentExpression.text;
      }
      if (
        ts.isElementAccessExpression(expression) &&
        !ts.isStringLiteral(expression.argumentExpression) &&
        browserImports.has(expression.expression.getText(tree))
      )
        report(node);
      if (method && ['launch', 'launchPersistentContext', 'launchServer'].includes(method)) {
        if (!isMuted(node.arguments[method === 'launchPersistentContext' ? 1 : 0])) report(node);
      }
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
              project.properties.some(ts.isSpreadAssignment)
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

describe('browser audio policy', () => {
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
    expect(
      files.flatMap(filename =>
        unmutedLaunches(readFileSync(resolve(root, filename), 'utf8'), filename)
      )
    ).toEqual([]);
  });

  it.each([
    'chromium.launch()',
    'chromium["launch"]({})',
    'const method = "launch"; chromium[method]({});',
    'firefox.launch({ headless: true })',
    'chromium.launchServer({ headless: false })',
    'const start = chromium.launch.bind(chromium); start({ headless: false });',
    'browserType.launchPersistentContext(profile, {})',
    'chromium.launch({ args: ["--mute-audio"] })',
    'chromium.launch({ ...withMutedAudio(), args: [] })',
    'chromium.launch(withMutedAudio())',
  ])('rejects launches that bypass the shared policy: %s', source => {
    expect(unmutedLaunches(source, 'scripts/example.ts')).toHaveLength(1);
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
