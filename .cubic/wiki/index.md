[Repository front door](../../README.md)

# Developer manual

Read the first four pages in order for the system model, then follow the component relevant to your change. Each entry states the question its page answers. For a running checkout, start with local development under the final section.

## Understand the system

- [From sources to playback](01-section-overview/01-p-overview.md) — How does source material become a saved, playable lesson?
- [Architecture and ownership](02-section-architecture/01-p-architecture.md) — Which component owns each boundary in the system?
- [Learning design in the generation system](01-section-overview/02-p-manifesto.md) — Why are objectives, explanation, visuals and review separate concerns?
- [Durable workflow execution](02-section-architecture/02-p-workflow-engine.md) — How does generation resume safely across interruptions and concurrent workers?

## Trace generation and delivery

- [Course planning](03-section-features/01-p-course-gen.md) — How does the system turn a learning request into an ordered course plan?
- [Lesson generation](03-section-features/02-p-lesson-gen.md) — How is one planned objective converted into reviewed, persisted lesson content?
- [Source ingestion](03-section-features/03-p-doc-processing.md) — How do documents become retrievable evidence while retaining their context?
- [Narration and synchronized playback](03-section-features/04-p-multimedia.md) — How are lesson text, speech and visual cues kept on the same lesson version?
- [Saving and exporting a changing project](03-section-features/05-p-project-workspace.md) — How do project changes and exports preserve a coherent saved version?
- [Video research pipeline](03-section-features/06-p-youtube-research.md) — How does generation select a video as supporting evidence?
- [Contextual chat and tools](03-section-features/07-p-chat-ui.md) — How does a conversation receive the right lesson and source context?
- [Exercise and answer state](03-section-features/08-p-interactive-exercises.md) — How do generated activities stay consistent with lesson content and saved progress?
- [Reader composition and state](05-section-frontend/01-p-reader-shell.md) — How does the browser combine saved lessons, playback and study interactions?

## Inspect contracts and integrations

- [Durable data and ownership](04-section-data/01-p-database-schema.md) — Which records are authoritative, and how do project state and file bytes relate?
- [Asset adoption and cleanup](04-section-data/02-p-asset-management.md) — When does a generated or uploaded file become part of a project?
- [Curriculum validation contract](04-section-data/03-p-curriculum-contract.md) — What do the supplied-data curriculum validators establish?
- [HTTP and workflow boundaries](06-section-backend/01-p-api-routes.md) — How does an API request reach authorized work and report its result?
- [Authentication and authorization](06-section-backend/02-p-auth.md) — Where are account identity, role and project ownership enforced?
- [Private Codex adapter](06-section-backend/03-p-codex-server.md) — How does Nous use a host Codex account while retaining application tool boundaries?
- [Feedback persistence and publication](06-section-backend/04-p-feedback-system.md) — How does a private product report become a linked GitHub issue?
- [Workflow observability and usage](06-section-backend/05-p-telemetry-usage.md) — What can events and provider measurements establish about a run?
- [AI and speech provider boundaries](07-section-ai/01-p-ai-providers.md) — How are provider capabilities adapted without changing domain contracts?
- [Instruction composition and review](07-section-ai/02-p-prompt-engineering.md) — How do generation and review share meaning across tasks and providers?
- [Public presentation boundary](05-section-frontend/02-p-marketing-waitlist.md) — How does the public page demonstrate the product without generating private work?
- [Administrative service boundary](05-section-frontend/03-p-admin-ui.md) — How are privileged management and diagnostic surfaces separated from ordinary requests?

## Develop, verify and deploy

- [Local development setup](09-section-tools/01-p-local-setup.md) — How do I start a development instance with the same service boundaries?
- [Testing and merge evidence](09-section-tools/02-p-testing-quality.md) — Which checks establish that a change is ready to merge?
- [Development diagnostics and publishing checks](09-section-tools/03-p-cli-tools.md) — Which repository tools diagnose prerequisites and validate review artifacts?
- [Self-hosted deployment topology](08-section-deployment/01-p-self-hosted.md) — Which services and recovery boundaries belong to a self-hosted installation?
- [Managed Supabase deployment](08-section-deployment/02-p-managed-deploy.md) — How does the application connect to externally operated data services?
