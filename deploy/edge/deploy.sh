#!/bin/sh
# Uploads worker.js as the `knowledge-edge` Worker, with EDGE_SECRET as its
# secret binding, and binds it to knowledge.hrustalq.dev as a Workers Custom
# Domain (which owns the DNS record, so any other record for that name must be
# deleted first).
#
#   EDGE_SECRET=<the production environment's EDGE_SECRET> ./deploy.sh
#
# The token comes from CLOUDFLARE_API_TOKEN, else ~/Homelab/infra/cloudflare-api-token
# (Workers Scripts:Edit + Workers Routes:Edit). Every upload replaces the
# Worker's bindings, so the secret is sent each time rather than kept.
set -eu
cd "$(dirname "$0")"

# Hex only: Caddy compares it with a `header` matcher, where a leading or
# trailing `*` would turn the exact match into a prefix/suffix one.
if ! printf '%s' "${EDGE_SECRET:-}" | grep -Eq '^[0-9a-f]{32,}$'; then
  echo "EDGE_SECRET must be set to 32+ lowercase hex characters (openssl rand -hex 32)" >&2
  exit 1
fi
TOKEN=${CLOUDFLARE_API_TOKEN:-$(cat "$HOME/Homelab/infra/cloudflare-api-token")}
API=https://api.cloudflare.com/client/v4
ACCOUNT=732a440bd3e391f72fc389d72e133846
ZONE=76e8b03af5177b4a3274a8786ddd0d52
HOST=knowledge.hrustalq.dev

# The metadata carries the secret, so it goes through a private file rather
# than argv, where any process on the box could read it.
umask 077
meta=$(mktemp)
trap 'rm -f "$meta"' EXIT
printf '{"main_module":"worker.js","compatibility_date":"2026-10-01","bindings":[{"type":"secret_text","name":"EDGE_SECRET","text":"%s"}]}' \
  "$EDGE_SECRET" > "$meta"

curl -sS --fail-with-body -X PUT "$API/accounts/$ACCOUNT/workers/scripts/knowledge-edge" \
  -H "Authorization: Bearer $TOKEN" \
  -F "metadata=@$meta;type=application/json" \
  -F 'worker.js=@worker.js;type=application/javascript+module' >/dev/null
echo "uploaded knowledge-edge"

curl -sS --fail-with-body -X PUT "$API/accounts/$ACCOUNT/workers/domains" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"hostname\":\"$HOST\",\"service\":\"knowledge-edge\",\"zone_id\":\"$ZONE\",\"environment\":\"production\"}" >/dev/null
echo "bound $HOST"
