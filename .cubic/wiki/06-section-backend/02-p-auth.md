---
title: "Authentication and authorization"
wiki_page_id: "p-auth"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Authentication and authorization

Supabase Auth issues the account session, and the backend verifies it before accessing private project services. The verified subject identifies the account; role and provider assignments come from the accepted session metadata. Project ownership remains a separate check at the operation boundary.

## Verify the session before trusting its claims

The [current-user resolver](../../../apps/backend/src/auth/currentUser.ts) accepts supported signed tokens and validates expiration, issuer and audience before producing an account identity. HS256 installations supply a server secret; asymmetric installations use Supabase key discovery or an explicit key endpoint. Internal service URLs can differ from the public token issuer, so deployment must preserve the issuer identity independently of network routing.

The frontend refreshes sessions when needed and returns to sign-in when refresh fails. Accounts requiring password setup have a restricted completion path before protected features become available. Administrative routes check the verified role in addition to authentication. Hiding a browser control cannot substitute for those server checks.

## Privileged persistence requires explicit ownership checks

The backend uses privileged database and storage credentials. Its account and ownership checks are therefore authoritative for requests passing through it. Authenticated clients that connect directly to Supabase are subject to row-level security, which is a different enforcement path. A passing direct-client RLS test does not by itself cover a backend route using privileged access.

Project incarnation and source-version checks further constrain retained references, including archive retrieval. Trace the handler and owning service together when adding an access path; accepting a project identifier from the client is insufficient authorization.

## Development identity is deliberately bounded

Tests can supply controlled identity. Local bypass additionally requires the explicit local-development flags described in [setup](../09-section-tools/01-p-local-setup.md#local-authentication). It still uses server project persistence, so bypass changes authentication rather than creating a browser-only storage mode. Deployment and trusted network exposure must be considered together because CORS controls browser origins and does not authenticate an account.
