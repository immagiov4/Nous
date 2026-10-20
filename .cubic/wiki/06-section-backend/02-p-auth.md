---
title: "Authentication and project access"
wiki_page_id: "p-auth"
---

[Up one level](../02-section-architecture/01-p-architecture.md)

# Authentication and project access

Supabase Auth identifies the account. The backend validates its session and checks ownership before reading or changing private project data.

## Session and role checks

Production uses Supabase sessions. The frontend refreshes sessions when needed and requests sign-in if refresh fails. Invited users complete password setup before using protected features. Administrator routes also check the verified role.

Local development can use the restricted bypass described in [local setup](../09-section-tools/01-p-local-setup.md). Automated tests supply their own identity.

## Database access

Authenticated clients connecting directly to Supabase are subject to row-level security. The backend uses a privileged database connection, so its own account and ownership checks are authoritative for backend requests.

Trace those checks in [backend routes](../../../apps/backend/src/routes/) before changing an access path. [Admin controls](../05-section-frontend/03-p-admin-ui.md) describe the additional operations available to administrators.
