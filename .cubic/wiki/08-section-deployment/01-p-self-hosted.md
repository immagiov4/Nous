---
title: "Operate a self-hosted installation"
wiki_page_id: "p-self-hosted"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Operate a self-hosted installation

Run the app alongside the self-hosted Supabase services when you want the application and its data under your control. The supported setup, environment settings and health checks live in the [deployment guide](../../../docs/DEPLOYMENT.md).

## Set up the host

Follow that guide with the self-hosted profile and [production environment example](../../../deploy/.env.production.example). Supabase supplies authentication, PostgreSQL and file storage. Configure an administrator for account management and model settings.

An optional [Codex connection](../06-section-backend/03-p-codex-server.md) runs privately on the host and requires operator authentication. Keep server credentials within the installation.

## Back up and restore

Operator backups include the database and uploaded sources in Supabase Storage. Generated images have separate storage and are outside those deployment backups. Restore checks source files against the backup manifest before reconnecting them. Follow the deployment guide's restore proof before relying on a backup.

For hosted Supabase data services, choose [managed deployment](02-p-managed-deploy.md). For a learner's portable archive, see [project backups](../03-section-features/05-p-project-workspace.md).
