# Generated feature map

Run the internal feature-map tool from the repository root:

```bash
bun run feature-map
```

The command executes the deterministic authenticated journey fixtures, builds a TypeScript AST
import graph, and writes two local artifacts under `.temp/feature-map/`:

- `feature-map.json` is the machine-readable graph, with entrypoint reachability, backend routes,
  journey observations, gaps, commit evidence, and legacy candidates.
- `feature-map.md` is the ordered review summary of the same evidence.

The output directory is ignored by Git because these files are reproducible and may grow. Run the
command again whenever entrypoints, imports, routes, or observed journeys change.

Interpret classifications as evidence scopes: `static-only` is reachable only in the import graph,
`runtime-observed` was exercised by a deterministic journey, `demo-test-only` is limited to demo or
test entrypoints, and `unresolved` records missing or unmatched evidence. Product usage remains
`unknown`; the tool never treats AI metering or absence from a fixture as proof of non-use. Legacy
entries are investigation candidates, not removal verdicts.
