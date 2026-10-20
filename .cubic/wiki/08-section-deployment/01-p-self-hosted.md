---
title: "Self-hosted deployment topology"
wiki_page_id: "p-self-hosted"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Self-hosted deployment topology

A self-hosted installation runs the Nous application and its Supabase data services under the operator's control. The application still uses the same authenticated backend and durable workflows as other deployments; the topology changes who operates authentication, PostgreSQL and storage. The [deployment guide](../../../docs/DEPLOYMENT.md) owns executable setup and recovery procedures.

## Separate public entry from private services

The public origin reaches the application through the configured HTTPS and reverse-proxy boundary. Database, service-role and provider credentials stay with the backend. Supabase supplies authentication, PostgreSQL and file storage, and the browser receives only its public connection information. [Authentication](../06-section-backend/02-p-auth.md) explains why privileged backend connections still require per-request ownership checks.

Use the self-hosted profile in the [production environment example](../../../deploy/.env.production.example). The deployment scripts coordinate the pinned Supabase bundle, application services, migrations and health checks. Their preflight and contract checks test actual service connections rather than treating a built container as proof of a working installation.

An optional [Codex adapter](../06-section-backend/03-p-codex-server.md) uses a host-authenticated account through a private process. It adds an external account dependency and must remain behind the Nous backend; ordinary public app access does not require publishing its internal endpoint.

## Back up and restore

Operator backups include the database and uploaded sources in Supabase Storage. Generated images use separate storage and are outside those deployment backups. That scope affects what can be recovered from an installation backup and differs from [portable project exports](../03-section-features/05-p-project-workspace.md).

Restore checks source files against the backup manifest before reconnecting them. The deployment guide's restore proof establishes recoverability from the captured artifacts; a successful backup command alone only establishes artifact creation. Follow the same guide for rollback and health verification after a deployment change.

Choose [managed data services](02-p-managed-deploy.md) when Supabase infrastructure is operated elsewhere. Both profiles preserve the application and data ownership boundaries described in the architecture.
