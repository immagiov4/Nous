---
title: "Server-side Codex connection"
wiki_page_id: "p-codex-server"
---

[Up one level](../07-section-ai/01-p-ai-providers.md)

# Server-side Codex connection

An operator can authenticate Codex on the host and let Nous use that account through a private server process. Administrators and explicitly assigned users share the connection through Nous's authenticated API.

## Configure access

Follow the [local startup guide](../../../README.md#run-locally) for the enable setting and host authentication, then assign permitted users in the admin area. Requests depending on this connection require the host account to be available.

## Execution boundary

The process uses a restricted, read-only environment. Its built-in shell, browser, computer-control and plugin tools are disabled. Instructions also ask the model to avoid host files; those instructions alone cannot enforce host access restrictions.

Learning tools run through the normal application. Some actions execute on the server; others ask the web app to complete a workspace action such as adding a note. Supported research requests can use web search.

The server streams answers and records available usage. [Workflow events and usage](05-p-telemetry-usage.md) explains how to interpret those records.
