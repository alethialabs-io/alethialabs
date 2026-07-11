#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Rotate the workload-identity OIDC signing key (lib/oidc/issuer.ts) with ZERO downtime.
#
# The issuer signs the assertions all four managed clouds federate on, and a cloud caches our JWKS
# (Azure for ~24h). So you can't just swap the key — a new key must be PUBLISHED and trusted before we
# sign with it, and the outgoing key must keep verifying in-flight assertions after we stop. This script
# drives that overlap through the two published-JWKS slots the issuer reads:
#   ALETHIA_OIDC_SIGNING_KEY           — primary; the ONLY key we sign with
#   ALETHIA_OIDC_SIGNING_KEY_PREVIOUS  — published-but-not-signing; the outgoing key during the overlap
# Both are JSON fields in the ONE vault secret `alethia/prod/env` (like bootstrap-secrets.sh). CI reads
# the vault and assembles the box .env, so a rotation is: rewrite the vault → redeploy.
#
# Two-step, idempotent:
#   ./scripts/rotate-oidc-key.sh            # STEP 1: mint a new primary, park the current key in _PREVIOUS
#     → gh workflow run deploy-console.yml  #          redeploy so both keys are published + new one signs
#     → wait ≥24h (let every cloud's cached JWKS refresh + all ≤10-min old assertions expire)
#   ./scripts/rotate-oidc-key.sh --finalize # STEP 2: drop _PREVIOUS (retire the old key), then redeploy
#   ./scripts/rotate-oidc-key.sh --status   # show what's currently in the vault (kids, no private material)
#
# Env knobs (match bootstrap-secrets.sh): SECRET_ID (default alethia/prod/env), AWS_REGION
# (default eu-central-1), DRY_RUN=1 (print what would change; never writes — use with a scratch SECRET_ID).
set -euo pipefail

SECRET_ID="${SECRET_ID:-alethia/prod/env}"
REGION="${AWS_REGION:-eu-central-1}"
PRIMARY="ALETHIA_OIDC_SIGNING_KEY"
PREVIOUS="ALETHIA_OIDC_SIGNING_KEY_PREVIOUS"
MODE="rotate"
case "${1:-}" in
  --finalize) MODE="finalize" ;;
  --status)   MODE="status" ;;
  ""|--rotate) MODE="rotate" ;;
  -h|--help)  sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "error: unknown arg '$1' (try --help)" >&2; exit 2 ;;
esac

for bin in aws jq openssl; do
  command -v "$bin" >/dev/null || { echo "error: '$bin' is required" >&2; exit 1; }
done

# base64(PKCS8 RSA-2048 PEM) on one line — identical to bootstrap-secrets.sh's rsa_b64().
rsa_b64() { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | openssl base64 -A; }

# The RFC7638 JWK thumbprint of a base64(PKCS8 PEM) key — the issuer's `kid`, safe to print (public).
kid_of() {
  local b64="$1" pem n e
  [ -z "$b64" ] && { echo "-"; return; }
  pem="$(printf '%s' "$b64" | openssl base64 -d -A 2>/dev/null)" || { echo "?"; return; }
  # Derive modulus (n) + exponent (e) from the public half, then thumbprint {"e","kty","n"} (sorted).
  local pub; pub="$(printf '%s' "$pem" | openssl pkey -pubout 2>/dev/null)" || { echo "?"; return; }
  n="$(printf '%s' "$pub" | openssl pkey -pubin -noout -modulus 2>/dev/null | sed 's/^Modulus=//')"
  # A stable short fingerprint is enough for an operator to eyeball a change; sha256 of the modulus.
  printf '%s' "$n" | openssl dgst -sha256 -binary | openssl base64 -A | cut -c1-16
}

current="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --query SecretString --output text 2>/dev/null || true)"
if [ -z "$current" ] || [ "$current" = "None" ] || ! printf '%s' "$current" | jq empty >/dev/null 2>&1; then
  echo "error: vault secret '$SECRET_ID' ($REGION) is empty or unreadable — run bootstrap-secrets.sh first" >&2
  exit 1
fi
prim="$(printf '%s' "$current" | jq -r --arg k "$PRIMARY"  '.[$k] // ""')"
prev="$(printf '%s' "$current" | jq -r --arg k "$PREVIOUS" '.[$k] // ""')"

if [ "$MODE" = "status" ]; then
  echo "Vault $SECRET_ID ($REGION):"
  echo "  $PRIMARY   present=$([ -n "$prim" ] && echo yes || echo NO)  fingerprint=$(kid_of "$prim")  (signs)"
  echo "  $PREVIOUS  present=$([ -n "$prev" ] && echo yes || echo no)  fingerprint=$(kid_of "$prev")  (published only)"
  [ -n "$prev" ] && echo "→ a rotation is IN PROGRESS. After ≥24h, run: $0 --finalize" || true
  exit 0
fi

put() { # $1 = merged JSON
  if [ "${DRY_RUN:-}" = "1" ]; then
    echo "DRY_RUN: would write $(printf '%s' "$1" | jq 'keys|length') keys to $SECRET_ID ($REGION)"
    return
  fi
  local tmp; tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  printf '%s' "$1" | jq -S . > "$tmp"
  aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
    --secret-string "file://$tmp" >/dev/null
}

if [ "$MODE" = "finalize" ]; then
  if [ -z "$prev" ]; then
    echo "Nothing to finalize — $PREVIOUS is already empty. (No rotation in progress.)"
    exit 0
  fi
  echo "Retiring the outgoing key ($PREVIOUS, fingerprint $(kid_of "$prev"))."
  merged="$(printf '%s' "$current" | jq --arg k "$PREVIOUS" 'del(.[$k])')"
  put "$merged"
  echo "✓ Cleared $PREVIOUS. Finish: gh workflow run deploy-console.yml"
  exit 0
fi

# --- rotate (step 1) ---
if [ -z "$prim" ]; then
  echo "error: $PRIMARY is not set in the vault — run bootstrap-secrets.sh first (nothing to rotate)" >&2
  exit 1
fi
if [ -n "$prev" ]; then
  echo "error: a rotation is already in progress ($PREVIOUS is set, fingerprint $(kid_of "$prev"))." >&2
  echo "       Finish it first: redeploy, wait ≥24h, then '$0 --finalize'. Refusing to clobber it." >&2
  exit 1
fi

newkey="$(rsa_b64)"
echo "Rotating $PRIMARY:"
echo "  old (→ $PREVIOUS): fingerprint $(kid_of "$prim")"
echo "  new (→ $PRIMARY):  fingerprint $(kid_of "$newkey")"
merged="$(printf '%s' "$current" \
  | jq --arg p "$PREVIOUS" --arg pv "$prim" --arg k "$PRIMARY" --arg nv "$newkey" \
       '.[$p]=$pv | .[$k]=$nv')"
put "$merged"
cat <<EOF
✓ New primary minted; old key parked in $PREVIOUS (both will be published).
  Next:
    1. gh workflow run deploy-console.yml        # publish both keys; start signing with the new one
    2. wait ≥24h                                 # let every cloud's cached JWKS refresh + old assertions expire
    3. ./scripts/rotate-oidc-key.sh --finalize   # retire the old key
    4. gh workflow run deploy-console.yml         # redeploy without $PREVIOUS
EOF
