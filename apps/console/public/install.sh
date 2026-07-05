#!/bin/sh
# Alethia CLI installer (macOS / Linux).
# SPDX-License-Identifier: AGPL-3.0-only  ·  © 2026 Alethia Labs
# Source: https://github.com/alethialabs-io/alethialabs/blob/main/apps/console/public/install.sh
#
# Usage:
#   curl -fsSL https://get.alethialabs.io | sh
#   curl -fsSL https://get.alethialabs.io | ALETHIA_VERSION=v0.2.0 sh   # pin a version
#   curl -fsSL https://get.alethialabs.io | ALETHIA_INSTALL_DIR=/usr/local/bin sh
#
# Honors: ALETHIA_VERSION (e.g. v0.2.0 or 0.2.0), ALETHIA_INSTALL_DIR,
#         GITHUB_TOKEN/GH_TOKEN (for installing from a private repo before launch).

main() {
	set -eu

	REPO="alethialabs-io/alethialabs"
	BIN="alethia"
	GH="https://github.com/${REPO}"
	API="https://api.github.com/repos/${REPO}"

	err() { printf 'error: %s\n' "$*" >&2; exit 1; }
	have() { command -v "$1" >/dev/null 2>&1; }

	have tar || err "tar is required"
	if have curl; then DL="curl"; elif have wget; then DL="wget"; else err "curl or wget is required"; fi
	TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

	# fetch <url> <outfile|-> ; use '-' to stream to stdout
	fetch() {
		_url="$1"; _out="$2"
		if [ "$DL" = "curl" ]; then
			if [ -n "$TOKEN" ]; then
				curl -fsSL -H "Authorization: Bearer $TOKEN" -o "$_out" "$_url"
			else
				curl -fsSL -o "$_out" "$_url"
			fi
		else
			if [ -n "$TOKEN" ]; then
				wget -q --header="Authorization: Bearer $TOKEN" -O "$_out" "$_url"
			else
				wget -q -O "$_out" "$_url"
			fi
		fi
	}

	# --- platform detection (match GoReleaser archive names) ---
	os="$(uname -s)"
	case "$os" in
		Linux) OS="Linux" ;;
		Darwin) OS="Darwin" ;;
		*) err "unsupported OS '$os' — on Windows use install.ps1 (irm https://get.alethialabs.io/install.ps1 | iex)" ;;
	esac
	case "$(uname -m)" in
		x86_64 | amd64) ARCH="x86_64" ;;
		arm64 | aarch64) ARCH="arm64" ;;
		*) err "unsupported architecture '$(uname -m)'" ;;
	esac
	ASSET="${BIN}_${OS}_${ARCH}.tar.gz"

	# --- resolve version (pinned env, else latest cli-vX.Y.Z release) ---
	VERSION="${ALETHIA_VERSION:-}"
	if [ -n "$VERSION" ]; then
		case "$VERSION" in
			cli-v*) TAG="$VERSION" ;;
			v*) TAG="cli-$VERSION" ;;
			*) TAG="cli-v$VERSION" ;;
		esac
	else
		printf 'Resolving latest alethia release...\n' >&2
		# CLI binary releases are tagged cli-vX.Y.Z (release-please monorepo scheme).
		_ver="$(
			fetch "${API}/releases?per_page=100" - \
			| grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
			| sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"//; s/"$//' \
			| grep -E '^cli-v[0-9]+\.[0-9]+\.[0-9]+$' \
			| sed 's/^cli-v//' \
			| sort -t. -k1,1n -k2,2n -k3,3n \
			| tail -n1
		)"
		[ -n "$_ver" ] || err "could not resolve the latest release (private repo? set GITHUB_TOKEN). You can also pin ALETHIA_VERSION=vX.Y.Z"
		TAG="cli-v$_ver"
	fi

	BASE="${GH}/releases/download/${TAG}"

	# --- install dir (user-space, no sudo) ---
	BIN_DIR="${ALETHIA_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
	mkdir -p "$BIN_DIR" || err "cannot create install dir: $BIN_DIR"

	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT INT TERM

	printf 'Downloading %s (%s)...\n' "$ASSET" "$TAG" >&2
	fetch "${BASE}/${ASSET}" "$TMP/$ASSET" || err "download failed for $ASSET ($TAG)"
	fetch "${BASE}/checksums.txt" "$TMP/checksums.txt" || err "could not download checksums.txt"

	# --- verify sha256 (Linux: sha256sum, macOS: shasum -a 256) ---
	printf 'Verifying checksum...\n' >&2
	expected="$(grep " ${ASSET}\$" "$TMP/checksums.txt" | awk '{print $1}')"
	[ -n "$expected" ] || err "no checksum entry for $ASSET"
	if have sha256sum; then actual="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
	elif have shasum; then actual="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
	else err "need sha256sum or shasum to verify the download"; fi
	[ "$actual" = "$expected" ] || err "checksum mismatch for $ASSET (expected $expected, got $actual)"

	# --- extract + install ---
	tar -xzf "$TMP/$ASSET" -C "$TMP" || err "failed to extract $ASSET"
	[ -f "$TMP/$BIN" ] || err "binary '$BIN' not found in archive"
	install -m 0755 "$TMP/$BIN" "$BIN_DIR/$BIN" 2>/dev/null || { mv "$TMP/$BIN" "$BIN_DIR/$BIN"; chmod 0755 "$BIN_DIR/$BIN"; }

	printf '\n✓ Installed %s %s to %s/%s\n' "$BIN" "$TAG" "$BIN_DIR" "$BIN"
	case ":$PATH:" in
		*":$BIN_DIR:"*) printf 'Run: %s --version\n' "$BIN" ;;
		*) printf 'Add it to your PATH, e.g.:\n  export PATH="%s:$PATH"\nThen run: %s --version\n' "$BIN_DIR" "$BIN" ;;
	esac
}

main "$@"
