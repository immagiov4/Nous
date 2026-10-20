---
title: "Managed Deployment"
wiki_page_id: "p-managed-deploy"
---

# Managed Deployment

In a managed deployment, the Nous app runs on your host while Supabase provides authentication, PostgreSQL and file storage. The operator manages the app and its secrets; Supabase manages the hosted data services.

Start with the repository’s [deployment guide](../../../docs/DEPLOYMENT.md) and [production environment example](../../../deploy/.env.production.example) for the supported settings.

## Connect the app to Supabase

The public Supabase URL and the backend’s Supabase URL must point to the same project. Set the backend’s `CORS_ALLOWED_ORIGINS` to include the public origin where Nous is served.

The Supabase anonymous key is used by the browser. The service-role key and database credentials are private server settings and must never be exposed to the browser.

## Authentication and data access

Supabase Auth provides user identity. The backend validates the user’s session before serving private app requests and checks ownership when it loads or changes a project.

Database row-level security also applies to authenticated clients that connect directly to Supabase. Backend access uses server-side ownership checks because its privileged database connection does not rely on a learner’s database session.

## Project files and backups

Uploaded source files and generated images are stored in Supabase Storage, with project records keeping references to them. Backup manifests include content hashes so a restore can check file integrity. Files remain scoped to their project.

For a local Supabase installation, see [Self-hosted deployment](01-p-self-hosted.md).
