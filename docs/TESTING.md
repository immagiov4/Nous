# Testing and quality gates

The root scripts in `package.json` are the canonical development and CI entrypoints.
Install [uv](https://docs.astral.sh/uv/getting-started/installation/) so the gate can run its pinned
Semgrep CLI through `uvx`. There is no alternate Semgrep runner.

## Routine checks

```bash
bun run quality
bun run check:fallow
bun run test
bun run gate
```

- `quality` runs the TypeScript checks, Biome, dependency boundaries, and React Hooks lint.
- `test` runs the Vitest suite under Bun.
- `gate` runs `quality`, the Semgrep rule tests and repository scan, Fallow, and Vitest.
- `gate:ci` uses the same blocking checks and reports Fallow against its regression baseline.
- `gate:full` adds the local Sonar scan after `gate`.

Biome fixes and formatting remain separate, explicit commands:

```bash
bun run fix
bun run format
```

## Semgrep maintainability checks

Semgrep is executed through the pinned version in the root scripts:

```bash
bun run check:semgrep:rules
bun run check:semgrep
```

`check:semgrep:rules` validates the annotated positive and negative fixtures beside the rules.
`check:semgrep` scans the repository and fails on any finding.

Only deterministic, high-confidence syntax rules belong in this gate. A new rule must:

1. start with meaningful `ruleid` and `ok` fixtures;
2. avoid duplicating Biome, TypeScript, dependency-cruiser, Fallow, or Sonar;
3. pass its fixtures and a full-repository scan without accepted false positives.

Rules based on semantic guesses, model output, arbitrary size or usage thresholds, or source-text
keyword lists do not belong in Semgrep.

## Supabase contract

```bash
bun run test:supabase-contract
bun run test:supabase-local
```

Both names run the canonical local Auth/RLS contract. See [Deployment](DEPLOYMENT.md) for local and
managed staging prerequisites.
