#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Tier-0 self-host validation — proves `deploy/install.sh` (the `curl … | sh` installer)
# still stands up cleanly, keeps its idempotency + Caddy auto-TLS wiring, and can't ship an
# instance with unset secrets. Two modes:
#
#   scripts/validate-selfhost.sh            # STATIC — free, hermetic, every-PR proof
#   scripts/validate-selfhost.sh --live     # + LIVE round-trip (needs Docker; brings the stack up)
#
# STATIC checks (no network, no daemon):
#   1. install.sh is shellcheck-clean (POSIX sh).
#   2. Every secret install.sh writes with set_kv exists in .env.example — else the sed
#      silently no-ops and the box boots with a DEFAULT secret (the failure this guards).
#   3. The prod compose overlay renders (`docker compose … config`).
#   4. Caddy auto-TLS is wired: deploy/prod/Caddyfile reads ALETHIA_DOMAIN + ALETHIA_ACME_EMAIL,
#      and the rendered caddy service carries both.
#
# LIVE adds the compose→hero-flow round-trip: bring the stack up, get /api/health 200 through
# Caddy, prove a second `up -d` is a no-op (idempotent), tear down. The real-domain + real-cert
# leg stays a maintainer step (needs DNS + a public box) — see deploy/prod/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

INSTALL_SH="deploy/install.sh"
ENV_EXAMPLE=".env.example"
PROD_CADDYFILE="deploy/prod/Caddyfile"
COMPOSE_FILES=(-f docker-compose.yml -f deploy/prod/docker-compose.prod.yml)

green() { printf '\033[32m✓\033[0m %s\n' "$1"; }
info()  { printf '\033[1m▸ %s\033[0m\n' "$1"; }
fail()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

FAILURES=0

# 1. install.sh is shellcheck-clean.
check_shellcheck() {
	info "shellcheck ${INSTALL_SH}"
	if ! command -v shellcheck >/dev/null 2>&1; then
		fail "shellcheck not installed — cannot lint ${INSTALL_SH} (brew install shellcheck)"
		return
	fi
	if shellcheck "${INSTALL_SH}"; then
		green "${INSTALL_SH} passes shellcheck"
	else
		fail "${INSTALL_SH} has shellcheck findings"
	fi
}

# 2. Every set_kv KEY in install.sh has a matching KEY= in .env.example.
check_env_key_parity() {
	info "secret-key parity (install.sh set_kv ↔ .env.example)"
	local keys key missing=0
	# `set_kv KEY "value"` — pull the KEY tokens. grep can match nothing legitimately, so guard it.
	keys="$(grep -oE 'set_kv [A-Z0-9_]+' "${INSTALL_SH}" | awk '{print $2}' | sort -u || true)"
	if [ -z "${keys}" ]; then
		fail "found no set_kv calls in ${INSTALL_SH} — has it changed shape?"
		return
	fi
	for key in ${keys}; do
		if grep -qE "^${key}=" "${ENV_EXAMPLE}"; then
			green "${key} present in ${ENV_EXAMPLE}"
		else
			fail "${key} is set by install.sh but MISSING from ${ENV_EXAMPLE} — sed would silently no-op (default secret ships)"
			missing=$((missing + 1))
		fi
	done
	[ "${missing}" -eq 0 ] || true
}

# 3. The prod compose overlay renders. Captured once and reused for the Caddy assertions.
#    Several services carry `env_file: .env`, which install.sh creates from .env.example before
#    it ever runs compose. Mirror that here with a throwaway .env so `config` can resolve it —
#    only when one isn't already present, and always cleaned up (it's gitignored regardless).
RENDERED_COMPOSE=""
TEMP_ENV_CREATED=0
cleanup_temp_env() { [ "${TEMP_ENV_CREATED}" -eq 1 ] && rm -f "${ROOT}/.env"; }
trap cleanup_temp_env EXIT

check_compose_renders() {
	info "docker compose config (base + prod overlay)"
	if ! command -v docker >/dev/null 2>&1; then
		fail "docker not installed — cannot render the compose overlay"
		return
	fi
	if [ ! -f "${ROOT}/.env" ]; then
		cp "${ENV_EXAMPLE}" "${ROOT}/.env"
		TEMP_ENV_CREATED=1
	fi
	local err
	if RENDERED_COMPOSE="$(docker compose "${COMPOSE_FILES[@]}" config 2>/dev/null)"; then
		green "prod compose overlay renders"
	else
		err="$(docker compose "${COMPOSE_FILES[@]}" config 2>&1 >/dev/null || true)"
		fail "docker compose config failed for the prod overlay: ${err}"
		RENDERED_COMPOSE=""
	fi
}

# 4. Caddy auto-TLS wiring: the Caddyfile reads the env vars, and the rendered caddy service carries them.
check_caddy_tls_wiring() {
	info "Caddy auto-TLS wiring"
	local var
	for var in ALETHIA_DOMAIN ALETHIA_ACME_EMAIL; do
		if grep -qE "\{\\\$${var}" "${PROD_CADDYFILE}"; then
			green "${PROD_CADDYFILE} reads \${${var}}"
		else
			fail "${PROD_CADDYFILE} does not reference \${${var}} — auto-TLS would not pick up the domain/email"
		fi
	done
	if [ -z "${RENDERED_COMPOSE}" ]; then
		fail "cannot assert the caddy service env (compose did not render)"
		return
	fi
	for var in ALETHIA_DOMAIN ALETHIA_ACME_EMAIL; do
		if printf '%s\n' "${RENDERED_COMPOSE}" | grep -qE "^\s+${var}:"; then
			green "rendered caddy service passes ${var}"
		else
			fail "rendered compose does not pass ${var} to the caddy service"
		fi
	done
}

# --- LIVE round-trip (opt-in) ----------------------------------------------------------------
HEALTH_URL="${HEALTH_URL:-http://localhost/api/health}"
LIVE_TIMEOUT="${LIVE_TIMEOUT:-180}"

live_up() { docker compose "${COMPOSE_FILES[@]}" up -d --remove-orphans; }

check_live_roundtrip() {
	info "LIVE round-trip (compose → /api/health → idempotent re-run)"
	command -v docker >/dev/null 2>&1 || { fail "docker required for --live"; return; }

	info "pulling + starting the stack…"
	docker compose "${COMPOSE_FILES[@]}" pull
	live_up

	info "waiting for ${HEALTH_URL} (up to ${LIVE_TIMEOUT}s)…"
	local waited=0 ok=0
	while [ "${waited}" -lt "${LIVE_TIMEOUT}" ]; do
		if curl -fsS -o /dev/null "${HEALTH_URL}" 2>/dev/null; then ok=1; break; fi
		sleep 5; waited=$((waited + 5))
	done
	if [ "${ok}" -eq 1 ]; then green "hero-flow health 200 through Caddy after ${waited}s"; else fail "health never came up within ${LIVE_TIMEOUT}s"; fi

	# Idempotent re-run: a second `up -d` must not recreate anything.
	info "asserting a second up -d is idempotent…"
	local second
	second="$(live_up 2>&1 || true)"
	if printf '%s\n' "${second}" | grep -qiE 'Recreat|Recreating|Created'; then
		fail "second up -d recreated containers — not idempotent:\n${second}"
	else
		green "second up -d made no changes (idempotent)"
	fi

	# Real-domain cert assertion is only meaningful with a public DOMAIN + DNS — maintainer-gated.
	if [ -n "${DOMAIN:-}" ]; then
		info "DOMAIN set — a real cert should be in the caddy-data volume (maintainer verifies on the box)"
	fi

	info "tearing the stack down…"
	docker compose "${COMPOSE_FILES[@]}" down >/dev/null 2>&1 || true
}

main() {
	local live=0
	[ "${1:-}" = "--live" ] && live=1

	check_shellcheck
	check_env_key_parity
	check_compose_renders
	check_caddy_tls_wiring
	[ "${live}" -eq 1 ] && check_live_roundtrip

	echo
	if [ "${FAILURES}" -eq 0 ]; then
		green "self-host Tier-0 validation passed"
	else
		fail "${FAILURES} check(s) failed"
		exit 1
	fi
}

main "$@"
