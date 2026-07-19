#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Build the standalone CLI mirror staging tree for alethialabs-io/alethia-cli: apps/cli +
# packages/core (keeping their monorepo-relative layout so apps/cli/go.mod's
# `replace …/packages/core => ../../packages/core` resolves verbatim), tidied so each module is
# self-sufficient WITHOUT go.work, plus the mirror README/CONTRIBUTING/LICENSE.
#
# Shared by:
#   - mirror-cli.yml   → continuous source sync of alethia-cli on every main push
#   - release-cli.yml  → the exact source snapshot GoReleaser builds + publishes at release time
#
# Run from the monorepo root. Arg 1 = the staging directory to (re)build.
set -euo pipefail

STAGE="${1:?usage: build-stage.sh <stage-dir>}"

rm -rf "$STAGE"
mkdir -p "$STAGE/apps/cli" "$STAGE/packages/core"
rsync -a --delete apps/cli/ "$STAGE/apps/cli/"
rsync -a --delete packages/core/ "$STAGE/packages/core/"

# No go.work in the mirror → apps/cli builds as a standalone module; tidy it (and core) so
# go.mod/go.sum are self-sufficient. The monorepo keeps these tidy via the CI "go.mod tidy guard
# (standalone)"; this is belt-and-suspenders.
(cd "$STAGE/packages/core" && GOWORK=off go mod tidy)
(cd "$STAGE/apps/cli" && GOWORK=off go mod tidy)

cp .github/mirror/README.md "$STAGE/README.md"
cp .github/mirror/CONTRIBUTING.md "$STAGE/CONTRIBUTING.md"
cp LICENSE "$STAGE/LICENSE"

echo "staged CLI mirror tree at $STAGE"
