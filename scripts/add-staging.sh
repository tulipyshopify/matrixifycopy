#!/usr/bin/env bash
# Sets up the TEST copy of Bulkport next to the live one:
#   /opt/bulkport          live (branch v2) - Woven Wood, Planters, Roots
#   /opt/bulkport-staging  test (branch staging) - https://bulk-v2.tulipy.app
#
# Run from the live folder:  scripts/add-staging.sh
# It asks for the "Bulk v2" app's Client secret (not shown, not kept in history).
set -euo pipefail
cd "$(dirname "$0")/.."
LIVE="$(pwd)"
STAGING="${STAGING_DIR:-/opt/bulkport-staging}"
DOMAIN="bulk-v2.tulipy.app"
CLIENT_ID="3cd3c0dd33e83bbeb9f5110ba0f30e98"

# The test folder is a second working copy of this repository (git worktree):
# it uses the same GitHub access as the live folder, no new key needed.
git fetch origin staging
if [[ ! -e "$STAGING/.git" ]]; then
  if [[ -d "$STAGING" ]] && [[ -n "$(ls -A "$STAGING" 2>/dev/null)" ]]; then
    echo "$STAGING exists and isn't empty; move it away first." >&2; exit 1
  fi
  if git show-ref --verify --quiet refs/heads/staging; then
    git worktree add "$STAGING" staging
  else
    git worktree add --track -b staging "$STAGING" origin/staging
  fi
fi
git -C "$STAGING" pull --ff-only

secret="${INSTANCE_SECRET:-}"
if [[ -z "$secret" ]]; then
  echo "Paste the Client secret of the \"Bulk v2\" app and press Enter (it is not shown):"
  read -r -s secret </dev/tty
  echo
fi
[[ -n "$secret" ]] || { echo "No secret given" >&2; exit 1; }
if grep -qxF "SHOPIFY_API_SECRET=$secret" "$LIVE/.env.production" 2>/dev/null; then
  echo "That is the live app's secret. Use the one from the Bulk v2 app's Settings page." >&2; exit 1
fi

scopes="$(grep -m1 '^scopes' "$LIVE/shopify.app.toml" | sed -E 's/^scopes *= *"(.*)"$/\1/')"
umask 077
{
  echo "SHOPIFY_API_KEY=$CLIENT_ID"
  echo "SHOPIFY_API_SECRET=$secret"
  echo "SHOPIFY_APP_URL=https://$DOMAIN"
  echo "SCOPES=$scopes"
  echo "EXPORT_HISTORY_DAYS=7"
  echo "MAX_UPLOAD_MB=200"
  echo "BACKUP_SHOPS=*"
  echo "ASSIST_SHOPS=*"
  # Same Claude API key as live, if it has one.
  grep -E '^ANTHROPIC_API_KEY=' "$LIVE/.env.production" || true
} > "$STAGING/.env.production"
umask 022
# "docker compose" in the test folder uses the test compose file and its own project name.
printf 'COMPOSE_FILE=docker-compose.staging.yml\nCOMPOSE_PROJECT_NAME=bulkport-staging\n' > "$STAGING/.env"
mkdir -p "$STAGING/data"

mkdir -p "$LIVE/caddy-extra"
cat > "$LIVE/caddy-extra/staging.caddy" <<CADDY
$DOMAIN {
	request_body {
		max_size 250MB
	}
	reverse_proxy app-staging:3000
}
CADDY

echo
echo "Test copy set up in $STAGING for https://$DOMAIN"
echo "1. Check the web server set-up (must say \"Valid configuration\"):"
echo "     cd $LIVE && docker compose run --rm caddy caddy validate --config /etc/caddy/Caddyfile"
echo "2. Start the test copy (about 9 minutes), then let the web server pick it up:"
echo "     cd $STAGING && docker compose up -d --build && cd $LIVE && docker compose restart caddy"
