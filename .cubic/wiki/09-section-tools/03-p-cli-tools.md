---
title: "Development diagnostics and publishing checks"
wiki_page_id: "p-cli-tools"
---

[Up one level](01-p-local-setup.md)

# Development diagnostics and publishing checks

The diagnostic commands inspect environment prerequisites separately from starting the application or running tests. This makes them useful when setup stops before the frontend and backend are ready. The report identifies missing runtime, tool or service requirements so the next action can target that boundary.

| Command | Inspection scope |
| --- | --- |
| `bun run doctor` | Runtime, installed tools and the Fallow baseline. |
| `bun run doctor -- --profile gate` | Local SonarQube readiness for Windows diagnosis. |
| `bun run doctor -- --profile local` | Local Supabase services and migration parity. |
| `bun run doctor -- --profile all` | Default checks and both service profiles. |

[scripts/doctor.ts](../../../scripts/doctor.ts) owns these checks. The diagnostic itself does not start services, change configuration or execute tests. Return to [local setup](01-p-local-setup.md) for service startup or [testing](02-p-testing-quality.md) for behavior evidence after resolving the reported prerequisite.

## Review bodies are rendered artifacts

The repository's GitHub-body helper validates a Markdown file before publication and compares the remote raw body with GitHub-rendered HTML afterward. This catches flattened Markdown or a remote body that differs from the reviewed file. Keep the body in a file so shell quoting does not become part of its formatting.

```bash
bun scripts/github-body.mjs validate --body-file body.md
bun scripts/github-body.mjs preview --repo immagiov4/Nous --body-file body.md
bun scripts/github-body.mjs update --kind pr --repo immagiov4/Nous --number 123 --body-file body.md
bun scripts/github-body.mjs verify --kind pr --repo immagiov4/Nous --number 123 --body-file body.md
```

`verify` reads the published artifact; `update` publishes the file and performs the same verification. Use `--kind issue` for an issue. The helper's check proves body identity and rendering, while [CI and review](02-p-testing-quality.md) establish the change's merge evidence. Detailed specialized test commands remain in [the testing guide](../../../docs/TESTING.md).
