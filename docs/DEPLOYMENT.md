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

## Magic Link email with Resend

The admin action sends a passwordless sign-in email through Supabase Auth. Nous does not call
Resend directly and needs no Resend secret in `.env.production`: SMTP credentials belong to the
managed Supabase project or the ignored self-hosted Supabase env.

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
bunx supabase stop --no-backup
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

The admin endpoint does not supply a per-request redirect, so the Magic Link returns to the Auth
Site URL. Do not use a localhost Site URL in production.

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

`setup` already derives `SITE_URL` and `ADDITIONAL_REDIRECT_URLS` from `NOUS_PUBLIC_URL`. Recreate
Auth after changing SMTP values:

```bash
docker compose --project-name nous-reader-supabase \
  --env-file deploy/supabase-project/.env \
  -f deploy/supabase-project/docker-compose.yml \
  -f deploy/supabase.override.yml \
  up -d --force-recreate auth
```

Supabase Auth retains its own per-recipient email cooldown. The admin UI also disables all Magic
Link actions while a send is pending, preventing accidental duplicate clicks. Do not add a second
SMTP client or copy `SMTP_PASS` into the Nous application env.

### Delivery and sign-in proof

Use a real test address on a disposable user, not a Resend synthetic bounce address:

1. sign in as an admin and send the user's sign-in link from the user list;
2. confirm that the UI names the destination and Resend records `Delivered` rather than only
   `Sent`;
3. inspect the received headers for SPF, DKIM, and DMARC pass results;
4. open the link in a private browser session and confirm it lands on `NOUS_PUBLIC_URL` with the
   test user authenticated;
5. open the same link again and confirm the one-time token is rejected;
6. sign out, request one more link after the cooldown, and confirm the newer link works;
7. check Supabase Auth logs and Nous backend logs if either request fails.

With `SUPABASE_MAGIC_LINK_TEST_EMAIL` configured, `bun run test:supabase-local` exercises the same
admin endpoint against local Supabase and verifies that its configured SMTP server accepts the
message. The external inbox, DNS authentication, redirect, and one-time-link checks above remain
the delivery proof.

## Backup, restore, and proof

Create a custom-format Postgres backup:

```bash
sh deploy/nous.sh backup
```

The command writes under ignored `deploy/backups/` and immediately parses the archive with `pg_restore --list`; a corrupt archive fails the command. This is an integrity check, not a restore proof.

For the required restore proof, use a disposable database or protected staging project:

```bash
cp .env.production .env.restore-proof
# edit only DATABASE_URL to target the disposable empty database
CONFIRM_RESTORE=nous-reader NOUS_ENV_FILE=.env.restore-proof \
  sh deploy/nous.sh restore deploy/backups/<dump>.dump
NOUS_ENV_FILE=.env.restore-proof sh deploy/nous.sh smoke
NOUS_ENV_FILE=.env.restore-proof sh deploy/nous.sh contract
```

PowerShell sets the same values through `$env:CONFIRM_RESTORE` and `$env:NOUS_ENV_FILE`. Record the UTC date, source deployment, dump checksum, target identifier, restore exit status, `smoke`, and `contract` results in the operator's incident/backup log. Never prove restoration against the only production database.

Repository mechanism proof on 2026-07-11: a Postgres 17 custom-format dump was parsed, restored into a separate disposable Postgres 17 instance, and its sentinel row was selected. This verifies the documented archive/restore mechanism, not any operator's current production data.

Application rollback checks out the previous release and runs `redeploy`. Database migrations are forward-only; restoring a verified backup is a separate incident operation, never an automatic application rollback.

## Pinned Supabase upgrade and secret rotation

1. Back up and complete a restore proof.
2. Review the upstream diff between the current and proposed commits, including Docker env and migration notes.
3. Stop only the self-hosted Supabase project during the maintenance window.
4. Move the current ignored `deploy/supabase-project/` aside without deleting its env or volumes.
5. Update `deploy/SUPABASE_VERSION`, run setup to fetch the new bundle, and migrate the preserved non-default env values deliberately.
6. Start, wait for health, then run `smoke` and `contract` before removing the old bundle directory.

Rotating a credential means changing it at Supabase/provider source, updating the untracked env, and redeploying. Setup never regenerates self-hosted keys during a normal redeploy.
