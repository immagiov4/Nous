---
title: "Self-hosted Deployment"
wiki_page_id: "p-self-hosted"
---

# Self-hosted Deployment

A self-hosted installation runs the Nous app and its data services in an environment controlled by the operator. The app can use a local Supabase stack or a separately managed Supabase project.

Start with the repository’s [deployment guide](../../../docs/DEPLOYMENT.md) and [production environment example](../../../deploy/.env.production.example) for the supported setup and required settings.

## What runs on the host

The installation includes the Nous web app and backend. Authentication, PostgreSQL and file storage are provided by Supabase. With the self-hosted profile, those Supabase services run alongside the app; with the managed profile, the app connects to a hosted Supabase project.

A Codex account integration is optional. If enabled, it runs privately on the server and must be authenticated by the operator. See [Codex account integration](../06-section-backend/03-p-codex-server.md).

## Backups and administrator access

Deployment backups include the database and uploaded source files stored in Supabase Storage. They do not include generated images, which are stored separately. During a restore, Nous checks the source files against the backup manifest before reconnecting them to projects.

An administrator must be configured before using account management and model settings. Keep service credentials on the server and follow the deployment guide when creating or restoring an installation.
