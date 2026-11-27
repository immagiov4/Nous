#!/usr/bin/env bash
set -euo pipefail

health_url=https://nous.giovbox.com/health
if ! health=$(curl --fail --silent --show-error --max-time 120 "$health_url"); then
  echo '::warning::Production health is unavailable. Using the committed compatibility baseline.'
  exit 0
fi

commit=$(printf '%s' "$health" | node -e '
  try {
    const { commit } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit)) process.stdout.write(commit);
  } catch {
    // An older or invalid health payload has no usable release identity.
  }
')
if [[ -z "$commit" ]]; then
  echo '::warning::Production health has no valid commit. Using the committed compatibility baseline.'
  exit 0
fi

# The public response selects a release, never code outside main's history.
if ! git merge-base --is-ancestor "$commit" origin/main 2>/dev/null; then
  echo 'Refreshing origin/main because production may have advanced since checkout.'
  git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
  if ! git merge-base --is-ancestor "$commit" origin/main 2>/dev/null; then
    echo "::error::Reported production commit $commit is outside the fetched main history."
    exit 1
  fi
fi

echo "Reconstructing the production compatibility baseline from $commit."
checkout=$(mktemp -d "$RUNNER_TEMP/nous-production.XXXXXX")
git worktree add --detach "$checkout" "$commit"
trap 'git worktree remove --force "$checkout"' EXIT

fixture=ciProductionWorkflowDeployment.json
(
  cd "$checkout"
  bun install --frozen-lockfile --ignore-scripts
  bun run workflow:capture-deployment --local "$fixture"
)
baseline="$RUNNER_TEMP/$fixture"
cp "$checkout/apps/backend/tests/workflows/fixtures/$fixture" "$baseline"
printf 'NOUS_PRODUCTION_BASELINE=%s\n' "$baseline" >> "$GITHUB_ENV"
