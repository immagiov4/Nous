param(
  [Parameter(Position = 0)]
  [ValidateSet('config', 'setup', 'up', 'status', 'logs', 'redeploy', 'smoke', 'contract', 'codex-login', 'down', 'admin', 'backup', 'restore')]
  [string]$Command = 'status',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = if ($env:NOUS_ENV_FILE) { [IO.Path]::GetFullPath($env:NOUS_ENV_FILE) } else { Join-Path $Root '.env.production' }
$SupabaseDirectory = Join-Path $Root 'deploy/supabase-project'
$ComposeArgs = @('compose', '--project-name', 'nous-reader', '--env-file', $EnvFile, '-f', (Join-Path $Root 'compose.yml'))

function Start-DockerRuntime {
  & docker desktop start --timeout 120 *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  & docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Invoke-Preflight {
  if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'ARM64')) {
    throw "Unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE."
  }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is not installed. Install Docker Desktop from the official Docker website.'
  }
  $dockerInfo = & docker info 2>&1
  if ($LASTEXITCODE -ne 0) {
    $details = $dockerInfo -join "`n"
    if ($details -match 'permission denied|access is denied|unauthorized') {
      throw 'Docker is installed, but this account lacks permission to use the daemon.'
    }
    Write-Output 'Docker is installed but the daemon is unavailable. Attempting to start Docker Desktop...'
    if (-not (Start-DockerRuntime)) {
      throw 'Docker Desktop or its daemon could not be started. Start Docker Desktop manually and rerun the command.'
    }
  }
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker Compose v2 is missing. Docker Desktop must include the Compose plugin.'
  }
  $composeVersionText = ((& docker compose version --short) -replace '^v', '').Trim()
  $composeVersion = [version]$composeVersionText
  if ($composeVersion -lt [version]'2.24.0') {
    throw 'Docker Compose 2.24 or newer is required for safe self-hosted port overrides.'
  }
}

function Ensure-EnvFile {
  if (Test-Path -LiteralPath $EnvFile) { return }
  if ($Command -ne 'setup') { throw "Missing $EnvFile. Run setup to create the template." }
  Copy-Item -LiteralPath (Join-Path $Root 'deploy/.env.production.example') -Destination $EnvFile
  throw "Created $EnvFile. Fill the public URLs and external provider credentials, then rerun setup."
}

function Get-EnvValue([string]$Name) {
  $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
  if ($null -eq $line) { return '' }
  return ($line -split '=', 2)[1]
}

function Get-DeploymentProfile {
  $profile = Get-EnvValue 'SUPABASE_DEPLOYMENT'
  if ($profile -notin @('managed', 'self-hosted')) {
    throw 'SUPABASE_DEPLOYMENT must be managed or self-hosted.'
  }
  return $profile
}

function Invoke-Compose([string[]]$ExtraArgs) {
  & docker @ComposeArgs @ExtraArgs
  if ($LASTEXITCODE -ne 0) { throw "docker compose failed with exit code $LASTEXITCODE." }
}

function Invoke-SupabaseCompose([string[]]$ExtraArgs) {
  $args = @(
    'compose', '--project-name', 'nous-reader-supabase',
    '--env-file', (Join-Path $SupabaseDirectory '.env'),
    '-f', (Join-Path $SupabaseDirectory 'docker-compose.yml'),
    '-f', (Join-Path $Root 'deploy/supabase.override.yml')
  )
  & docker @args @ExtraArgs
  if ($LASTEXITCODE -ne 0) { throw "Supabase docker compose failed with exit code $LASTEXITCODE." }
}

function Invoke-ConfigTool([string]$Action, [string]$SupabaseEnvPath = '') {
  $envDirectory = Split-Path -Parent $EnvFile
  $envName = Split-Path -Leaf $EnvFile
  $args = @(
    'run', '--rm',
    '--mount', "type=bind,source=$Root,target=/workspace",
    '--mount', "type=bind,source=$envDirectory,target=/nous-config",
    '--workdir', '/workspace',
    'node:22-alpine', 'node', 'deploy/config.mjs', $Action, "/nous-config/$envName"
  )
  if ($SupabaseEnvPath) { $args += $SupabaseEnvPath }
  & docker @args
  if ($LASTEXITCODE -ne 0) { throw 'Deployment configuration validation failed.' }
}

function Ensure-SelfHostedSupabase {
  $version = (Get-Content -LiteralPath (Join-Path $Root 'deploy/SUPABASE_VERSION') -Raw).Trim()
  $downloadScript = @'
destination=/work/supabase-project
if [ -d "$destination" ]; then
  [ -f "$destination/.nous-version" ] && [ "$(cat "$destination/.nous-version")" = "$SUPABASE_VERSION" ] || {
    echo "Existing Supabase bundle does not match deploy/SUPABASE_VERSION; back up and follow the documented upgrade procedure." >&2
    exit 1
  }
  exit 0
fi
work=/work/.supabase-download
rm -rf "$work"
git init "$work"
cd "$work"
git remote add origin https://github.com/supabase/supabase.git
git sparse-checkout init --cone
git sparse-checkout set docker
git -c protocol.version=2 fetch --depth=1 --filter=blob:none origin "$SUPABASE_VERSION"
[ "$(git rev-parse FETCH_HEAD)" = "$SUPABASE_VERSION" ]
git checkout --detach FETCH_HEAD
mv docker "$destination"
printf "%s\n" "$SUPABASE_VERSION" > "$destination/.nous-version"
cp "$destination/.env.example" "$destination/.env"
cd /work
rm -rf "$work"
'@
  & docker run --rm `
    --mount "type=bind,source=$Root/deploy,target=/work" `
    --env "SUPABASE_VERSION=$version" `
    --entrypoint sh `
    alpine/git@sha256:fac7bc2c12aa52bff1c78a26359990e149954a60cdd5d6e20e7e009666c73e0a -ec $downloadScript
  if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare the pinned official Supabase bundle.' }

  if (-not (Test-Path -LiteralPath (Join-Path $SupabaseDirectory '.nous-secrets-generated'))) {
    $secretScript = @'
apk add --no-cache openssl >/dev/null
sh utils/generate-keys.sh --update-env >/dev/null
sh utils/add-new-auth-keys.sh --update-env >/dev/null
touch .nous-secrets-generated
'@
    & docker run --rm `
      --mount "type=bind,source=$SupabaseDirectory,target=/workspace" `
      --workdir /workspace `
      node:22-alpine sh -ec $secretScript
    if ($LASTEXITCODE -ne 0) { throw 'Official Supabase secret generation failed.' }
  }

  Invoke-ConfigTool 'configure' '/workspace/deploy/supabase-project/.env'
}

function Invoke-Smoke {
  Invoke-Compose @('--profile', 'tools', 'run', '--rm', 'smoke')
  Invoke-Compose @(
    '--profile', 'tools', 'run', '--rm', '-T', 'db-tools', 'sh', '-ec',
    'pg_isready --dbname="$DATABASE_URL" >/dev/null && [ "$(psql "$DATABASE_URL" -Atqc "select 1")" = "1" ]'
  )
  Write-Output 'Healthy: database'
}

Invoke-Preflight
Ensure-EnvFile
$Profile = Get-DeploymentProfile
if ($Profile -eq 'self-hosted') {
  $ComposeArgs += @('-f', (Join-Path $Root 'deploy/compose.self-hosted.yml'))
}
if ((Get-EnvValue 'CODEX_APP_SERVER_ENABLED') -eq 'true') {
  $ComposeArgs += @('-f', (Join-Path $Root 'deploy/compose.codex.yml'))
}

switch ($Command) {
  'config' {
    Invoke-ConfigTool 'check'
    Invoke-Compose @('config', '--quiet')
  }
  'setup' {
    if ($Profile -eq 'self-hosted') {
      Invoke-ConfigTool 'check-bootstrap'
      Ensure-SelfHostedSupabase
      Invoke-ConfigTool 'check'
      Invoke-SupabaseCompose @('up', '-d', '--wait')
    } else {
      Invoke-ConfigTool 'check'
    }
    Invoke-Compose @('config', '--quiet')
    Invoke-Compose @('up', '-d', '--build', '--remove-orphans', '--wait')
    Invoke-Smoke
    Invoke-Compose @('ps')
  }
  'up' {
    Invoke-ConfigTool 'check'
    if ($Profile -eq 'self-hosted') {
      if (-not (Test-Path -LiteralPath (Join-Path $SupabaseDirectory '.nous-version'))) {
        throw 'Run setup before up for a self-hosted deployment.'
      }
      Invoke-SupabaseCompose @('up', '-d', '--wait')
    }
    Invoke-Compose @('up', '-d', '--remove-orphans', '--wait')
  }
  'status' {
    Invoke-ConfigTool 'check'
    Invoke-Compose @('ps')
    if ($Profile -eq 'self-hosted') { Invoke-SupabaseCompose @('ps') }
  }
  'logs' { Invoke-Compose (@('logs', '-f') + $Arguments) }
  'redeploy' {
    Invoke-ConfigTool 'check'
    Invoke-Compose @('config', '--quiet')
    Invoke-Compose @('build')
    Invoke-Compose @('run', '--rm', 'migrate')
    Invoke-Compose @('up', '-d', '--remove-orphans', '--wait')
    Invoke-Smoke
    Invoke-Compose @('ps')
  }
  'smoke' {
    Invoke-ConfigTool 'check'
    Invoke-Smoke
  }
  'contract' {
    Invoke-ConfigTool 'check'
    if (-not (Get-EnvValue 'SUPABASE_JWT_SECRET')) {
      throw 'The canonical Auth/RLS contract test requires SUPABASE_JWT_SECRET on a disposable self-hosted or staging environment.'
    }
    Invoke-Compose @('--profile', 'tools', 'run', '--rm', 'contract-test')
  }
  'codex-login' {
    if ((Get-EnvValue 'CODEX_APP_SERVER_ENABLED') -ne 'true') {
      throw 'Set CODEX_APP_SERVER_ENABLED=true before starting Codex login.'
    }
    Invoke-Compose @('exec', 'backend', 'codex', 'login', '--device-auth')
  }
  'down' { Invoke-Compose @('down') }
  'admin' { Invoke-Compose @('--profile', 'tools', 'run', '--rm', 'admin-bootstrap') }
  'backup' {
    $backupDirectory = Join-Path $Root 'deploy/backups'
    New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
    $backupPath = Join-Path $backupDirectory "nous-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')).dump"
    $base64 = & docker @ComposeArgs --profile tools run --rm -T db-tools sh -c 'pg_dump "$DATABASE_URL" --format=custom | base64'
    if ($LASTEXITCODE -ne 0) { throw 'Database backup failed.' }
    [IO.File]::WriteAllBytes($backupPath, [Convert]::FromBase64String(($base64 -join '')))
    $base64 | & docker @ComposeArgs --profile tools run --rm -T db-tools sh -c 'base64 -d | pg_restore --list >/dev/null'
    if ($LASTEXITCODE -ne 0) { throw 'The backup archive failed verification.' }
    Write-Output $backupPath
  }
  'restore' {
    $backupPath = $Arguments[0]
    if ($env:CONFIRM_RESTORE -ne 'nous-reader' -or -not (Test-Path -LiteralPath $backupPath)) {
      throw 'Set CONFIRM_RESTORE=nous-reader and pass an existing dump path.'
    }
    $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($backupPath))
    $base64 | & docker @ComposeArgs --profile tools run --rm -T db-tools sh -c 'base64 -d | pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner'
    if ($LASTEXITCODE -ne 0) { throw 'Database restore failed.' }
  }
}
