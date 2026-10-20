---
title: "Authentication and Access"
wiki_page_id: "p-auth"
---

# Authentication and Access

Supabase Auth identifies learners and administrators. The backend checks the session before serving private requests and uses the signed-in account to decide which projects a learner may access.

## Sign-in modes

Production uses Supabase sessions. Local development can use a restricted authentication bypass, and automated tests provide their own test identity. The bypass is intended for local and test environments.

The backend validates session tokens before trusting their account and role information. Invited users who still need to set a password must complete that step before using protected features.

## Project access

The backend checks project ownership when it reads or changes a project. Database row-level security also applies to authenticated clients that connect directly to Supabase.

Backend database requests use a privileged connection, so they rely on the backend’s own authentication and ownership checks. Row-level security does not replace those checks.

Administrators receive additional account and configuration access through their verified role. See [Admin area](../05-section-frontend/03-p-admin-ui.md) for the available controls.

## Sessions and account preferences

The web app refreshes a Supabase session when needed and prompts the learner to sign in again if refresh fails.

Account preferences can store the learner’s interface language, preferred AI language and teaching instructions. New course work reads those preferences, while existing courses keep the settings they were created with.
