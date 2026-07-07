/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-unresolvable',
      comment: 'Flag imports the resolver still cannot map onto a real file.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      comment: 'Surface circular imports once resolution works correctly.',
      severity: 'warn',
      from: { pathNot: '(^|/)(node_modules|dist)(/|$)' },
      to: { circular: true },
    },
    {
      name: 'no-runtime-to-tests',
      comment: 'Prevent application code from depending on test files or test helpers.',
      severity: 'error',
      from: {
        pathNot: '(^|/)(tests?/|.*\\.(test|spec)\\.(ts|tsx|js|jsx)$)',
      },
      to: {
        path: '(^|/)(tests?/|.*\\.(test|spec)\\.(ts|tsx|js|jsx)$)',
      },
    },
    {
      name: 'no-web-to-backend',
      comment: 'Frontend code should not depend directly on backend implementation files.',
      severity: 'error',
      from: {
        path: '^(app|components|constants|hooks|services|styles|utils|index\\.tsx|App\\.tsx|types\\.ts)',
      },
      to: {
        path: '(^|/)apps/backend/',
      },
    },
    {
      name: 'no-backend-to-web',
      comment: 'Backend code should not depend directly on frontend implementation files.',
      severity: 'error',
      from: {
        path: '^src/',
      },
      to: {
        path: '(^|/)apps/web/',
      },
    },
  ],
  options: {
    exclude: '(^|/)(vite|vitest)\\.config\\.ts$',
    doNotFollow: {
      path: '(^|/)(node_modules|dist)(/|$)',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      mainFields: ['module', 'main', 'types', 'typings'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
