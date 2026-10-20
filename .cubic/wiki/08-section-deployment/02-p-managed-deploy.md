---
title: "Managed Supabase deployment"
wiki_page_id: "p-managed-deploy"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Managed Supabase deployment

In the managed profile, the Nous application runs on the selected host while a managed Supabase project supplies authentication, PostgreSQL and storage. The application keeps its backend and workflow workers; moving data services changes network and credential configuration rather than moving generation into the browser.

## Public identity and internal connectivity must agree

The browser's public Supabase URL and the backend connection identify the same project. The browser uses the publishable or anonymous key, while database and service-role credentials remain server-side. Token issuer configuration must match the identity accepted by [authentication](../06-section-backend/02-p-auth.md), even when service routing uses a different internal address.

The [production environment example](../../../deploy/.env.production.example) and managed profile in the [deployment guide](../../../docs/DEPLOYMENT.md) own the required settings. Configure the application's public origin explicitly for CORS, including deployments whose backend listens on loopback behind a proxy. CORS governs browser origins and does not replace session verification or project authorization.

## Service availability is part of workflow operation

The backend needs database connectivity to create and resume durable runs, and storage connectivity to retrieve sources or adopt generated files. Provider readiness is another independent dependency. A frontend that serves successfully therefore cannot establish that generation and persistence work. Deployment health and contract checks exercise the relevant connections before the installation is considered ready.

## Recovery spans records and files

[Data ownership](../04-section-data/01-p-database-schema.md) explains which records reference stored bytes. The deployment guide owns backup scope, manifest integrity and restore proof; managed infrastructure does not remove the need to verify that those resources can be restored together. [Self-hosted topology](01-p-self-hosted.md) describes the alternative where the same services run under local operational control.

When changing deployment configuration, verify the public application path, authenticated backend requests and the data-service contract separately. [Testing and quality](../09-section-tools/02-p-testing-quality.md) identifies the repository's contract checks and exact-head merge requirement.
