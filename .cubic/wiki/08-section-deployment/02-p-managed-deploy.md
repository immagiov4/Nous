---
title: "Operate with managed data services"
wiki_page_id: "p-managed-deploy"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Operate with managed data services

Run the Nous app on your host and connect it to a managed Supabase project for authentication, PostgreSQL and file storage. Follow the managed profile in the [deployment guide](../../../docs/DEPLOYMENT.md).

## Configure the connection

Use the [production environment example](../../../deploy/.env.production.example). The browser's public Supabase URL and the backend URL must identify the same project. Set `CORS_ALLOWED_ORIGINS` to include the app's public origin.

The browser uses the public anonymous key; service-role and database credentials stay on the server. [Authentication and access](../06-section-backend/02-p-auth.md) explains the checks enforced on requests and direct database clients.

## Protect the saved work

[Project file storage](../04-section-data/02-p-asset-management.md) explains saved references and ownership. Use the deployment guide's backup and restore procedure for operator recovery, including manifest integrity checks.

Choose [self-hosted deployment](01-p-self-hosted.md) when running Supabase on your own infrastructure.
