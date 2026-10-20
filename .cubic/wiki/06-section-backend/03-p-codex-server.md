---
title: "Codex Account Integration"
wiki_page_id: "p-codex-server"
---

# Codex Account Integration

A self-hosted Nous instance can connect an administrator’s ChatGPT account through a private Codex process on the server. Learners use Nous’s authenticated web app; they do not connect to that process directly.

Administrators can grant access to assigned users. The server streams the response to the web app and records available usage information.

## Access and tools

The Codex process runs on the server with a restricted, read-only environment. Its built-in shell, browser, computer-control and plugin tools are disabled. Instructions sent to the model ask it not to inspect host files, but those instructions do not enforce the operating-system boundary.

Some learning actions run on the server; others ask the web app to complete an action such as adding a note. This keeps access to the learner’s workspace within the normal authenticated application.

## Research and model choices

Nous maps supported AI tasks to the models selected by the administrator. Web search is available for research requests that use this integration.

The service requires an authenticated Codex account on the host. If the account is unavailable, requests that depend on it cannot run.
