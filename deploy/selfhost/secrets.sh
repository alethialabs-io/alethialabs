# shellcheck shell=sh
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Instance-secret helpers, read from deploy/selfhost/secrets.manifest. POSIX sh, so it runs on an
# install box that has only a shell, openssl and docker. Sourced, never executed:
#
#   . deploy/selfhost/secrets.sh
#
# Sourced by deploy/install.sh, deploy/selfhost/rotate-secret.sh, scripts/dev-env.sh and
# scripts/validate-selfhost.sh. The manifest stays the one list of instance secrets; this file only
# reads it. Nothing here prints a secret value: every function that produces one writes it to a file
# or returns it on stdout to a caller that stores it.
#
# Callers may set:
#   SECRETS_MANIFEST   path to the manifest (default: deploy/selfhost/secrets.manifest)
#   SUDO               a command prefix for reading and writing the env file (install.sh sets it)

SECRETS_MANIFEST="${SECRETS_MANIFEST:-deploy/selfhost/secrets.manifest}"

# SHA-256 of each placeholder value a template (.env.example, the compose files, the object-store
# identity file) has carried for an instance secret. A placeholder is recognised by digest, so it is
# still recognised after the template stops carrying it. Add to this list; never remove from it.
# apps/console/lib/crypto/secrets.ts holds the same set, and its unit test fails when they differ.
PLACEHOLDER_DIGESTS="660599fcee9088125a9c926aeff66776919d35087651ad2badbce191dac83692 7e9886e3832c2875145a9fb5fc5148afa5c501e07209ca2222175df80390105c 88de4c7de8ca1ef22b59faaf1e939954caa1a74ce2570fd9296edab041c3e7dc b35dd74e6920a52dc01f24d238c9344e066f64c6a2197edae3ac89228fec3295 bcd6860363c05e59bc10b5b81ddf32a4806d8a664953016e82db22bb6b2b8160 f8d0d021b95e78c7bb4e5be8b05b0c9cfdbb8c9d02a014528795c0461a4ca3f2"

# manifest_secrets [required|optional|all] — the secret names in the manifest, one per line.
manifest_secrets() {
	awk -v want="${1:-all}" '
		/^[[:space:]]*#/ { next }
		$1 == "secret" && (want == "all" || $4 == want) { print $2 }
	' "$SECRETS_MANIFEST"
}

# manifest_field NAME COLUMN — one column of NAME's `secret` record (3 generator, 4 presence,
# 5 installer, 6 consumers). Prints nothing when NAME is not in the manifest.
manifest_field() {
	awk -v name="$1" -v col="$2" '
		/^[[:space:]]*#/ { next }
		$1 == "secret" && $2 == name { print $col; exit }
	' "$SECRETS_MANIFEST"
}

# manifest_generator ID — the POSIX sh command of generator ID.
manifest_generator() {
	sed -n "s/^generator[[:space:]][[:space:]]*$1[[:space:]][[:space:]]*//p" "$SECRETS_MANIFEST" | head -n 1
}

# generate_secret NAME — prints one freshly generated value for NAME, made by its manifest
# generator. Fails, printing nothing on stdout, when NAME is unknown or the generator does not
# print exactly one non-empty line.
generate_secret() {
	_gen="$(manifest_field "$1" 3)"
	[ -n "$_gen" ] || { echo "secrets.sh: $1 is not in $SECRETS_MANIFEST" >&2; return 1; }
	_cmd="$(manifest_generator "$_gen")"
	[ -n "$_cmd" ] || { echo "secrets.sh: generator $_gen (for $1) is not in $SECRETS_MANIFEST" >&2; return 1; }
	_val="$(sh -c "$_cmd" 2>/dev/null)" || { echo "secrets.sh: generator $_gen failed for $1" >&2; return 1; }
	case "$_val" in
		"" | *"
"*) echo "secrets.sh: generator $_gen did not print one value for $1" >&2; return 1 ;;
	esac
	printf '%s\n' "$_val"
}

# generator_hint NAME — the command an operator runs to make a value for NAME by hand.
generator_hint() {
	manifest_generator "$(manifest_field "$1" 3)"
}

# is_placeholder VALUE — true when VALUE is a template placeholder: an angle-bracketed
# `<…>` marker, or a value whose SHA-256 is in PLACEHOLDER_DIGESTS. An empty value is not a
# placeholder (it is missing, which callers check separately).
is_placeholder() {
	[ -n "$1" ] || return 1
	case "$1" in "<"*">") return 0 ;; esac
	_digest="$(printf '%s' "$1" | openssl dgst -sha256 -r | cut -d' ' -f1)"
	case " $PLACEHOLDER_DIGESTS " in
		*" $_digest "*) return 0 ;;
	esac
	return 1
}

# env_get KEY FILE — the value KEY has in FILE (last assignment wins, one pair of surrounding
# quotes dropped). Prints nothing when KEY or FILE is absent, or the value is empty.
env_get() {
	[ -f "$2" ] || return 0
	${SUDO:-} sed -n "s/^$1=//p" "$2" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# env_set KEY VALUE FILE — set KEY to VALUE in FILE: replace every existing `KEY=` line, or append
# one when there is none. The file keeps its mode. VALUE comes from a generator (hex, base64), so it
# holds no newline; awk receives it through the environment, never on a command line.
env_set() {
	_tmp="$(mktemp)" || return 1
	if ${SUDO:-} grep -q "^$1=" "$3" 2>/dev/null; then
		# The file is read with SUDO and awk runs as the caller: sudo would drop ENV_SET_VALUE.
		# shellcheck disable=SC2016
		${SUDO:-} cat "$3" | ENV_SET_VALUE="$2" awk -v key="$1" '
			index($0, key "=") == 1 { print key "=" ENVIRON["ENV_SET_VALUE"]; next }
			{ print }
		' >"$_tmp" || { rm -f "$_tmp"; return 1; }
	else
		{ ${SUDO:-} cat "$3" 2>/dev/null; printf '%s=%s\n' "$1" "$2"; } >"$_tmp" || { rm -f "$_tmp"; return 1; }
	fi
	# Copy over the original rather than moving the temp file, so FILE keeps its owner and mode.
	# shellcheck disable=SC2016
	${SUDO:-} sh -c 'cat "$1" > "$2"' sh "$_tmp" "$3"
	_rc=$?
	rm -f "$_tmp"
	return $_rc
}

# fill_required_secrets FILE — give every `required` manifest secret that is missing or empty in
# FILE a freshly generated value. A value already set is never rewritten. Prints the names it
# filled, space-separated, and fails when a generator fails.
fill_required_secrets() {
	_filled=""
	for _name in $(manifest_secrets required); do
		[ -z "$(env_get "$_name" "$1")" ] || continue
		_new="$(generate_secret "$_name")" || return 1
		env_set "$_name" "$_new" "$1" || return 1
		_filled="$_filled $_name"
	done
	printf '%s' "${_filled# }"
}

# placeholder_secrets FILE — the manifest secrets whose value in FILE is a template placeholder,
# space-separated.
placeholder_secrets() {
	_found=""
	for _name in $(manifest_secrets all); do
		if is_placeholder "$(env_get "$_name" "$1")"; then
			_found="$_found $_name"
		fi
	done
	printf '%s' "${_found# }"
}
