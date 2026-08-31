#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Prove the RFC 9728 -> RFC 8414 discovery chain advertised by /api/mcp.
# Status alone is never sufficient: the production regression returned an HTML page.
set -euo pipefail

fail() { echo "✗ $*" >&2; exit 1; }
pass() { echo "✓ $*"; }

base="${1:-}"
if [ "$base" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  cleanup() {
    [ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null || true
    rm -rf "$tmp"
  }
  trap cleanup EXIT
  port_file="$tmp/port"
  cat >"$tmp/server.mjs" <<'EOF'
import http from "node:http";
import fs from "node:fs";
const server = http.createServer((req, res) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cors = {"access-control-allow-origin":"*"};
  if (req.method === "OPTIONS") {
    res.writeHead(204, {...cors,"access-control-max-age":"86400"}); return res.end();
  }
  if (req.method === "POST" && req.url === "/api/mcp") {
    res.writeHead(401, {...cors,"content-type":"application/json","www-authenticate":`Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`});
    return res.end('{"error":"invalid_token"}');
  }
  if (req.url === "/.well-known/oauth-protected-resource/api/mcp") {
    res.writeHead(200, {...cors,"content-type":"application/json"});
    return res.end(JSON.stringify({resource:`${origin}/api/mcp`,authorization_servers:[`${origin}/api/auth`]}));
  }
  if (req.url === "/.well-known/oauth-protected-resource") {
    res.writeHead(200, {...cors,"content-type":"application/json"});
    return res.end(JSON.stringify({resource:`${origin}/api/mcp`,authorization_servers:[`${origin}/api/auth`]}));
  }
  if (req.url === "/.well-known/oauth-authorization-server/api/auth") {
    res.writeHead(200, {...cors,"content-type":"application/json"});
    return res.end(JSON.stringify({issuer:`${origin}/api/auth`,authorization_endpoint:`${origin}/api/auth/oauth2/authorize`,token_endpoint:`${origin}/api/auth/oauth2/token`,jwks_uri:`${origin}/api/auth/jwks`,client_id_metadata_document_supported:true}));
  }
  res.writeHead(404, {...cors,"content-type":"application/json"}); res.end('{"error":"not_found"}');
});
server.listen(0,"127.0.0.1",()=>fs.writeFileSync(process.argv[2],String(server.address().port)));
EOF
  node "$tmp/server.mjs" "$port_file" & server_pid=$!
  for _ in $(seq 1 50); do [ -s "$port_file" ] && break; sleep 0.05; done
  [ -s "$port_file" ] || fail "self-test server did not start"
  base="http://127.0.0.1:$(cat "$port_file")"
elif [ -z "$base" ]; then
  echo "usage: scripts/check-mcp-discovery.sh <base-url> | --self-test" >&2
  exit 2
fi

base="${base%/}"
tmp="${tmp:-$(mktemp -d)}"
if [ -z "${server_pid:-}" ]; then trap 'rm -rf "$tmp"' EXIT; fi

request() {
  local name="$1" method="$2" url="$3"
  shift 3
  curl -sS -X "$method" -D "$tmp/$name.headers" -o "$tmp/$name.body" \
    -w '%{http_code}' "$@" "$url" >"$tmp/$name.status"
}

status_is() { [ "$(cat "$tmp/$1.status")" = "$2" ] || fail "$1: expected HTTP $2, got $(cat "$tmp/$1.status")"; }
header() { awk -v key="$2" 'BEGIN{IGNORECASE=1} $0 ~ "^" key ":" {sub(/^[^:]*:[[:space:]]*/,""); sub(/\r$/,""); print; exit}' "$tmp/$1.headers"; }
json_type() { case "$(header "$1" content-type)" in application/json*) ;; *) fail "$1: expected application/json, got $(header "$1" content-type)";; esac; }
cors() { [ "$(header "$1" access-control-allow-origin)" = "*" ] || fail "$1: missing wildcard CORS"; }
not_html() { ! head -c 64 "$tmp/$1.body" | grep -qi '<!doctype' || fail "$1: returned an HTML document"; }
absolute_url() { case "$1" in http://*|https://*) ;; *) fail "$2 is not absolute: $1";; esac; }

request protected GET "$base/.well-known/oauth-protected-resource/api/mcp"
status_is protected 200; json_type protected; cors protected; not_html protected
resource="$(jq -er '.resource' "$tmp/protected.body")"
auth_server="$(jq -er '.authorization_servers[0]' "$tmp/protected.body")"
case "$resource" in */api/mcp) ;; *) fail "protected resource does not end /api/mcp: $resource";; esac
case "$resource" in */api/auth*) fail "protected resource incorrectly names /api/auth: $resource";; esac
absolute_url "$auth_server" authorization_servers
pass "protected-resource metadata is canonical JSON"

request protected_bare GET "$base/.well-known/oauth-protected-resource"
status_is protected_bare 200; json_type protected_bare; cors protected_bare; not_html protected_bare

request auth_server GET "$base/.well-known/oauth-authorization-server/api/auth"
status_is auth_server 200; json_type auth_server; cors auth_server; not_html auth_server
[ "$(jq -er '.issuer' "$tmp/auth_server.body")" = "$auth_server" ] || fail "authorization-server issuer disagrees with protected-resource metadata"
for field in authorization_endpoint token_endpoint jwks_uri; do absolute_url "$(jq -er ".$field" "$tmp/auth_server.body")" "$field"; done
[ "$(jq -er '.client_id_metadata_document_supported' "$tmp/auth_server.body")" = true ] || fail "CIMD support not advertised"
pass "authorization-server metadata completes the discovery chain"

for name_path in 'auth_bare /.well-known/oauth-authorization-server' 'wrong_resource /.well-known/oauth-protected-resource/api/auth'; do
  read -r check_name check_path <<<"$name_path"
  request "$check_name" GET "$base$check_path"; status_is "$check_name" 404; json_type "$check_name"; cors "$check_name"; not_html "$check_name"
done
pass "unsupported metadata paths fail as CORS-enabled JSON"

for name_path in 'protected_options /.well-known/oauth-protected-resource/api/mcp' 'auth_options /.well-known/oauth-authorization-server/api/auth'; do
  read -r check_name check_path <<<"$name_path"
  request "$check_name" OPTIONS "$base$check_path" -H 'Origin: https://claude.ai' -H 'Access-Control-Request-Method: GET'
  status_is "$check_name" 204; cors "$check_name"
  [ "$(header "$check_name" access-control-max-age)" = 86400 ] || fail "$check_name: expected access-control-max-age 86400"
done
pass "metadata preflights are cacheable and cross-origin"

request challenge POST "$base/api/mcp" -H 'content-type: application/json' --data '{}'
status_is challenge 401
challenge="$(header challenge www-authenticate)"
metadata_url="$(printf '%s' "$challenge" | sed -n 's/.*resource_metadata="\([^"]*\)".*/\1/p')"
[ -n "$metadata_url" ] || fail "401 challenge has no resource_metadata URL"
case "$metadata_url" in */.well-known/oauth-protected-resource/api/mcp) ;; *) fail "challenge names the wrong metadata URL: $metadata_url";; esac
case "$metadata_url" in */api/auth*) fail "challenge still advertises /api/auth";; esac
request challenge_target GET "$metadata_url"
status_is challenge_target 200; json_type challenge_target; not_html challenge_target
pass "the 401 pointer names a JSON document the server serves"

echo "MCP discovery proof passed for $base"
