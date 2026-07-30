#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMMIT="${1:-HEAD}"
OUTPUT_DIR="${2:-dist/community-source}"
SHA="$(git rev-parse "${COMMIT}^{commit}")"
SHORT_SHA="$(git rev-parse --short=12 "$SHA")"
ARCHIVE="${OUTPUT_DIR}/alethialabs-community-${SHORT_SHA}.tar.gz"

mkdir -p "$OUTPUT_DIR"
git archive \
  --format=tar \
  --prefix="alethialabs-community-${SHORT_SHA}/" \
  "$SHA" \
  -- . \
  ':(exclude)ee' \
  ':(exclude)cla/signatures' \
  | gzip -n >"$ARCHIVE"

shasum -a 256 "$ARCHIVE" | sed "s|  .*/|  |" >"${ARCHIVE}.sha256"
printf '%s\n' "$ARCHIVE"
