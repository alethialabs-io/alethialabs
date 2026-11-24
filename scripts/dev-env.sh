#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Make the local development .env ready, with zero manual steps. Idempotent:
#
#   scripts/dev-env.sh
#
# The dev scripts (scripts/dev-up.sh, db-bootstrap.sh, dev-runner.sh, dev-stack.sh) run it first,
# so nobody needs to call it by hand. It:
#
#   1. creates .env from .env.example when there is none (mode 0600);
#   2. gives every `required` instance secret in deploy/selfhost/secrets.manifest a value, using
#      the manifest's generator, and never rewrites a value that is already set.
#
# In a git worktree, step 2 first takes each value from the main checkout's .env. The compose
# project name is fixed (`alethia`), so every checkout on this machine shares one Postgres volume,
# and that volume keeps the password it was initialised with. Generating a fresh password in a new
# worktree would lock it out of its own database.
#
# It prints the names it set, never a value.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=SCRIPTDIR/../deploy/selfhost/secrets.sh
. deploy/selfhost/secrets.sh

created=0
if [[ ! -f .env ]]; then
	(umask 077 && cp .env.example .env)
	created=1
fi

# The main checkout of this repository, when this tree is a linked worktree of it.
main_env=""
common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -n "$common" ]]; then
	main_root="$(dirname "$common")"
	if [[ "$main_root" != "$ROOT" && -f "$main_root/.env" ]]; then
		main_env="$main_root/.env"
	fi
fi

copied=""
if [[ -n "$main_env" ]]; then
	for name in $(manifest_secrets required); do
		[[ -z "$(env_get "$name" .env)" ]] || continue
		value="$(env_get "$name" "$main_env")"
		[[ -n "$value" ]] || continue
		env_set "$name" "$value" .env
		copied="$copied $name"
	done
fi

filled="$(fill_required_secrets .env)"

if [[ "$created" -eq 1 ]]; then
	echo "✓ created .env from .env.example"
fi
if [[ -n "$copied" ]]; then
	echo "✓ .env: took from the main checkout's .env:$copied"
fi
if [[ -n "$filled" ]]; then
	echo "✓ .env: generated $filled"
fi
