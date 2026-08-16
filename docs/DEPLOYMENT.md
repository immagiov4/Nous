# Production deployment

Nous Reader ships one application artifact: static frontend, Bun backend, migration job, and optional operational tools. It supports two validated Supabase profiles without product forks:

- `managed`: connect to one remote Supabase project; Compose starts only Nous Reader.
- `self-hosted`: start the separate official Supabase Docker bundle pinned by `deploy/SUPABASE_VERSION`, then start the same Nous Reader images.

The wrappers are thin Compose frontends. They do not install an application runtime, manage arbitrary host processes, or reimplement Supabase.

## Host preflight

The only application prerequisite is Docker Engine/Desktop with Docker Compose 2.24 or newer. The wrapper checks, in order:

1. supported 64-bit OS/architecture;
2. Docker command missing;
3. daemon stopped/unreachable versus daemon permission failure;
4. Compose v2 missing;
5. deployment directory and env availability;
6. profile, URL, port, credential, and Compose configuration.

Linux installation or account permission changes remain explicit operator actions. On Windows, an installed but stopped daemon makes the PowerShell wrapper run the official `docker desktop start --timeout 120`, verify `docker info`, and fail with a direct manual-start instruction if Docker Desktop still is not reachable. macOS operators start Docker Desktop through Docker's official distribution. The wrappers never install system software or elevate silently. Standalone Compose v1 is unsupported.

Compose binds frontend/backend to `127.0.0.1` by default. The configured host ports must be free when `up` runs. A collision fails normally; the scripts never search for or terminate unrelated listeners.

## Initial configuration

```bash
cp deploy/.env.production.example .env.production
```

Choose exactly one profile:

```dotenv
SUPABASE_DEPLOYMENT=managed
# or
SUPABASE_DEPLOYMENT=self-hosted
```

Set the three public URLs and external AI credentials. The browser receives only the public backend URL, public Supabase URL, and publishable/anon key. Database, service-role, JWT, OpenRouter, and OpenAI secrets remain server-side and are excluded from the image context.

Check key names without printing values:

```bash
sh deploy/nous.sh config
# Windows: deploy/nous.ps1 config
```

### In-app feedback delivery

This integration is optional: leave both GitHub settings empty to keep reports only in the private
admin inbox. To enable it, set `GITHUB_FEEDBACK_REPOSITORY` to the destination in
`owner/repository` form and keep `GITHUB_FEEDBACK_TOKEN` only in `.env.production`. Use a
fine-grained token restricted to that repository with Issues read/write permission. Compose passes both values only to the backend;
screenshots remain in the private database and are never published as public assets.
The destination repository must contain the `source:user-feedback` and `triage:unreviewed`
labels; Nous also applies the standard `bug` or `enhancement` label selected by the user.
The backend mirrors every repository issue (excluding pull requests) on startup and then every
five minutes. Admins can also trigger the same paginated synchronization from Reports; GitHub
remains authoritative for issue title, body, labels, and open/closed state. Reports whose issue is
absent from a complete mirror are marked as missing without discarding their private diagnostics;
GitHub-only rows are removed only after two consecutive complete mirrors.

### Timestamped YouTube demonstrations

Timestamped practical segments are enabled automatically whenever Decodo is configured. Nous uses
the official privacy-enhanced YouTube player with bounded `start`/`end` parameters; it does not
download, trim, or rehost videos. The player is mounted only after the learner presses Play.

YouTube often blocks direct transcript requests from datacenter IPs. For a VPS, configure Decodo's
YouTube Search and YouTube Subtitles targets. Candidate discovery and transcript retrieval use
Decodo exclusively. The backend sends one search request followed by at most six subtitle requests,
one per selected video. Each subtitle response contains all available languages and subtitle
origins, which are selected and compacted locally. At most two playlist results and four preview
videos per playlist are considered:

```dotenv
DECODO_SCRAPING_API_KEY=replace_with_decodo_api_key
```

Keep the key only in `.env.production`; Compose passes it to the backend and never includes it in
the frontend or image. Successful transcripts are cached for six hours, including concurrent
requests for the same video. Failed lookups are cached for 15 minutes.

### Per-machine backup import capacity

Backup import limits are startup configuration, not account or installation limits. The defaults
allow two simultaneous uploads on a small VPS, while one finalization at a time performs the
memory-heavy JSON parse and database import. A redeploy applies changed values.

The browser reads the public transfer limits from `/api/projects/config`, splits serialized project
data into UTF-8 `text/plain` chunks, unzips full-library backups locally, and sends projects one at a
time. The server still validates byte counts, session ownership, chunk order, archive contents, and
database writes. The 16 MB default chunk stays well below common reverse-proxy request limits while
avoiding the request count produced by the former 4-million-character chunks.

Tune these groups together in `.env.production`:

- Container budget: `NOUS_BACKEND_MEMORY_LIMIT`, `NOUS_BACKEND_CPU_LIMIT`, and
  `NOUS_BACKEND_TMPFS_SIZE`. Temporary storage must cover active chunk sets and one assembled copy;
  the supplied two-upload configuration uses a 1 GB tmpfs.
- Active work: `PROJECT_IMPORT_ACTIVE_UPLOADS_GLOBAL`,
  `PROJECT_IMPORT_ACTIVE_UPLOADS_PER_USER`, and `PROJECT_IMPORT_FINALIZATIONS_GLOBAL`.
- In-flight HTTP bodies: `PROJECT_IMPORT_REQUESTS_GLOBAL` and
  `PROJECT_IMPORT_REQUESTS_PER_USER`. These limit concurrent chunk requests, not active sessions.
- Transfer shape: `PROJECT_IMPORT_DIRECT_MAX_BYTES`, `PROJECT_IMPORT_MAX_CHUNK_BYTES`,
  `PROJECT_IMPORT_MAX_CHUNK_COUNT`, and `PROJECT_IMPORT_MAX_SERIALIZED_BYTES`.
- Lifecycle: `PROJECT_IMPORT_REQUEST_TIMEOUT_MS`, `PROJECT_IMPORT_RECEIVING_TTL_MS`,
  `PROJECT_IMPORT_COMPLETED_TTL_MS`, and `PROJECT_IMPORT_CLEANUP_INTERVAL_MS`.

The backend fails at startup when per-user limits exceed global limits, chunk capacity cannot cover
the maximum serialized backup, finalization concurrency exceeds active uploads, or cleanup runs less
often than the receiving-session TTL. The current in-memory admission/session registry assumes the
validated single backend replica in `compose.yml`; multiple backend replicas require shared session
coordination before scaling horizontally.

Project-source creation uses the authenticated `/api/projects` write path, whose JSON body limit is
300 MB so a 128 MB ZIP plus transport encoding and project metadata fits. The public reverse proxy
in front of `NOUS_BACKEND_PUBLIC_URL` must allow at least the same request size and a timeout suitable
for the Storage upload and archive indexing pass. The archive's expanded-content limits are separate
and documented in [Architecture](ARCHITECTURE.md#large-source-archives).

### Managed profile

Fill `SUPABASE_URL`, `NOUS_SUPABASE_PUBLIC_URL`, `DATABASE_URL`, publishable/anon key, and service-role/secret key from one managed project. `config` rejects mismatched Supabase API origins and requires either the legacy JWT secret or a JWKS URL. It never rewrites remote credentials or generates managed-project secrets.

Use a direct or session-pooler Postgres connection suitable for migrations. A remote production database is not a place to run destructive contract tests; use a protected staging project.

### Self-hosted profile

Set `SUPABASE_DEPLOYMENT=self-hosted`, public app/backend/Supabase URLs, and external provider credentials, then run `setup`. The wrapper:

1. performs a sparse Git fetch of only the official `supabase/supabase` `docker/` directory at the exact commit in `deploy/SUPABASE_VERSION` and verifies `FETCH_HEAD`;
2. places that upstream distribution in ignored `deploy/supabase-project/` and records the pin;
3. copies the upstream env template;
4. invokes upstream `utils/generate-keys.sh --update-env` and `utils/add-new-auth-keys.sh --update-env` inside a Node/OpenSSL container;
5. suppresses key output and copies only the required generated values into the untracked Nous env;
6. configures upstream public Auth/Site URLs and starts the official Compose project as `nous-reader-supabase`;
7. waits for its gateway/database healthchecks before migrating or starting Nous Reader.

The repository does not copy or fork the Supabase Compose file. A second setup reuses the recorded pin and existing secrets. If the pin changes while a bundle exists, setup stops and requires the explicit upgrade procedure below.

Self-hosting makes the operator responsible for TLS, WebSockets, patches, monitoring, SMTP, backups, and disaster recovery. Follow Supabase's [Docker guide](https://supabase.com/docs/guides/self-hosting/docker), [self-hosting responsibilities](https://supabase.com/docs/guides/self-hosting), and [reverse-proxy requirements](https://supabase.com/docs/guides/self-hosting/self-hosted-proxy-https). The Supabase CLI local stack remains development-only.

## Setup and normal operations

Linux/macOS:

```bash
sh deploy/nous.sh setup
sh deploy/nous.sh status
sh deploy/nous.sh logs backend
sh deploy/nous.sh smoke
sh deploy/nous.sh redeploy
sh deploy/nous.sh down
```

Windows PowerShell exposes the same commands through `deploy/nous.ps1`.

- `setup` validates/generates configuration, starts the selected infrastructure, builds with frozen `bun.lock`, applies migrations, waits for health, and runs smoke checks.
- `status` prints frontend/backend state and, for self-hosted, the official Supabase service health table. It preserves Compose's `starting`, `healthy`, `unhealthy`, and exit states.
- `smoke` verifies frontend, backend, Supabase Auth gateway, database readiness, and `select 1` without exposing credentials.
- `redeploy` validates and builds before migration/switch, operates only on the `nous-reader` Compose project, waits for health, and preserves external Supabase services, volumes, and secrets.
- `down` stops only Nous Reader. It deliberately does not stop or delete the separate self-hosted database project and never uses `down -v`.

Frontend/backend health endpoints are `/health`. The official self-hosted gateway and database retain their upstream healthchecks. Reverse proxies point to stable host binds (defaults 8080 and 3301); Postgres, Studio, and administrative services must not be published to the internet.

### Regenerate course covers

An authenticated user can regenerate all covers for courses they own through the public backend origin configured as `NOUS_BACKEND_PUBLIC_URL`:

```bash
curl -fsS \
  -H "Authorization: Bearer $NOUS_ACCESS_TOKEN" \
  -H "Accept: application/json" \
  https://api.reader.example.com/api/projects/covers/regenerate
```

Replace the host with the deployed `NOUS_BACKEND_PUBLIC_URL` and supply a current Supabase access token. The frontend origin does not proxy `/api`; production returns HTTP 404 for `/api` paths sent to `NOUS_PUBLIC_URL`. In local development the direct backend URL is `http://127.0.0.1:3301/api/projects/covers/regenerate`. The route returns `Cache-Control: no-store`, never accesses another user's courses, and returns the job immediately with HTTP 202 while it is running.

Poll the status-only route; unlike the start route, it never creates a new job:

```bash
curl -fsS \
  -H "Authorization: Bearer $NOUS_ACCESS_TOKEN" \
  -H "Accept: application/json" \
  https://api.reader.example.com/api/projects/covers/regenerate/status
```

The backend runs at most four cover operations globally and schedules users fairly. Simultaneous start calls for one user share the running job, and a completed job is reused for 15 minutes. Results are `regenerated`, `skipped`, or `failed`; every non-success leaves the previous cover untouched. A response looks like:

```json
{
  "success": true,
  "job": {
    "id": "course-cover-p2-job-id",
    "promptVersion": 2,
    "status": "running",
    "startedAt": "2026-07-17T00:00:00.000Z",
    "updatedAt": "2026-07-17T00:00:00.000Z",
    "results": [],
    "summary": {
      "total": 4,
      "pending": 4,
      "regenerated": 0,
      "skipped": 0,
      "failed": 0
    }
  }
}
```

Job state and the 15-minute cooldown are in memory because the supported Compose deployment runs one backend replica. Restarting or redeploying the backend clears that state; already persisted covers are not removed. The admin configuration screen provides authenticated start and polling controls, so operators do not need to copy browser tokens into a command.

`LOCAL_AUTH_BYPASS=true` removes the bearer-token requirement only for the explicitly enabled local development profile; production and VPS deployments must always send the authenticated session token.

### Optional Codex app-server

An operator-controlled private instance can use one Codex CLI account for administrators and users explicitly assigned to Codex. Set `CODEX_APP_SERVER_ENABLED=true` before `setup` or `redeploy`. The backend image contains the pinned CLI and CA trust store; the wrapper adds a private persistent `CODEX_HOME` volume only when Codex is enabled. The app-server remains a child process over stdio and exposes no container port.

After the backend is healthy, start the official device-code flow:

```bash
sh deploy/nous.sh codex-login
# Windows: deploy/nous.ps1 codex-login
```

Complete the displayed verification flow, then use the authenticated admin provider panel to verify account and model status. Recreating or redeploying the backend preserves the Codex-owned credentials in the named volume. Nous never reads or returns `auth.json`; disabling `CODEX_APP_SERVER_ENABLED` removes the volume mount and prevents the app-server process from starting.

## Canonical Auth/RLS contract

Migrations in `supabase/migrations/` are the single schema path for both profiles. On a disposable self-hosted or staging environment with `SUPABASE_JWT_SECRET`, run:

```bash
sh deploy/nous.sh contract
```

This runs the existing canonical integration case in a tooling container. It creates isolated temporary users, authenticates through Supabase Auth, saves projects through the real backend/Postgres store, proves cross-user backend isolation, attempts a forbidden cross-tenant PostgREST insert, and cleans its records. The managed production project is never selected automatically; point a separate env file at staging with `NOUS_ENV_FILE`.

CI always runs the unit/route suite. The Auth/RLS contract runs against local/self-hosted Supabase when available and can use a protected managed staging environment without changing test code.

## Admin bootstrap

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` only in the untracked deployment env, then run:

```bash
sh deploy/nous.sh admin
```

The command creates or promotes that Supabase user through the Admin API and preserves existing app metadata. Migrations contain no account credentials.

## Auth email with Resend

The admin email action checks Supabase Auth before sending: a new address receives an invitation,
an existing account that still requires setup receives a recovery link, and a completed account
receives a passwordless sign-in link that does not reset its password.
The login screen also uses Supabase Auth's native recovery endpoint. Nous does not call Resend
directly and needs no Resend secret in `.env.production`: SMTP credentials belong to the managed
Supabase project or the ignored self-hosted Supabase env.

New invited users are created through the Admin API with the server-owned app metadata marker
`password_setup_required=true` before Nous requests their setup email. If email delivery fails,
Nous deletes that new account. The marker is present in the callback JWT and the backend rejects
every normal protected route while it remains set. Only `PUT /api/auth/password-setup` accepts that
pending session; it sets the password and removes the marker in one Supabase Admin update, after
which the browser immediately performs a password grant with the chosen credentials before opening
the application. This explicit grant is required because the Admin password update invalidates the
original callback refresh token. A later recovery or Magic Link cannot bypass this gate. Recovery
for an already completed account stays on Supabase's user-scoped password endpoint.

Setup and recovery callbacks return with `type=magiclink` or `type=recovery`, and all email links
return to the application root. The server-owned marker, not the callback type, decides whether
password setup is required. Public signup stays disabled. Public Magic Link requests use
`create_user: false`. Expected account-absence responses keep the same account-neutral
confirmation; rate limits, provider failures, and network failures show a stable retryable error.
Provider status and safe error codes may be logged, but raw provider messages are never rendered.

During password completion, a final `401` clears the local session and returns to login with the
expired-link message. Only provider code `weak_password` produces weak-password guidance; other
`422` responses, provider `5xx`, and network failures keep the gate open and allow retry.

Use a dedicated sending subdomain and sender:

```text
domain: auth.<domain>
sender: Nous <no-reply@auth.<domain>>
```

The sender does not need to be a mailbox. In Resend, add `auth.<domain>`, then copy its SPF and DKIM
records exactly into the authoritative DNS zone. Add a DMARC record for the sending subdomain,
starting with a monitoring policy before tightening it. Keep every mail record DNS-only in
Cloudflare. Disable Resend click tracking for this domain because rewriting a one-time sign-in URL
can invalidate or pre-consume it; open tracking is unnecessary for authentication mail too.

Create a Resend API key dedicated to this deployment. Resend's SMTP settings are:

```text
host: smtp.resend.com
port: 465 (implicit TLS) or 587 (STARTTLS)
username: resend
password: <dedicated Resend API key>
```

See the official [Supabase custom SMTP guide](https://supabase.com/docs/guides/auth/auth-smtp),
[Resend SMTP settings](https://resend.com/docs/send-with-smtp), and
[Resend domain verification](https://resend.com/docs/dashboard/domains/introduction).

### Supabase CLI local stack

The checked-in `supabase/config.toml` sends local Auth email through Resend on port 587 with sender
`Nous <no-reply@auth.giovbox.com>`. Put the dedicated Resend API key in ignored `.env.local`:

```dotenv
SUPABASE_AUTH_SMTP_PASS=<dedicated Resend API key>
```

`bunx` loads `.env.local` through Bun and passes the value to the CLI; `config.toml` only contains
`env(SUPABASE_AUTH_SMTP_PASS)`. Restart the local stack after changing SMTP configuration or the
key:

```bash
bunx supabase stop
bunx supabase start
```

This replaces Mailpit delivery for Auth messages in the local stack. To include the real SMTP case
in the local integration suite, opt in with an inbox you control:

```dotenv
SUPABASE_MAGIC_LINK_TEST_EMAIL=<real test inbox>
```

Then run `bun run test:supabase-local` and verify the message in that inbox and in Resend logs. When
the recipient variable is absent, the external-email case is skipped so routine tests never send
mail. The Supabase CLI requires a stop/start, not only an application restart, to apply changes to
`[auth.email.smtp]`.

### Managed Supabase

In the project's Auth settings:

1. enable custom SMTP and enter the Resend values above;
2. set the sender name to `Nous` and sender email to `no-reply@auth.<domain>`;
3. set Site URL to the exact production `NOUS_PUBLIC_URL` and allow only the controlled preview or
   staging redirects that are actually used;
4. keep the initial Auth email rate limit at 30 messages per hour unless measured use requires a
   deliberate change.

Admin invitation and access emails use the Auth Site URL, while browser-requested Magic Link and
password recovery explicitly return to its root. Do not use a localhost Site URL in production,
and keep that root in the redirect allow list.

The repository owns the email templates under `supabase/templates/`. Check and apply them to a
managed project without storing the management token:

```bash
SUPABASE_ACCESS_TOKEN=<personal management token> \
SUPABASE_PROJECT_REF=<project ref> \
  bun run supabase:templates:diff

SUPABASE_ACCESS_TOKEN=<personal management token> \
SUPABASE_PROJECT_REF=<project ref> \
  bun run supabase:templates:sync
```

The invitation, sign-in, and recovery templates use the public Nous PNG icon at
`https://nous.giovbox.com/icons/nous-app-icon-192.png`. Keep that URL publicly readable or replace
it in all three templates before syncing.

### Self-hosted Supabase on the VPS

Run `setup` once so the pinned official bundle creates the ignored
`deploy/supabase-project/.env`. Put the Resend credentials only in that file:

```dotenv
SMTP_ADMIN_EMAIL=no-reply@auth.<domain>
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=<dedicated Resend API key>
SMTP_SENDER_NAME=Nous
```

The self-hosted Compose override starts an internal, read-only `email-templates` service from the
repository's `supabase/templates/` directory. Supabase Auth waits for that service to become healthy
and uses it for the confirmation, invitation, Magic Link, and recovery HTML and subjects. Template
reloading is enabled, so a deployed template-file update is used by the next email without exposing
the files publicly.

`setup` derives `SITE_URL` and `ADDITIONAL_REDIRECT_URLS` from `NOUS_PUBLIC_URL` and writes
`DISABLE_SIGNUP=true` into the official Supabase env. Re-run `setup` after upgrading an older
deployment, then recreate Auth after changing Auth or SMTP values:

```bash
docker compose --project-name nous-reader-supabase \
  --env-file deploy/supabase-project/.env \
  -f deploy/supabase-project/docker-compose.yml \
  -f deploy/supabase.override.yml \
  up -d --force-recreate auth
```

When adopting branded templates on an existing VPS, include their internal server in the recreate:

```bash
docker compose --project-name nous-reader-supabase \
  --env-file deploy/supabase-project/.env \
  -f deploy/supabase-project/docker-compose.yml \
  -f deploy/supabase.override.yml \
  up -d --force-recreate email-templates auth
```

Supabase Auth retains its own per-recipient email cooldown. The admin UI disables duplicate sends
while an invitation or access email is pending. Do not add a second SMTP client or copy
`SMTP_PASS` into the Nous application env.

### Delivery and sign-in proof

Use a real test address on a disposable user, not a Resend synthetic bounce address:

1. sign in as an admin and enter a new disposable address in `Invita o invia accesso`;
2. confirm that the UI names the destination and Resend records `Delivered` rather than only
   `Sent`;
3. inspect the received headers for SPF, DKIM, and DMARC pass results;
4. open the invitation in a private browser session and confirm Nous requires matching password
   fields before it renders the application;
5. open the same link again and confirm the one-time token is rejected;
6. send the same address again and confirm it now receives an access-only email and opens Nous
   without changing that password;
7. sign out, use `Password dimenticata?`, and confirm the recovery link requires a new password;
8. submit an unknown address and confirm the UI remains generic and Auth creates no user;
9. check Supabase Auth logs and Nous backend logs if any request fails.

With `SUPABASE_MAGIC_LINK_TEST_EMAIL` configured, `bun run test:supabase-local` exercises the same
admin endpoint against local Supabase and verifies that its configured SMTP server accepts the
message. The external inbox, DNS authentication, redirect, and one-time-link checks above remain
the delivery proof.

## Backup, restore, and proof

Create the paired custom-format Postgres and private project-source Storage backups:

```bash
sh deploy/nous.sh backup
```

The command writes two adjacent files under ignored `deploy/backups/`:

- `nous-<UTC timestamp>.dump`
- `nous-<UTC timestamp>.project-sources.tar`

The dump intentionally excludes the Supabase-owned `storage` schema; Storage metadata is not the
object payload and must not be restored as application data. The separate archive contains one
manifest entry for every distinct `object_path` referenced by `project_sources`,
`project_source_files`, and file rows in `project_source_entries`, and no unreferenced payloads. Each
entry records its expected SHA-256 and byte size. Downloads are streamed to temporary files,
verified, packed, extracted once, and verified again before the two final files are published. The
manifest also records the dump SHA-256, so an archive from another backup cannot be paired
accidentally. A corrupt, incomplete, changed, or mismatched object fails the command. These integrity
checks are not a restore proof.
Run the command while application writes are quiesced so the database dump and the immediately
derived Storage manifest describe the same application state.

For the required restore proof, use a disposable database or protected staging project:

```bash
cp .env.production .env.restore-proof
# point DATABASE_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY at the same
# disposable target, provisioned with the private project-sources bucket
CONFIRM_RESTORE=nous-reader NOUS_ENV_FILE=.env.restore-proof \
  sh deploy/nous.sh restore \
    deploy/backups/<backup>.dump \
    deploy/backups/<backup>.project-sources.tar
NOUS_ENV_FILE=.env.restore-proof sh deploy/nous.sh smoke
NOUS_ENV_FILE=.env.restore-proof sh deploy/nous.sh contract
```

PowerShell uses the same paired artifact and confirmation contract:

```powershell
$env:CONFIRM_RESTORE = 'nous-reader'
$env:NOUS_ENV_FILE = '.env.restore-proof'
deploy/nous.ps1 restore `
  deploy/backups/<backup>.dump `
  deploy/backups/<backup>.project-sources.tar
```

Restore parses the dump and fully verifies the Storage archive before changing the database. It then
restores the database in one transaction and compares its complete project-source reference set with
the manifest before uploading any object. Existing objects are accepted only when their streamed
SHA-256 and byte size match; missing objects are uploaded with overwrite disabled and read back for
verification. A mismatch, missing payload, extra payload, changed DB reference, failed upload, or
failed read-back stops the restore. The command never overwrites a different existing object and
never reconstructs an object from legacy concatenated source text.

If the object phase fails after the database transaction succeeds, treat the target as an incomplete
restore: keep it unavailable, correct the Storage/configuration fault, and rerun the same restore
pair. The idempotent object rules safely accept bytes already restored by the first attempt.

Record the UTC date, source deployment, both file checksums, target database and Supabase
identifiers, restore exit status, `smoke`, and `contract` results in the operator's incident/backup
log. Store both backup files together off-host. Never prove restoration against the only production
database or its `project-sources` bucket.

Repository mechanism proof on 2026-07-11: a Postgres 17 custom-format dump was parsed, restored into a separate disposable Postgres 17 instance, and its sentinel row was selected. This verifies the documented archive/restore mechanism, not any operator's current production data.

Application rollback checks out the previous release and runs `redeploy`. Database migrations are forward-only; restoring a verified backup is a separate incident operation, never an automatic application rollback.

## Legacy project-source migrator retirement

The one-time project-source migrator is retired. Deployments apply the versioned Supabase migrations
directly; local startup and Compose no longer stage legacy rows. The historical storage-cutover
migration remains in the migration history as an audit record, but it is not a runtime compatibility
path.

Before deploying this change against an existing database, run the following read-only preflight with
the service role and stop if either legacy staging table still exists or embedded source bytes remain:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('project_sources_legacy', 'project_source_storage_stage');

select count(*) as embedded_source_snapshots
from public.project_snapshots
where coalesce(snapshot #>> '{source,file,data}', '') <> ''
   or coalesce(snapshot #>> '{source,aggregatedText}', '') <> ''
   or exists (
     select 1
     from jsonb_array_elements(
       case
         when jsonb_typeof(snapshot #> '{source,sources}') = 'array'
           then snapshot #> '{source,sources}'
         else '[]'::jsonb
       end
     ) descriptor
     where coalesce(descriptor #>> '{file,data}', '') <> ''
   );
```

The expected result is no legacy tables and `embedded_source_snapshots = 0`. Validate a fresh
import and reload with `bun run test:supabase-local` against an isolated local database before
deployment. If preflight or fresh-import validation fails, do not continue: restore the previous
application release and use the paired verified database/Storage backup procedure above for database
recovery. Do not recreate the retired migrator or delete current object-storage data as a rollback.

## Pinned Supabase upgrade and secret rotation

1. Back up and complete a restore proof.
2. Review the upstream diff between the current and proposed commits, including Docker env and migration notes.
3. Stop only the self-hosted Supabase project during the maintenance window.
4. Move the current ignored `deploy/supabase-project/` aside without deleting its env or volumes.
5. Update `deploy/SUPABASE_VERSION`, run setup to fetch the new bundle, and migrate the preserved non-default env values deliberately.
6. Start, wait for health, then run `smoke` and `contract` before removing the old bundle directory.

Rotating a credential means changing it at Supabase/provider source, updating the untracked env, and redeploying. Setup never regenerates self-hosted keys during a normal redeploy.
