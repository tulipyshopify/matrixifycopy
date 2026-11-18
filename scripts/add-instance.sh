#!/usr/bin/env bash
# Adds a second (third…) copy of the app to this server, for a Shopify app that
# lives in another organisation. Each copy has its own address, its own Shopify
# credentials and its own data; nothing is shared with the first one.
#
#   scripts/add-instance.sh <name> <domain> <client-id>
#   e.g. scripts/add-instance.sh acme bulk.acme.co.uk 0123456789abcdef0123456789abcdef
#
# The Client secret is asked for on screen (it is not shown and not kept in
# your shell history). Run it again with the same name to change a setting.
set -euo pipefail
cd "$(dirname "$0")/.."

name="${1:-}"; domain="${2:-}"; client_id="${3:-}"
if [[ ! "$name" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then echo "Name: lower-case letters, digits and dashes, e.g. acme" >&2; exit 1; fi
if [[ ! "$domain" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]]; then echo "Domain: like bulk.example.com (no https://)" >&2; exit 1; fi
if [[ ! "$client_id" =~ ^[0-9a-f]{32}$ ]]; then echo "Client ID: the 32-character value from the app's Settings page" >&2; exit 1; fi
if [[ "$name" == "app" || "$name" == "caddy" ]]; then echo "Choose another name" >&2; exit 1; fi

# Always asked for, so a secret already set in this shell (the first app's) is never reused by mistake.
# INSTANCE_SECRET is only for scripted set-ups.
secret="${INSTANCE_SECRET:-}"
if [[ -z "$secret" ]]; then
  echo "Paste the Client secret of the app for $domain and press Enter (it is not shown):"
  read -r -s secret </dev/tty
  echo
fi
if [[ -z "$secret" ]]; then echo "No secret given" >&2; exit 1; fi
if [[ -f .env.production ]] && grep -qxF "SHOPIFY_API_SECRET=$secret" .env.production; then
  echo "That is the secret of the first app. Use the one from the new app's Settings page." >&2; exit 1
fi

scopes="$(grep -m1 '^scopes' shopify.app.toml | sed -E 's/^scopes *= *"(.*)"$/\1/')"
mkdir -p instances caddy-extra "data-$name"

umask 077
cat > "instances/$name.env" <<ENV
SHOPIFY_API_KEY=$client_id
SHOPIFY_API_SECRET=$secret
SHOPIFY_APP_URL=https://$domain
SCOPES=$scopes
EXPORT_HISTORY_DAYS=7
MAX_UPLOAD_MB=200
ENV
umask 022

cat > "instances/$name.yml" <<YML
# Written by scripts/add-instance.sh: the "$name" copy of the app.
services:
  app-$name:
    image: bulkport-app:latest
    restart: unless-stopped
    env_file: instances/$name.env
    environment:
      PORT: "3000"
      NODE_OPTIONS: "--max-old-space-size=1024"
    mem_limit: 1536m
    volumes:
      - ./data-$name:/data
    expose:
      - "3000"
    depends_on:
      - app
YML

cat > "caddy-extra/$name.caddy" <<CADDY
$domain {
	request_body {
		max_size 250MB
	}
	reverse_proxy app-$name:3000
}
CADDY

# "docker compose up" then starts every instance without extra options.
files="docker-compose.yml"
for f in instances/*.yml; do [[ -e "$f" ]] && files="$files:$f"; done
touch .env
grep -v '^COMPOSE_FILE=' .env > .env.tmp || true
echo "COMPOSE_FILE=$files" >> .env.tmp
mv .env.tmp .env

echo
echo "Instance \"$name\" is set up for https://$domain"
echo "Check the web server set-up first (must say \"Valid configuration\"):"
echo "   docker compose run --rm caddy caddy validate --config /etc/caddy/Caddyfile"
echo "Then start it:"
echo "   docker compose up -d --build && docker compose restart caddy"
echo "Its data is in:  $(pwd)/data-$name"
