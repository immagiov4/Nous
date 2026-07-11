import path from 'node:path';
import { Config } from '@remotion/cli/config';

const repoRoot = process.cwd();
const rootNodeModules = path.resolve(repoRoot, 'node_modules');

Config.setConcurrency(1);
Config.setPublicDir(path.resolve(repoRoot, 'apps/web/public'));
Config.overrideWebpackConfig(currentConfiguration => ({
  ...currentConfiguration,
  resolve: {
    ...currentConfiguration.resolve,
    alias: {
      ...(currentConfiguration.resolve?.alias ?? {}),
      '@': path.resolve(repoRoot, 'apps/web'),
      '@shared': path.resolve(repoRoot, 'packages/shared-types'),
      react: path.resolve(rootNodeModules, 'react'),
      'react-dom': path.resolve(rootNodeModules, 'react-dom'),
      'react/jsx-dev-runtime': path.resolve(rootNodeModules, 'react/jsx-dev-runtime.js'),
      'react/jsx-runtime': path.resolve(rootNodeModules, 'react/jsx-runtime.js'),
    },
  },
}));
