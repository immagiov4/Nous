# OpenAI and Codex provider spike

Verified on 2026-07-11 against the official OpenAI documentation and the current Codex app-server
protocol. The local implementation was also probed with Codex CLI 0.144.0.

## Supported authentication

Nous supports two distinct OpenAI-owned integration paths.

### OpenAI API

The hosted backend calls the OpenAI API with a deployment-owned project API key loaded from
`OPENAI_API_KEY`. The browser never receives the credential. ChatGPT subscriptions and API billing
remain separate, so a ChatGPT plan is not used as API quota.

### Codex app-server

For an explicitly enabled local backend, Nous can launch `codex app-server --stdio`. Codex owns the
documented ChatGPT OAuth or device-code flow, persists and refreshes its own credentials under
`CODEX_HOME`, and exposes only account state, model capabilities, and generation events to Nous.
Nous does not read `auth.json`, copy tokens, or handle ChatGPT cookies.

The client follows the stable transport lifecycle used by
[T3 Code](https://github.com/pingdotgg/t3code): newline-delimited JSON over stdio, one
`initialize` request, the `initialized` notification, `account/read`, `model/list`, an ephemeral
`thread/start`, and `turn/start`. Output arrives through `item/agentMessage/delta` and finishes with
`turn/completed`. WebSocket transport is intentionally not used because the official app-server
documentation marks it experimental and unsupported.

Codex is opt-in through `CODEX_APP_SERVER_ENABLED=true` and requires `CODEX_OWNER_USER_ID`. Every
Codex account and generation route verifies both that owner id and the socket's loopback address.
The process is therefore unavailable to other Nous users and remote clients even if the feature is
enabled accidentally. It is not enabled in the production container: supporting a shared topology
would require an isolated process and `CODEX_HOME` per user.

Official evidence:

- [Codex app-server protocol and auth endpoints](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication)
- [ChatGPT subscriptions and API billing are separate](https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api)
- [Current OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation)

## Capability matrix

| Capability | OpenRouter | OpenAI API | Codex app-server | Nous contract |
| --- | --- | --- | --- | --- |
| Text generation and streaming | Chat Completions | Chat Completions through AI SDK/proxy | Ephemeral threads and streamed turn events | Same saved output |
| Structured output | Provider JSON schema | Provider JSON schema | `turn/start.outputSchema` | Same parser and validation |
| Product tools | AI SDK tool calls | AI SDK tool calls | App-server dynamic tools | Server tools execute directly; client tools return through the UI/Chat Completions contract |
| Reasoning effort | Model dependent | Model dependent | Model catalog and turn effort | Admin maps `none`, `low`, `medium`, `high` |
| Web research | OpenRouter search model | Existing research service | Existing research service | Research dossier remains authoritative |
| Image generation | OpenRouter Images API | OpenAI Images API | Not provided by Codex text adapter | OpenRouter/OpenAI image config remains separate |
| STT and TTS | Existing services | Not switched | Not switched | Shared audio pipeline remains unchanged |

The account area stores only the user's provider preference and sends it as an allowlisted request
header. Models and reasoning levels remain centralized in the admin configuration. Switching the
provider does not rewrite courses or other saved content.

## Adapter boundary

Prompt builders, response schemas, lesson persistence, retrieval, and product tools remain
provider-neutral. Provider adapters own only:

1. credential or local process selection;
2. the admin-selected model for each workload;
3. reasoning-option translation;
4. provider-specific transport and streaming frames;
5. safe failures and internal diagnostics.

Codex turns are ephemeral and expose only the dynamic tools declared for the current Nous request.
Shell, filesystem-backed command execution, browser/computer control, web search, apps, plugins,
MCP, and workspace capabilities are disabled when app-server starts. The child process receives an
allowlist of operating-system variables instead of the backend environment, so API keys, database
credentials, and Supabase secrets are not inherited. If Codex is disabled, missing,
unauthenticated, or rate-limited, the request fails explicitly; it never silently spends quota on
another provider.

## Credential lifecycle and revocation

- Rotate or revoke `OPENAI_API_KEY` in the OpenAI project and deployment secret manager, then roll
  the backend.
- Start Codex device login through app-server's `account/login/start`; only the verification URL,
  user code, and login id cross the Nous API.
- Cancel a pending login with `account/login/cancel` and disconnect with `account/logout`.
- Codex owns token persistence and refresh. Nous never returns provider credentials in an HTTP
  response or log.
- Disable `CODEX_APP_SERVER_ENABLED` to remove the local provider surface entirely.
- Log only safe operation context and status. Authorization headers, tokens, cookies, and Codex
  credential files are never logged.
