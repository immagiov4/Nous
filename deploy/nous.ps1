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

function Invoke-SourceStorageTool([string[]]$ToolArgs) {
  Invoke-Compose (@('--profile', 'tools', 'run', '--rm', '-T', 'source-storage-tools') + $ToolArgs)
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
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
    $backupStem = "nous-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))"
    $databaseName = "$backupStem.dump"
    $storageName = "$backupStem.project-sources.tar"
    $databasePath = Join-Path $backupDirectory $databaseName
    $storagePath = Join-Path $backupDirectory $storageName
    $databasePartName = "$databaseName.partial"
    $storagePartName = "$storageName.partial"
    $databasePartPath = Join-Path $backupDirectory $databasePartName
    $storagePartPath = Join-Path $backupDirectory $storagePartName
    $workName = ".$backupStem.storage.$([Guid]::NewGuid().ToString('N'))"
    $verifyName = ".$backupStem.verify.$([Guid]::NewGuid().ToString('N'))"
    $workDirectory = Join-Path $backupDirectory $workName
    $storageDirectory = Join-Path $workDirectory 'artifact'
    $verifyDirectory = Join-Path $backupDirectory $verifyName

    foreach ($path in @($databasePath, $storagePath, $databasePartPath, $storagePartPath)) {
      if (Test-Path -LiteralPath $path) {
        throw 'A backup with this timestamp already exists; retry in one second.'
      }
    }

    New-Item -ItemType Directory -Path $workDirectory, $verifyDirectory | Out-Null
    try {
      Invoke-Compose @(
        '--profile', 'tools', 'run', '--rm', '-T', 'db-tools', 'sh', '-ec',
        "pg_dump `"`$DATABASE_URL`" --format=custom --exclude-schema=storage --file=`"/backups/$databasePartName`" && pg_restore --list `"/backups/$databasePartName`" >/dev/null"
      )
      $databaseSha256 = Get-Sha256 $databasePartPath
      Invoke-SourceStorageTool @(
        'bun', 'run', 'scripts/project-source-storage-artifact.ts',
        'backup', "/backups/$workName/artifact", $databaseSha256
      )

      & tar -C $storageDirectory -cf $storagePartPath .
      if ($LASTEXITCODE -ne 0) { throw 'Project source archive creation failed.' }
      & tar -xf $storagePartPath -C $verifyDirectory
      if ($LASTEXITCODE -ne 0) { throw 'Project source archive extraction failed.' }
      Invoke-SourceStorageTool @(
        'bun', 'run', 'scripts/project-source-storage-artifact.ts',
        'verify', "/backups/$verifyName", $databaseSha256
      )

      Move-Item -LiteralPath $storagePartPath -Destination $storagePath
      Move-Item -LiteralPath $databasePartPath -Destination $databasePath
      Write-Output $databasePath
      Write-Output $storagePath
    }
    catch {
      Remove-Item -LiteralPath $databasePath, $storagePath -Force -ErrorAction SilentlyContinue
      throw
    }
    finally {
      Remove-Item -LiteralPath $databasePartPath, $storagePartPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $workDirectory, $verifyDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  'restore' {
    $backupPath = $Arguments[0]
    $storagePath = $Arguments[1]
    if (
      $env:CONFIRM_RESTORE -ne 'nous-reader' -or
      -not (Test-Path -LiteralPath $backupPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $storagePath -PathType Leaf)
    ) {
      throw 'Set CONFIRM_RESTORE=nous-reader and pass the matching dump and project-sources archive.'
    }

    $backupDirectory = Join-Path $Root 'deploy/backups'
    New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
    $restoreId = [Guid]::NewGuid().ToString('N')
    $databaseCopyName = ".restore-$restoreId.dump"
    $databaseCopyPath = Join-Path $backupDirectory $databaseCopyName
    $restoreName = ".restore-project-sources.$restoreId"
    $restoreDirectory = Join-Path $backupDirectory $restoreName
    New-Item -ItemType Directory -Path $restoreDirectory | Out-Null

    try {
      Copy-Item -LiteralPath $backupPath -Destination $databaseCopyPath
      $databaseSha256 = Get-Sha256 $databaseCopyPath
      & tar -xf $storagePath -C $restoreDirectory
      if ($LASTEXITCODE -ne 0) { throw 'Project source archive extraction failed.' }
      Invoke-SourceStorageTool @(
        'bun', 'run', 'scripts/project-source-storage-artifact.ts',
        'verify', "/backups/$restoreName", $databaseSha256
      )
      Invoke-Compose @(
        '--profile', 'tools', 'run', '--rm', '-T', 'db-tools', 'sh', '-ec',
        "pg_restore --list `"/backups/$databaseCopyName`" >/dev/null && pg_restore --dbname=`"`$DATABASE_URL`" --clean --if-exists --no-owner --exit-on-error --single-transaction `"/backups/$databaseCopyName`""
      )
      Invoke-SourceStorageTool @(
        'bun', 'run', 'scripts/project-source-storage-artifact.ts',
        'restore', "/backups/$restoreName", $databaseSha256
      )
    }
    finally {
      Remove-Item -LiteralPath $databaseCopyPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $restoreDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
