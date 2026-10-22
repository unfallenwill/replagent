// Dependency direction is enforced, not documented.
//
//   cli  ->  app  ->  domain
//     \      \        ^
//      \      \______|
//       -> adapters -> domain
//
// Rules:
//   - domain is the centre: it may not import app / adapters / cli, nor any
//     third-party package (it is plain TypeScript, nothing else).
//   - app (use cases) only knows domain; it never reaches for a concrete
//     adapter, so the ports can be swapped or faked.
//   - adapters implement domain ports; they never import the app or the cli.
//   - the cli is the only entry point and nothing may import it.
//   - no cycles, no orphans, no dev-dependency leakage into src/.
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-orphans',
      severity: 'error',
      from: { path: '^src', orphan: true },
      to: {},
    },
    {
      name: 'domain-not-to-upper-layers',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^src/(app|adapters|cli)' },
    },
    {
      name: 'domain-not-to-external',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^node_modules/' },
    },
    {
      name: 'app-not-to-adapters-or-cli',
      severity: 'error',
      from: { path: '^src/app' },
      to: { path: '^src/(adapters|cli)' },
    },
    {
      name: 'adapters-not-to-cli',
      severity: 'error',
      from: { path: '^src/adapters' },
      to: { path: '^src/cli' },
    },
    {
      name: 'adapters-not-to-app',
      severity: 'error',
      from: { path: '^src/adapters' },
      to: { path: '^src/app' },
    },
    {
      name: 'cli-not-imported',
      severity: 'error',
      from: { path: '^(?!src/cli)' },
      to: { path: '^src/cli' },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      from: { path: '^src' },
      to: { path: '^node_modules/', dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
    },
  },
};
