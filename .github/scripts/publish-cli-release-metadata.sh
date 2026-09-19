#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Publish one CLI version's canonical release metadata to the console, then PROVE it is visible.
#
# ONE implementation, two callers, on purpose:
#   .github/workflows/release-cli.yml               the automatic path, on the cli-v* tag push
#   .github/workflows/publish-cli-release-metadata.yml   the manual repair path
# Two copies of this would drift, and the drift would only ever be discovered by a release that
# published binaries and told nobody — which is the defect this whole path exists to close (#2482).
#
# Assumes AWS credentials are already configured (the caller assumes the read-only vault role via
# OIDC) and that `gh` is authenticated. Reads:
#
#   VERSION       stable semver, no leading v (e.g. 0.6.1)          required
#   ASM_REGION    Secrets Manager region                            default eu-central-1
#   ALETHIA_URL   console base URL                                  default https://alethialabs.io
#   GH_TOKEN      token for the two release-tag reads               required

set -euo pipefail

VERSION="${VERSION:-${1:-}}"
ASM_REGION="${ASM_REGION:-eu-central-1}"
ALETHIA_URL="${ALETHIA_URL:-https://alethialabs.io}"
WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
	echo "::error::invalid stable CLI version '${VERSION}'"
	exit 1
}

# Verify BOTH tags before publishing anything: the public release on alethia-cli (whose notes and
# URL become the payload) and the monorepo cli-v* source tag (the version anchor). A version that
# resolves on only one of them is a half-published release, and announcing it is worse than not.
gh api "repos/alethialabs-io/alethia-cli/releases/tags/v${VERSION}" >"${WORK}/release.json"
SOURCE_SHA="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/cli-v${VERSION}" --jq '.object.sha')"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
	echo "::error::cli-v${VERSION} did not resolve to a source commit"
	exit 1
}

RELEASE_API_SECRET="$(aws secretsmanager get-secret-value \
	--secret-id alethia/prod/env \
	--region "$ASM_REGION" \
	--query SecretString \
	--output text | jq -r '.RELEASE_API_SECRET // ""')"
[ -n "$RELEASE_API_SECRET" ] || {
	echo "::error::RELEASE_API_SECRET is absent from alethia/prod/env"
	exit 1
}
echo "::add-mask::$RELEASE_API_SECRET"

jq -n \
	--arg v "$VERSION" \
	--arg n "$(jq -r '.body // ""' "${WORK}/release.json")" \
	--arg d "$(jq -r '.published_at' "${WORK}/release.json")" \
	--arg u "$(jq -r '.html_url' "${WORK}/release.json")" \
	--arg s "$SOURCE_SHA" \
	'{version: $v, release_notes: $n, released_at: $d, github_release_url: $u, commit_sha: $s}' \
	>"${WORK}/release-payload.json"

curl -fsS -X POST "${ALETHIA_URL}/api/releases/cli" \
	-H "Authorization: Bearer ${RELEASE_API_SECRET}" \
	-H "Content-Type: application/json" \
	--data-binary "@${WORK}/release-payload.json"

# The API is the updater's canonical source, so a 2xx on the POST is not the finish line — poll the
# PUBLIC read path. Publishing binaries whose metadata never became visible is an incomplete
# release, and for four months it was also a silent one.
for attempt in $(seq 1 24); do
	CURRENT="$(curl -fsS "${ALETHIA_URL}/api/releases/cli" | jq -r '.version // ""' 2>/dev/null || true)"
	if [ "$CURRENT" = "$VERSION" ]; then
		echo "Canonical release metadata is live: ${CURRENT}"
		exit 0
	fi
	echo "Waiting for release metadata (${attempt}/24; current=${CURRENT:-none})…"
	sleep 5
done

echo "::error::${ALETHIA_URL}/api/releases/cli did not converge to ${VERSION}"
exit 1
