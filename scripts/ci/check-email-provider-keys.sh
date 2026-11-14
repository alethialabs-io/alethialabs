#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Does the vault hold what its selected email transport needs? The hosted deploy reads
# EMAIL_PROVIDER from `alethia/prod/env` (unset means resend), so the SES keys are required only
# when the vault selects SES. deploy/prod/required-vault-keys.txt cannot say that: it is a list of
# keys that are required ALWAYS. This is the conditional half, and it runs in two places so a
# missing key costs seconds and not a twenty-minute build:
#
#   deploy-console.yml, job `preflight`   before any image is built
#   scripts/ci/deploy-console-assemble-env.sh   again, right before the .env is written
#
# Input: the vault's JSON in EMAIL_PROVIDER_JSON (never an argument, so it is not in `ps`). Output:
# one `::error::` line per problem, and a non-zero exit. RESEND_API_KEY is not checked here: it is
# required unconditionally (it is the rollback from SES) and is in the required list.
#
#   EMAIL_PROVIDER_JSON="$json" bash scripts/ci/check-email-provider-keys.sh
#   bash scripts/ci/check-email-provider-keys.sh --self-test     # hermetic; run by ci.yml
set -euo pipefail

# The keys the app needs to send through SES and to tag each stream's sends with its configuration
# set (packages/email/src/config.ts). The events-topic allow-list is not here: the deploy has a
# default for it.
SES_KEYS=(
  ALETHIA_SES_REGION
  ALETHIA_SES_ACCESS_KEY_ID
  ALETHIA_SES_SECRET_ACCESS_KEY
  ALETHIA_SES_AUTH_CONFIG_SET
  ALETHIA_SES_GENERAL_CONFIG_SET
)

# Runs this script on each fixture and compares the exit code with the expected one. The exit code
# of THIS process is the verdict, so a failing case fails the step that runs it.
self_test() {
  local fails=0 got
  # Each case is: expected exit code, then the vault JSON.
  local cases=(
    0 '{}'
    0 '{"EMAIL_PROVIDER":""}'
    0 '{"EMAIL_PROVIDER":"resend"}'
    1 '{"EMAIL_PROVIDER":"ses"}'
    1 '{"EMAIL_PROVIDER":"ses","ALETHIA_SES_REGION":"eu-central-1","ALETHIA_SES_ACCESS_KEY_ID":"AKIAEXAMPLE","ALETHIA_SES_SECRET_ACCESS_KEY":"","ALETHIA_SES_AUTH_CONFIG_SET":"alethia-auth","ALETHIA_SES_GENERAL_CONFIG_SET":"alethia-general"}'
    0 '{"EMAIL_PROVIDER":"ses","ALETHIA_SES_REGION":"eu-central-1","ALETHIA_SES_ACCESS_KEY_ID":"AKIAEXAMPLE","ALETHIA_SES_SECRET_ACCESS_KEY":"example","ALETHIA_SES_AUTH_CONFIG_SET":"alethia-auth","ALETHIA_SES_GENERAL_CONFIG_SET":"alethia-general"}'
    1 '{"EMAIL_PROVIDER":"smtp"}'
    1 '{"EMAIL_PROVIDER":"SES"}'
    1 'not json'
  )
  local i
  for ((i = 0; i < ${#cases[@]}; i += 2)); do
    got=0
    EMAIL_PROVIDER_JSON="${cases[i + 1]}" bash "$0" >/dev/null 2>&1 || got=$?
    # Collapse every non-zero exit to 1: the contract is pass or refuse.
    [ "$got" -eq 0 ] || got=1
    if [ "$got" -ne "${cases[i]}" ]; then
      echo "::error::self-test case $((i / 2 + 1)) expected exit ${cases[i]}, got $got: ${cases[i + 1]}"
      fails=$((fails + 1))
    fi
  done
  if [ "$fails" -gt 0 ]; then
    echo "::error::check-email-provider-keys self-test: $fails of $((${#cases[@]} / 2)) case(s) failed"
    exit 1
  fi
  echo "✓ check-email-provider-keys self-test: $((${#cases[@]} / 2)) case(s) passed"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi

: "${EMAIL_PROVIDER_JSON?EMAIL_PROVIDER_JSON is not set — pass the vault JSON in the environment}"
if ! printf '%s' "$EMAIL_PROVIDER_JSON" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "::error::EMAIL_PROVIDER_JSON is not a JSON object — refusing to read it as an empty vault"
  exit 1
fi

v() { printf '%s' "$EMAIL_PROVIDER_JSON" | jq -r --arg k "$1" '.[$k] // ""'; }

provider="$(v EMAIL_PROVIDER)"
provider="${provider:-resend}"

case "$provider" in
  resend)
    echo "✓ EMAIL_PROVIDER=resend (RESEND_API_KEY is checked by the required list)"
    ;;
  ses)
    missing=0
    for k in "${SES_KEYS[@]}"; do
      if [ -z "$(v "$k")" ]; then
        echo "::error::EMAIL_PROVIDER=ses requires $k in the vault (infra/email-ses-account/README.md, steps 5 and 7)."
        missing=$((missing + 1))
      fi
    done
    if [ "$missing" -gt 0 ]; then
      echo "::error::$missing SES key(s) missing. Fill them, or set EMAIL_PROVIDER=resend to send through Resend."
      exit 1
    fi
    echo "✓ EMAIL_PROVIDER=ses and all ${#SES_KEYS[@]} SES keys are present"
    ;;
  *)
    echo "::error::EMAIL_PROVIDER='$provider' — hosted production sends through resend or ses (lower case)."
    exit 1
    ;;
esac
