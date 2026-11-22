#!/usr/bin/env bash
set -Eeuo pipefail

: "${REPO:?Set REPO to the deployment checkout}"
: "${STATE_DIR:?Set STATE_DIR to the deployment state directory}"
export PATH="${DEPLOY_PATH:-$PATH}"
branch=main
deployed_file="$STATE_DIR/deployed-sha"
failed_file="$STATE_DIR/failed-sha"
attempt_file="$STATE_DIR/redeploy-attempts"
release_rejected_status=65
max_attempts=3

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || exit 0

log() {
  printf '[%s] %s\n' "$(date --iso-8601=seconds)" "$*"
}

cd "$REPO"
if ! git fetch --quiet origin "$branch"; then
  log "ERROR: git fetch failed"
  exit 1
fi

checkout_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$checkout_branch" != "$branch" ]]; then
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    log "ERROR: deploy checkout is on $checkout_branch with uncommitted changes"
    exit 1
  fi
  log "Switching deploy checkout from $checkout_branch to $branch"
  git checkout --quiet "$branch"
fi

head_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$branch")
if [[ "$head_sha" != "$remote_sha" ]]; then
  if ! git merge-base --is-ancestor "$head_sha" "$remote_sha"; then
    log "ERROR: local HEAD cannot be fast-forwarded to origin/$branch"
    exit 1
  fi

  file_lists=$(mktemp -d)
  trap 'rm -rf "$file_lists"' EXIT
  {
    git diff --name-only
    git diff --cached --name-only
    git ls-files --others --exclude-standard
  } | sort -u >"$file_lists/local"
  git diff --name-only "$head_sha..$remote_sha" | sort -u >"$file_lists/incoming"
  overlap=$(comm -12 "$file_lists/local" "$file_lists/incoming")
  if [[ -n "$overlap" ]]; then
    log "ERROR: update skipped because upstream overlaps local deployment changes:"
    printf '%s\n' "$overlap"
    exit 1
  fi

  log "Fast-forwarding $head_sha -> $remote_sha"
  git merge --ff-only "$remote_sha"
  head_sha=$(git rev-parse HEAD)
fi

if [[ -f "$deployed_file" && "$(<"$deployed_file")" == "$head_sha" ]]; then
  exit 0
fi
if [[ -f "$failed_file" && "$(<"$failed_file")" == "$head_sha" ]]; then
  log "Skipping failed revision $head_sha; waiting for main to change."
  exit 0
fi

log "Deploying Nous at $head_sha"
# Keep stderr from redeploy in the job log, including workflow conflict metadata.
if timeout 30m sh deploy/nous.sh redeploy; then
  printf '%s\n' "$head_sha" >"$deployed_file.tmp"
  mv "$deployed_file.tmp" "$deployed_file"
  rm -f "$failed_file" "$attempt_file"
  log "Deployment completed successfully at $head_sha"
else
  status=$?
  if (( status != release_rejected_status )); then
    attempt=1
    if [[ -f "$attempt_file" ]] &&
      read -r attempted_sha previous_attempts <"$attempt_file" &&
      [[ "$attempted_sha" == "$head_sha" ]]; then
      attempt=$((previous_attempts + 1))
    fi
    log "ERROR: deployment of $head_sha failed with exit code $status (attempt $attempt/$max_attempts)."
    if (( attempt < max_attempts )); then
      printf '%s %s\n' "$head_sha" "$attempt" >"$attempt_file.tmp"
      mv "$attempt_file.tmp" "$attempt_file"
      exit "$status"
    fi
  fi
  printf '%s\n' "$head_sha" >"$failed_file.tmp"
  mv "$failed_file.tmp" "$failed_file"
  rm -f "$attempt_file"
  log "ERROR: blocking deployment of $head_sha after exit code $status; recorded in failed-sha."
  exit "$status"
fi
