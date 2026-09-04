# Cloudflare Free deployment contract

Status: research complete. External Cloudflare deployment test: not run.

Date: 2026-09-04

Issue: [#26](https://github.com/immagiov4/Nous/issues/26)

## Scope

This document compares the Nous HTTP contracts with Cloudflare Free limits for
three deployment shapes:

1. An orange-cloud proxied Bun origin.
2. A Cloudflare Worker or Pages Function that runs in the request path.
3. A DNS-only origin that bypasses the Cloudflare proxy for the tested host.

The repository contains a Bun frontend and backend Compose deployment. It does
not contain a Worker, Pages Function, Cloudflare configuration, or a Cloudflare
deployment manifest. The conclusions for Cloudflare are therefore a contract
assessment, not a result from a deployed Nous instance.

No application threshold, retry policy, fixture size, or deployment setting is
changed by this document.

## Result

Nous has the application paths needed for the two operations that are unsafe to
keep in one long HTTP request:

- Project and backup imports use a direct request below the configured direct
  limit, or sequential text and binary chunks followed by a completion request.
  If completion returns an ambiguous network error, the browser checks the
  upload status before reporting failure.
- Course and lesson generation starts a durable workflow and returns a job. The
  browser polls the job status. The workflow worker runs outside the request
  that created the job.

Cloudflare Free adds two boundaries that the application contract does not
remove:

- Cloudflare documents a 100 MB request body limit for Free. A proxied request
  above that limit can fail at the edge with HTTP 413 before Bun sees it.
- Cloudflare documents a 125-second proxy read timeout and a 30-second proxy
  write timeout for the origin connection. A long request or stream that does
  not meet the relevant connection behavior needs a staging test. The existing
  Nous code does not prove that an SSE connection remains valid through every
  Cloudflare path.

The supported Free-plan shape for large imports is therefore the existing
chunked route, subject to the active application configuration and a single
backend session. The aggregate upload may be larger than 100 MB because each
chunk is a separate request. A direct or multipart request whose body exceeds
100 MB is not a Cloudflare Free contract, even when the Bun parser accepts it.

The production decision remains open between an orange-cloud proxy and a
Worker or Pages Function. A Pages static site limit does not describe the API:
Pages static assets have their own 25 MiB per-asset limit, while Pages Functions
are billed and limited as Workers.

## Cloudflare limits by deployment shape

| Deployment shape | Cloudflare contract relevant to Nous | What it does not cover |
| --- | --- | --- |
| Orange-cloud proxy to the Bun origin | Free request body limit 100 MB; proxy read timeout 125 seconds; proxy write timeout 30 seconds; URL limit 16 KB; request-header limit 128 KB | Bun memory, `/tmp`, application parser limits, workflow worker state, and database timeouts remain origin concerns |
| Worker or Pages Function in the request path | Request body limit 100 MB on Free; 128 MB Worker memory; 10 ms Free CPU per HTTP request; 100,000 Workers Free requests per day; a connected HTTP request has no general Worker wall-time limit, but stream and client disconnect behavior still apply | These limits do not turn the Bun process into a Worker. A Function that only forwards traffic has different responsibilities from one that parses or assembles an import |
| DNS-only origin | The tested HTTP hop does not pass through the Cloudflare proxy | This removes Cloudflare proxy protection and edge behavior for that host. It is a deployment choice, not a default for this repository |
| Pages static assets | Free Pages sites allow 20,000 files, and one static asset can be at most 25 MiB | This is not the limit for an API request sent to a Pages Function or to a separate Bun backend |

The Workers Free request quota is shared by Workers and Pages Functions. Waiting
for network I/O does not count as Worker CPU, but request parsing, data
transformation, and application code still consume the Worker memory and CPU
budgets. The 100 MB request-body limit applies before an application can choose
to split the body itself. A client must send chunks as separate requests.

Cloudflare's 125-second proxy read timeout is not a guarantee for a long-lived
Nous stream. Cloudflare's connection documentation describes a timeout between
reads from the origin, while its 524 guidance recommends status polling for
long processes. The external test in this document must measure the actual
first-byte and inter-event behavior instead of treating the limit as a stream
keep-alive promise.

## Nous request contracts

The application values below are repository defaults at the commit reviewed for
this issue. Production can override the project import values through the
`PROJECT_IMPORT_*` environment variables. The browser reads the public values
from `GET /api/projects/config`.

| Operation | Nous route and transport | Application contract | Cloudflare Free consequence |
| --- | --- | --- | --- |
| Direct project or backup import | `POST /api/projects/import`, JSON | The serialized `data` limit is `directMaxBytes`, 20,000,000 bytes by default. The JSON parser limit is `directMaxBytes + 1,024`, 20,001,024 bytes by default. | The application limit is lower than 100 MB, so a request rejected by this parser is an application 413. A body above 100 MB can be rejected by Cloudflare before the backend. |
| Text backup chunks | `PUT /api/projects/import/chunks/:uploadId/:chunkIndex`, `text/plain` | The parser limit is `maxChunkBytes`, 16,000,000 bytes by default. The upload validates UUID, index, count, byte count, ownership, duplicate content, and aggregate `maxSerializedBytes`, 280,000,000 bytes by default. Each accepted chunk returns 202. | Each chunk is below the documented 100 MB edge body limit. The complete backup can exceed 100 MB because it is sent as multiple requests. The session remains process-local and uses local temporary storage. |
| Binary source archive or backup chunks | The same chunk route with `application/octet-stream`, followed by `POST /api/projects/import/chunks/:uploadId/complete` | The browser slices the `Blob` at the public `maxChunkBytes` value. The backend writes temporary parts, assembles them during finalization, and imports the result. | The edge sees bounded requests. Cloudflare does not make the process-local session durable across a backend restart or safe across multiple backend replicas. |
| Archive project save | `PUT /api/projects/projects/:id`, JSON or multipart | The project JSON parser allows 300,000,000 bytes. The multipart snapshot limit is 300,000,000 bytes. The compressed source-archive limit is 256,000,000 bytes. When the browser has an `archiveFile`, `httpProjectRepository` uses the chunked binary path instead of this multipart body. | A direct JSON or multipart body above 100 MB is not reachable through a Free proxied edge, even if the origin parser accepts it. The 300 MB origin limit is not a Cloudflare Free limit. |
| Workflow start | `POST /api/course-workflows/courses` or `POST /api/lesson-workflows/lessons` | The route validates a request key and returns 202 for a newly created job, or 200 when an existing request is reused. The browser polls a run-status route at a 1-second interval until a terminal state. | The start request and each poll are small HTTP requests. Long model work does not need to hold the start request open. A slow start route would still be subject to the proxy read timeout. |
| Workflow execution | Background workflow worker and Postgres state | The production workflow registry uses a 10-minute step timeout and up to 3 attempts for the relevant generation workflows. This is an application step contract, not a Cloudflare request timeout. | A running workflow is not evidence that a single HTTP request can remain open for the same period. Keep the client on the start-and-poll path. |
| Project revision events | `GET /api/projects/events`, SSE | The backend sends `text/event-stream`, flushes headers, sends a reconnect hint of 2 seconds, and writes a heartbeat every 25 seconds. The browser reconnects and requests a catch-up. | The route must be tested through the selected edge. The repository setting `X-Accel-Buffering: no` affects a compatible origin proxy and does not establish a Cloudflare stream guarantee. |
| AI streaming | OpenRouter and context chat SSE paths | The backend either writes SSE frames or pipes the upstream response body. The context chat aborts the model request when the client closes the response. | A Worker can stream a response body, but the complete Worker or origin path still needs testing for headers, first byte, idle gaps, client disconnects, and upstream errors. |

### Import recovery boundary

The browser's chunked importer is resumable across an ambiguous completion
response while the backend session still exists. It is not a durable upload
queue. `projectImportChunks.ts` stores the session map in process memory and
parts below the operating-system temporary directory. The supported Compose
deployment runs one backend replica. A restart, a different backend replica, or
an origin replacement can make the upload status unavailable and require a new
upload.

Admission is also process-local. The default configuration allows two active
uploads globally, one active upload per user, one finalization globally, four
import requests globally, and one import request per user. These values limit
origin work. They do not reserve Cloudflare capacity and do not change the
Cloudflare request-body limit.

## Failure classification and evidence

The test operator must classify each failure by the layer that produced it.

| Observation | Likely layer | Evidence to retain |
| --- | --- | --- |
| HTTP 413 with a Cloudflare error page and no backend `x-request-id` | Cloudflare edge | HTTP status, response headers, response body class, Cloudflare Ray ID when present, measured request bytes, deployment shape, and zone plan |
| HTTP 413 with the backend `x-request-id` and a sanitized application error | Nous parser or route validation | `x-request-id`, route, measured request bytes, backend log entry with `request_payload_too_large`, and whether the edge was bypassed |
| HTTP 429 from a chunk or completion request with `Retry-After: 1` | Nous import admission or another explicit application capacity guard | `x-request-id`, route, upload ID with user data excluded, `Retry-After`, backend capacity log, and active replica count |
| HTTP 524 or a connection failure before the backend returns a response | Cloudflare-to-origin connection path | Cloudflare status and Ray ID when present, origin access-log timestamps, first-byte timing, request method and route, and whether the origin was DNS-only |
| SSE starts, then stops after a client or proxy disconnect | Stream path or client network | First-byte time, last received event or heartbeat time, reconnect result, backend `disconnected` log, and edge response metadata |
| Workflow start returns a job but a poll returns a terminal failure | Nous workflow or provider path | `runId`, request key correlation, workflow status and failure code, `x-request-id` for the start and poll, and backend workflow diagnostics |
| A Worker invocation reports exceeded CPU or memory | Worker execution path | Worker outcome and log event, request size, code path, and whether the Function parsed or copied the body |

The application assigns a correlation ID to every backend request and exposes it
as `x-request-id`. It records incomplete responses as `disconnected` and maps
body-parser rejections to the internal failure code
`request_payload_too_large`. These fields let the operator distinguish a
backend rejection from an edge rejection. A Cloudflare error page without the
backend correlation header is not proof that the origin application failed.

## External deployment test protocol

This protocol is not executed in this repository because no Cloudflare account,
zone, staging origin, or test deployment is available here. The operator must
use a disposable staging environment and synthetic data. Do not send production
documents, private prompts, access tokens, database exports, or credentials to
the test deployment.

### Record the deployment

Before sending a request, record:

- the exact commit and container image used by the origin;
- whether the route is orange-cloud proxied, handled by a Worker or Pages
  Function, or DNS-only;
- the Cloudflare account and zone plan, relevant upload-size setting, and
  Worker or Pages Function binding if one exists;
- the origin replica count and whether all requests reach the same backend
  process;
- the values returned by `GET /api/projects/config`;
- the measured byte count and content type of every fixture;
- the request timestamp, response timestamp, status, response headers, and
  whether the response came from the edge or the origin.

Use synthetic authenticated users and projects. Keep the fixture files outside
the repository and record their measured sizes in the test report. Select
boundary fixtures from the active application values and the documented
Cloudflare limit. Do not introduce a new application limit or commit a large
fixture to make the test pass.

### Test request body limits

Run each case against the same URL through the selected deployment shape, then
repeat the cases against the origin path when the operator can do so safely.

1. Read the active import values from `/api/projects/config`.
2. Send a direct JSON import whose serialized data is below the active
   `directMaxBytes` value. Confirm that the response reaches Nous and that the
   imported project can be read back.
3. Send a direct JSON import above the active direct value but below the
   Cloudflare Free body limit. Confirm whether Nous returns its application
   quota error and `x-request-id`.
4. Send a request at the documented Cloudflare Free body boundary and one above
   it with synthetic content. Record whether the edge or the origin rejects
   each request. Do not use the edge result to infer the application limit.
5. Send a text import as chunks using the values returned by `/api/projects/config`.
   Complete it, read the status route, and verify the imported project.
6. Repeat one chunk after an intentional client-side response loss. Confirm the
   server's duplicate handling and the browser's completion-status recovery.
7. Repeat the binary archive path with a synthetic archive. Confirm that each
   request is bounded, that completion is separate from transfer, and that a
   failed completion can be resolved through the status route.
8. Run the direct JSON and multipart archive paths only when the staging route
   needs them. Record the point at which the edge rejects a body that the origin
   accepts.

The test passes the body-size part when the report identifies the rejecting
layer for every case, records the active application value, and shows that the
chunked path can transfer an aggregate payload larger than one edge request
without exceeding the per-session application limit.

### Test long operations

Use a staging workflow that takes long enough to exercise the start-and-poll
contract. Do not hold the workflow-start request open while waiting for model
work.

1. Start a course or lesson workflow with synthetic project data and a unique
   request key.
2. Record the start response status, first-byte time, `runId`, and
   `x-request-id`.
3. Poll the run-status route until it reaches a terminal state. Record every
   status transition and the request IDs for the polls.
4. Compare the workflow duration and any step timeout with the edge connection
   timings. A 524 on the start request is an edge or origin connection failure,
   not a workflow-step failure.
5. If the staging setup has a controlled route that delays the first origin
   response, run it as a separate edge timing probe. Do not add such a route to
   the production application only for this test.

The test passes the long-operation part when the start request returns a job
before the edge timeout, polling observes the durable status, and any workflow
failure carries a Nous failure code rather than being reported as an HTTP
timeout with no run identity.

### Test streaming

Run the following with a client that records raw event timestamps and does not
buffer the response:

- `/api/projects/events` with an authenticated synthetic user;
- one context-chat or OpenRouter stream using synthetic input;
- the same stream through the selected Cloudflare deployment and directly to
  the origin when the origin path is available.

For each stream, record time to headers, time to first event, event or heartbeat
intervals, response headers, the result after the client closes the connection,
and whether the browser reconnects. Test an idle interval that is long enough to
exercise the documented proxy read behavior. The result is inconclusive if the
test never passes through the intended Cloudflare path or if the client buffers
the stream.

The test passes the stream part only when the report identifies the behavior of
each route through the selected deployment. The Cloudflare documentation alone
does not establish a Nous SSE support guarantee.

## Open decisions

The following decisions need an operator or product owner. This document does
not choose them:

- Choose whether production uses an orange-cloud proxy to the Bun origin or a
  Worker or Pages Function in the request path.
- Decide whether the public backend will remain on the proxied edge for large
  imports, or whether a separate DNS-only upload origin is acceptable. A
  DNS-only path changes the security and operational contract.
- Decide whether SSE remains a supported production path through the selected
  edge after the external stream test, or whether a feature uses workflow
  polling for progress instead.
- Decide how a horizontally scaled backend will share chunk sessions and
  temporary parts. The existing process-local session design assumes one
  backend replica.
- Decide which staging account, synthetic fixtures, and operator-run timing
  report will become the release evidence for issue #26.

No new threshold, edge-specific fallback, or deployment bypass is proposed in
this change. The existing chunked import and workflow polling paths are the
available paths to test first.

## Local evidence

The repository inspection covered these implementation points:

- `apps/backend/src/index.ts` applies route-specific JSON limits, the configured
  chunk parser limit, `x-request-id`, and the sanitized 413 diagnostic.
- `apps/backend/src/projects/projectImportConfig.ts` defines and validates the
  public import values.
- `apps/backend/src/projects/projectImportChunks.ts` owns the process-local
  upload sessions, temporary part files, finalization, and cleanup.
- `apps/backend/src/routes/projects.ts` implements direct import, chunk upload,
  completion, status, and project revision SSE.
- `apps/web/services/projects/httpProjectRepository.ts` reads the transfer
  contract, slices text and binary payloads, retries ambiguous transfers, and
  polls completion status.
- `apps/backend/src/workflows/runtime/workflowRuntimeComposition.ts`, the
  workflow route modules, and
  `apps/web/services/openrouter/workflowClientTransport.ts` implement durable
  start-and-poll generation.
- `apps/backend/src/routes/openRouterProxy.ts` and
  `apps/backend/src/routes/contextChat.ts` implement the AI streaming paths.
- `apps/backend/tests/index.test.ts` checks sanitized 413 diagnostics.
- `apps/backend/tests/routes/projects.test.ts` checks the public import contract,
  text and binary chunk handling, duplicate chunks, completion, and status.

The existing tests are local application tests. They cannot prove Cloudflare
plan limits, proxy timeouts, Worker quotas, or Pages routing.

## Sources

Cloudflare documentation was read on 2026-09-04. The links below are the
authoritative sources used for the platform claims in this document.

- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/), updated 2026-07-28. Request body, CPU, memory, request quota, URL, and header limits.
- [Cloudflare HTTP 413 errors](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/), updated 2026-09-03. Cloudflare upload-size behavior and the Free 100 MB limit.
- [Cloudflare connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/), updated 2026-07-23. Proxy read and write timeouts and connection limits.
- [Cloudflare HTTP 524 errors](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/), updated 2026-07-23. Origin response timeout behavior and status-polling guidance.
- [Workers Streams API](https://developers.cloudflare.com/workers/runtime-apis/streams/), updated 2026-08-26. Streaming request and response bodies and client disconnect behavior.
- [Workers error observability](https://developers.cloudflare.com/workers/observability/errors/). Worker outcomes and error reporting.
- [Pages platform limits](https://developers.cloudflare.com/pages/platform/limits/), updated 2026-07-16. Static site file and asset limits.
- [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/), updated 2026-04-21. Pages Functions relationship to Workers and the free request quota.
