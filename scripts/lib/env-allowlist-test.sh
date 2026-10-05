#!/usr/bin/env bash
# shellcheck shell=bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Offline test for the SSH-allowlist refresh in scripts/env.sh (#5025). The EXIT CODE is the test;
# the text is a report.
#
# WHAT IS DRIVEN. The real scripts/env.sh, run as a command (`env.sh logs`, `env.sh box`,
# `env.sh reap`), inside a throwaway git repo that holds a copy of it next to a fixture
# infra/sandbox/terraform.tfvars and a non-empty terraform.tfstate. `curl`, `tofu`, `hcloud`, `ssh`
# and `ssh-keygen` are stubs on PATH that record every call to one log, in order. No box, no
# network, no real OpenTofu: the stub `tofu` answers `show -json` with a fixture plan, which is
# exactly the input firewall_plan_verdict decides on.
#
# WHAT EACH CASE PINS
#   1  IP already admitted (tfvars and the live firewall) → no tofu plan/apply, SSH reached
#   2  IP not admitted → tfvars /32 rewritten (backup kept), a plan TARGETED at the firewall, then
#      the SAVED plan applied — and all of it before the first ssh
#   3  the plan also touches hcloud_server.sandbox → refused, nothing applied, tfvars restored
#   4  the plan REPLACES the firewall (delete+create) → refused
#   5  the plan updates the firewall but it still would not admit the IP → refused
#   6  curl cannot determine the IP → fails closed: no tofu, no ssh, tfvars untouched
#   7  env:box, refresh opted out, IP not admitted → refused before ANY plan or apply
#   8  env:box, refresh opted out, IP admitted → gets past the check (7 is not "always refuse")
#   9  env:reap with SSH failing and the IP not admitted → fails closed, names the IP and
#      `pnpm env:allow-ip`, and never snapshots or destroys
#  10  tfvars already admits the IP but the live firewall does not → apply, no rewrite
#  11  tfvars holds two /32s → refused (which one is "mine" is not guessed)
#  12  the firewall update also adds a rule opening 443 → refused ("firewall-only" ≠ "opens a port")
#  13  a no-op entry that IMPORTS another resource → refused (it writes state)
#  14  a no-op entry that MOVES another resource → refused
#  15  a plan that does not mention the firewall at all → refused, not "nothing to do"
#  16  tfvars holds a /24 that admits the IP, the live firewall is stale → applied (coverage, not
#      string equality, decides "admits")
#  17  env:reap --dry-run with the IP not admitted → no plan, no apply, tfvars untouched (a dry run
#      mutates nothing), and the refusal names the IP
#  18  `--help` / `-h` on EVERY command (and bare `help`), box up and IP not admitted → usage, exit
#      0, and an EMPTY call log: no curl, no tofu, no hcloud, no ssh, no rsync (#5504)
#  19  a refused argument on EVERY command (all fifteen) → exit 2 with an empty call log: the parse
#      runs first
#  20  `--no-refresh` with the IP not admitted → no IP lookup, no plan/apply, still reaches SSH
#  21  the box is down and the IP not admitted → no plan/apply (nothing to refresh FOR), and the
#      command reports the box down
#  22  `env:box --no-refresh`, IP not admitted → refused before any plan or apply
#  23  `env:reap --now --no-refresh`, SSH refused → no plan/apply/snapshot/destroy, names env:allow-ip
#
# Section M mutates env.sh and requires each mutant to FAIL a named case. An assertion nothing has
# ever made fail is a claim, not a check.
#
#   bash scripts/lib/env-allowlist-test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_SH="$ROOT/scripts/env.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v jq >/dev/null 2>&1 || {
	echo "FAIL - jq is required" >&2
	exit 1
}

fails=0
ok() { echo "ok   - $1"; }
bad() {
	echo "FAIL - $1" >&2
	fails=$((fails + 1))
}

OLD_IP=203.0.113.4
NEW_IP=198.51.100.7
BOX_IP=192.0.2.10

# ── stubs ─────────────────────────────────────────────────────────────────────────────────────
STUBS="$TMP/bin"
mkdir -p "$STUBS"

cat >"$STUBS/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_LOG"
[ "${STUB_CURL_FAIL:-}" = 1 ] && exit 7
printf '%s\n' "$STUB_IP"
STUB

# tofu: `-chdir=<dir> <sub> …`. plan writes a marker into its -out file; show -json requires that
# marker (so a `show` of anything but the saved plan fails) and prints the fixture; apply logs.
cat >"$STUBS/tofu" <<'STUB'
#!/usr/bin/env bash
echo "tofu $*" >>"$STUB_LOG"
shift # -chdir=…
sub="$1"
shift
case "$sub" in
output)
	case "$*" in
	*server_ipv4*) printf '%s' "$STUB_BOX_IP" ;;
	*env_domain*) printf 'dev.example.test' ;;
	esac
	;;
plan)
	out=""
	for a in "$@"; do case "$a" in -out=*) out="${a#-out=}" ;; esac; done
	case "$*" in *-target=*) ;; *) exit 1 ;; esac # an untargeted plan: refuse_public_net's, not ours
	[ -n "$out" ] && echo "PLAN-FROM-STUB" >"$out"
	exit "${STUB_PLAN_RC:-0}"
	;;
show)
	f="${*: -1}"
	grep -q PLAN-FROM-STUB "$f" 2>/dev/null || exit 1
	cat "$STUB_PLAN_JSON"
	;;
apply)
	case "$*" in *-auto-approve*) exit 1 ;; esac # a full apply (env:box): stop the run here
	exit "${STUB_APPLY_RC:-0}"
	;;
esac
exit 0
STUB

cat >"$STUBS/hcloud" <<'STUB'
#!/usr/bin/env bash
echo "hcloud $*" >>"$STUB_LOG"
case "$*" in
*"firewall describe"*) [ -n "${STUB_FW_JSON:-}" ] && cat "$STUB_FW_JSON" || exit 1 ;;
*"server describe"*) [ "${STUB_SERVER_DOWN:-}" = 1 ] && exit 1; echo '{"status":"running"}' ;;
esac
exit 0
STUB

cat >"$STUBS/ssh" <<'STUB'
#!/usr/bin/env bash
echo "ssh $*" >>"$STUB_LOG"
exit "${STUB_SSH_RC:-0}"
STUB

cat >"$STUBS/ssh-keygen" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

# Every other binary a command can reach before or instead of ssh: logged, never real. Without these
# a help invocation that fell through to env:push would rsync to a real host, and env:open would
# open a browser — the #5504 cases drive every command, so every exit to the world is stubbed.
for _b in rsync open fswatch launchctl; do
	printf '#!/usr/bin/env bash\necho "%s $*" >>"$STUB_LOG"\nexit 0\n' "$_b" >"$STUBS/$_b"
done
chmod +x "$STUBS"/*

# ── fixtures ──────────────────────────────────────────────────────────────────────────────────
fw_json() { # <cidr…> → path
	local f="$TMP/fw-$RANDOM$RANDOM.json" list
	list="$(printf '"%s",' "$@")"
	printf '{"rules":[{"direction":"in","protocol":"tcp","port":"22","source_ips":[%s]}]}' "${list%,}" >"$f"
	printf '%s' "$f"
}

plan_json() { # <name> <json> → path
	printf '%s' "$2" >"$TMP/plan-$1.json"
	printf '%s' "$TMP/plan-$1.json"
}

# A realistic in-place update: before and after identical except the rule's source_ips.
fw_attrs() { # <cidr> [extra-rule-json]
	printf '{"id":"1","name":"alethia-sandbox","labels":{},"rule":[{"direction":"in","protocol":"tcp","port":"22","source_ips":["%s"],"destination_ips":[],"description":""}%s]}' "$1" "${2:+,$2}"
}
FW_CHANGE="{\"address\":\"hcloud_firewall.sandbox\",\"change\":{\"actions\":[\"update\"],\"before\":$(fw_attrs "$OLD_IP/32"),\"after\":$(fw_attrs "$NEW_IP/32")}}"
PLAN_OK="$(plan_json ok "{\"resource_changes\":[$FW_CHANGE]}")"
PLAN_SERVER="$(plan_json server "{\"resource_changes\":[$FW_CHANGE,{\"address\":\"hcloud_server.sandbox\",\"change\":{\"actions\":[\"update\"]}}]}")"
# before and after identical but for the source_ips, as a real replacement's would be: so ONLY the
# actions check can refuse it, and the mutation below proves that check is load-bearing.
PLAN_REPLACE="$(plan_json replace "{\"resource_changes\":[{\"address\":\"hcloud_firewall.sandbox\",\"change\":{\"actions\":[\"delete\",\"create\"],\"before\":$(fw_attrs "$OLD_IP/32"),\"after\":$(fw_attrs "$NEW_IP/32")}}]}")"
# A well-formed source_ips-only update that lands on SOMEONE ELSE's /32 — only the "does it admit
# this IP afterwards" check can refuse it.
PLAN_STILL_OLD="$(plan_json stillold "{\"resource_changes\":[{\"address\":\"hcloud_firewall.sandbox\",\"change\":{\"actions\":[\"update\"],\"before\":$(fw_attrs "$OLD_IP/32"),\"after\":$(fw_attrs "203.0.113.200/32")}}]}")"
# The SSH rule is exactly right, and the update ALSO opens 443 to the world: only the
# before/after comparison can refuse it.
PLAN_PORT="$(plan_json port "{\"resource_changes\":[{\"address\":\"hcloud_firewall.sandbox\",\"change\":{\"actions\":[\"update\"],\"before\":$(fw_attrs "$OLD_IP/32"),\"after\":$(fw_attrs "$NEW_IP/32" '{"direction":"in","protocol":"tcp","port":"443","source_ips":["0.0.0.0/0"],"destination_ips":[],"description":""}')}}]}")"
PLAN_IMPORT="$(plan_json import "{\"resource_changes\":[$FW_CHANGE,{\"address\":\"hcloud_server.sandbox\",\"change\":{\"actions\":[\"no-op\"],\"importing\":{\"id\":\"42\"}}}]}")"
PLAN_MOVED="$(plan_json moved "{\"resource_changes\":[$FW_CHANGE,{\"address\":\"hcloud_server.other\",\"previous_address\":\"hcloud_server.sandbox\",\"change\":{\"actions\":[\"no-op\"]}}]}")"
PLAN_EMPTY="$(plan_json empty '{"resource_changes":[]}')"
PLAN_WIDE="$(plan_json wide "{\"resource_changes\":[{\"address\":\"hcloud_firewall.sandbox\",\"change\":{\"actions\":[\"update\"],\"before\":$(fw_attrs "$OLD_IP/32"),\"after\":$(fw_attrs "198.51.100.0/24")}}]}")"

TFVARS_BODY() { # <cidr-list-literal>
	printf 'hcloud_token = "not-a-token"\n# ssh_allowed_cidrs = ["0.0.0.0/0", "::/0"]\nssh_allowed_cidrs = [%s]\nserver_type = "cpx42"\n' "$1"
}

# A throwaway main checkout holding <env.sh> and the fixture state. Prints its path. mktemp, not a
# counter: this runs inside $( ), where a counter's increment is discarded and every case would
# share — and inherit the backups of — one repo.
repo() { # <env.sh source> <tfvars cidr-list literal>
	local r
	r="$(mktemp -d "$TMP/repo.XXXXXX")"
	mkdir -p "$r/scripts/lib" "$r/infra/sandbox"
	cp "$1" "$r/scripts/env.sh"
	cp "$ROOT"/scripts/lib/*.sh "$r/scripts/lib/"
	TFVARS_BODY "$2" >"$r/infra/sandbox/terraform.tfvars"
	echo '{"version":4,"resources":[]}' >"$r/infra/sandbox/terraform.tfstate"
	git -C "$r" init -q
	printf '%s' "$r"
}

# Runs env.sh in <repo>. Leaves $RC, $OUT and $LOG (the ordered call log). NOT inside $( ): a
# command substitution would discard every variable this sets.
RC=0
OUT=""
LOG=""
run() { # <repo> <env.sh args…>   (stub knobs come from the caller's environment)
	local r="$1"
	shift
	LOG="$(mktemp "$TMP/log.XXXXXX")"
	: >"$LOG"
	OUT="$(cd "$r" && STUB_LOG="$LOG" STUB_BOX_IP="$BOX_IP" PATH="$STUBS:$PATH" bash scripts/env.sh "$@" 2>&1)"
	RC=$?
}

line_of() { grep -n -m1 -e "$1" "$LOG" | cut -d: -f1; } # first log line matching <pattern>
has() { grep -q -e "$1" "$LOG"; }

# ── cases: each returns 0 on pass, prints why on failure ─────────────────────────────────────
case_1() { # <env.sh>
	local r
	r="$(repo "$1" "\"$NEW_IP/32\"")"
	STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$NEW_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" logs
	[ "$RC" = 0 ] || { echo "  rc=$RC: $OUT"; return 1; }
	has '^tofu .* plan ' && { echo "  a plan ran for an admitted IP"; return 1; }
	has '^tofu .* apply' && { echo "  an apply ran for an admitted IP"; return 1; }
	has '^ssh ' || { echo "  never reached ssh"; return 1; }
}

case_2() {
	local r pl sh ap ss planfile
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" logs
	[ "$RC" = 0 ] || { echo "  rc=$RC: $OUT"; return 1; }
	grep -q "ssh_allowed_cidrs = \[\"$NEW_IP/32\"\]" "$r/infra/sandbox/terraform.tfvars" ||
		{ echo "  tfvars not rewritten: $(cat "$r/infra/sandbox/terraform.tfvars")"; return 1; }
	grep -q "$OLD_IP" "$r/infra/sandbox/terraform.tfvars" && { echo "  old IP still in tfvars"; return 1; }
	grep -q "^# ssh_allowed_cidrs = \[\"0.0.0.0/0\"" "$r/infra/sandbox/terraform.tfvars" ||
		{ echo "  the commented line was touched"; return 1; }
	# shellcheck disable=SC2012
	[ "$(ls "$r"/infra/sandbox/terraform.*.backup.tfvars 2>/dev/null | wc -l | tr -d ' ')" = 1 ] ||
		{ echo "  no single backup file"; return 1; }
	grep -q "\"$OLD_IP/32\"" "$r"/infra/sandbox/terraform.*.backup.tfvars || { echo "  backup lacks the old IP"; return 1; }
	pl="$(line_of '^tofu .* plan .*-target=hcloud_firewall.sandbox')"
	sh="$(line_of '^tofu .* show -json')"
	ap="$(line_of '^tofu .* apply')"
	ss="$(line_of '^ssh ')"
	[ -n "$pl" ] && [ -n "$sh" ] && [ -n "$ap" ] && [ -n "$ss" ] || { echo "  missing step: plan=$pl show=$sh apply=$ap ssh=$ss"; cat "$LOG"; return 1; }
	[ "$pl" -lt "$sh" ] && [ "$sh" -lt "$ap" ] && [ "$ap" -lt "$ss" ] || { echo "  wrong order"; cat "$LOG"; return 1; }
	# The apply must be of the SAVED plan (its only positional arg is the -out file), never a
	# fresh -auto-approve apply that could differ from what was checked.
	planfile="$(sed -n "${pl}p" "$LOG" | grep -Eo -- '-out=[^ ]+' | cut -d= -f2-)"
	sed -n "${ap}p" "$LOG" | grep -q -- "$planfile\$" || { echo "  apply is not of the saved plan"; cat "$LOG"; return 1; }
	sed -n "${ap}p" "$LOG" | grep -q -- '-auto-approve' && { echo "  apply used -auto-approve"; return 1; }
	[ "$(grep -c '^tofu .* apply' "$LOG")" = 1 ] || { echo "  more than one apply"; return 1; }
	# It says what it is about to do, and how not to (#5504).
	printf '%s' "$OUT" | grep -q 'rewriting that /32 (backup kept), then applying a plan targeted at hcloud_firewall.sandbox' || { echo "  no announcement: $OUT"; return 1; }
	printf '%s' "$OUT" | grep -q -- '--no-refresh skips this' || { echo "  announcement names no opt-out: $OUT"; return 1; }
	return 0
}

refused_case() { # <env.sh> <plan-json> <label>
	local r before
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	before="$(cat "$r/infra/sandbox/terraform.tfvars")"
	STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$2 run "$r" logs
	[ "$RC" != 0 ] || { echo "  $3: not refused"; return 1; }
	has '^tofu .* apply' && { echo "  $3: applied anyway"; return 1; }
	has '^ssh ' && { echo "  $3: went on to ssh"; return 1; }
	[ "$(cat "$r/infra/sandbox/terraform.tfvars")" = "$before" ] || { echo "  $3: tfvars not restored"; return 1; }
	printf '%s' "$OUT" | grep -q 'Refusing to apply the SSH-allowlist refresh' || { echo "  $3: wrong message: $OUT"; return 1; }
}
case_3() { refused_case "$1" "$PLAN_SERVER" "server in plan"; }
case_4() { refused_case "$1" "$PLAN_REPLACE" "firewall replaced"; }
case_5() { refused_case "$1" "$PLAN_STILL_OLD" "firewall still old"; }
case_12() { refused_case "$1" "$PLAN_PORT" "firewall update also opens a port"; }
case_13() { refused_case "$1" "$PLAN_IMPORT" "a no-op that imports"; }
case_14() { refused_case "$1" "$PLAN_MOVED" "a no-op that moves"; }
case_15() { refused_case "$1" "$PLAN_EMPTY" "a plan without the firewall"; }

case_6() {
	local r before
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	before="$(cat "$r/infra/sandbox/terraform.tfvars")"
	STUB_CURL_FAIL=1 STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" logs
	[ "$RC" != 0 ] || { echo "  curl failed and the command succeeded"; return 1; }
	has '^tofu .* plan ' && { echo "  planned without an IP"; return 1; }
	has '^tofu .* apply' && { echo "  applied without an IP"; return 1; }
	has '^ssh ' && { echo "  went on to ssh"; return 1; }
	[ "$(cat "$r/infra/sandbox/terraform.tfvars")" = "$before" ] || { echo "  tfvars changed"; return 1; }
	printf '%s' "$OUT" | grep -q "cannot determine this machine's public IPv4" || { echo "  wrong message: $OUT"; return 1; }
}

case_7() {
	local r
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	ALETHIA_SANDBOX_NO_IP_REFRESH=1 STUB_IP=$NEW_IP STUB_PLAN_JSON=$PLAN_OK run "$r" box
	[ "$RC" != 0 ] || { echo "  env:box succeeded"; return 1; }
	has '^tofu .* plan' && { echo "  planned before refusing"; cat "$LOG"; return 1; }
	has '^tofu .* apply' && { echo "  applied before refusing"; return 1; }
	printf '%s' "$OUT" | grep -q 'refusing to build a box this machine cannot reach' || { echo "  wrong message: $OUT"; return 1; }
	printf '%s' "$OUT" | grep -q "$NEW_IP" || { echo "  message does not name the IP"; return 1; }
}

case_8() {
	local r
	r="$(repo "$1" "\"$NEW_IP/32\"")"
	ALETHIA_SANDBOX_NO_IP_REFRESH=1 STUB_IP=$NEW_IP STUB_PLAN_JSON=$PLAN_OK run "$r" box
	printf '%s' "$OUT" | grep -q 'refusing to build' && { echo "  refused an admitted IP: $OUT"; return 1; }
	has '^tofu .* apply -input=false -auto-approve' || { echo "  never reached the box apply"; cat "$LOG"; return 1; }
}

case_9() {
	local r
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	ALETHIA_SANDBOX_NO_IP_REFRESH=1 STUB_SSH_RC=255 STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" \
		STUB_PLAN_JSON=$PLAN_OK run "$r" reap --now
	[ "$RC" != 0 ] || { echo "  reap succeeded with SSH down"; return 1; }
	has 'create-image' && { echo "  snapshotted"; return 1; }
	has '^tofu .* destroy' && { echo "  destroyed"; return 1; }
	printf '%s' "$OUT" | grep -q "public IP ($NEW_IP) is not on the box's SSH allowlist" || { echo "  does not name the IP: $OUT"; return 1; }
	printf '%s' "$OUT" | grep -q 'pnpm env:allow-ip' || { echo "  does not name the fix: $OUT"; return 1; }
}

case_10() {
	local r
	r="$(repo "$1" "\"$NEW_IP/32\"")"
	STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" logs
	[ "$RC" = 0 ] || { echo "  rc=$RC: $OUT"; return 1; }
	has '^tofu .* apply' || { echo "  stale live firewall not applied"; return 1; }
	# shellcheck disable=SC2012
	[ "$(ls "$r"/infra/sandbox/terraform.*.backup.tfvars 2>/dev/null | wc -l | tr -d ' ')" = 0 ] ||
		{ echo "  rewrote a tfvars that already admitted the IP"; return 1; }
	# …and says so, rather than announcing a rewrite it does not do (#5504).
	printf '%s' "$OUT" | grep -q 'only the live firewall is updated' || { echo "  wrong announcement: $OUT"; return 1; }
	printf '%s' "$OUT" | grep -q 'rewriting that /32' && { echo "  announced a tfvars rewrite it did not do"; return 1; }
	return 0
}

case_16() {
	local r
	r="$(repo "$1" "\"198.51.100.0/24\"")"
	STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_WIDE run "$r" logs
	[ "$RC" = 0 ] || { echo "  a /24 that admits the IP was refused: $OUT"; return 1; }
	has '^tofu .* apply' || { echo "  stale live firewall not applied"; return 1; }
	grep -q '"198.51.100.0/24"' "$r/infra/sandbox/terraform.tfvars" || { echo "  the /24 was rewritten"; return 1; }
}

case_17() {
	local r before
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	before="$(cat "$r/infra/sandbox/terraform.tfvars")"
	STUB_SSH_RC=255 STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" reap --dry-run
	[ "$RC" != 0 ] || { echo "  dry run reported success with SSH refused"; return 1; }
	has '^tofu .* plan' && { echo "  the dry run planned"; return 1; }
	has '^tofu .* apply' && { echo "  the dry run applied"; return 1; }
	[ "$(cat "$r/infra/sandbox/terraform.tfvars")" = "$before" ] || { echo "  the dry run rewrote tfvars"; return 1; }
	printf '%s' "$OUT" | grep -q "public IP ($NEW_IP) is not on the box's SSH allowlist" || { echo "  does not name the IP: $OUT"; return 1; }
}

case_11() {
	local r
	r="$(repo "$1" "\"$OLD_IP/32\", \"203.0.113.99/32\"")"
	STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" logs
	[ "$RC" != 0 ] || { echo "  two /32s: not refused"; return 1; }
	has '^tofu .* plan' && { echo "  planned anyway"; return 1; }
	printf '%s' "$OUT" | grep -q 'cannot tell which is this machine' || { echo "  wrong message: $OUT"; return 1; }
}

# ── #5504: nothing remote before the arguments are accepted ───────────────────────────────────
# The state these run in is the one that made the bug expensive: the box is up and this machine's
# IP is NOT admitted, so any path that reaches ensure_ssh_allowlist rewrites tfvars and applies.
# The assertion is that the call log is EMPTY — not "no apply": an IP lookup is already remote.
untouched() { # <repo> <before-tfvars> <label>
	if [ -s "$LOG" ]; then
		echo "  $3: reached the outside world:"
		sed 's/^/    /' "$LOG"
		return 1
	fi
	[ "$(cat "$1/infra/sandbox/terraform.tfvars")" = "$2" ] || { echo "  $3: tfvars rewritten"; return 1; }
	# shellcheck disable=SC2012
	[ "$(ls "$1"/infra/sandbox/terraform.*.backup.tfvars 2>/dev/null | wc -l | tr -d ' ')" = 0 ] ||
		{ echo "  $3: left a tfvars backup"; return 1; }
}

ALL_CMDS="up push down status verify logs open ssh check test runner reap box timer allow-ip"

case_18() { # --help / -h on every command: usage, exit 0, and NOTHING else
	local r before c h
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	before="$(cat "$r/infra/sandbox/terraform.tfvars")"
	for c in $ALL_CMDS; do
		for h in --help -h; do
			STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" "$c" "$h"
			[ "$RC" = 0 ] || { echo "  env:$c $h: rc=$RC: $OUT"; return 1; }
			untouched "$r" "$before" "env:$c $h" || return 1
			printf '%s' "$OUT" | grep -q -- '--no-refresh' || { echo "  env:$c $h: did not print usage: $OUT"; return 1; }
		done
	done
	for h in --help -h help; do
		STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" "$h"
		[ "$RC" = 0 ] || { echo "  env.sh $h: rc=$RC"; return 1; }
		untouched "$r" "$before" "env.sh $h" || return 1
	done
}

case_19() { # a refused argument: exit 2, and NOTHING remote before the refusal
	local r before spec
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	before="$(cat "$r/infra/sandbox/terraform.tfvars")"
	# At least one per command — all fifteen in ALL_CMDS. A command missing here can accept any
	# argument and stay green; the per-command mutants in section M prove each line is load-bearing.
	for spec in "check --bogus" "logs extra" "status --verbose" "down extra" "verify extra" \
		"open extra" "ssh extra" "runner extra" "up --bogus" "up --empty --seed" \
		"push --bogus" "test a b" "reap --bogus" "box --bogus" "timer bogus" "allow-ip extra" \
		"allow-ip --no-refresh"; do
		# shellcheck disable=SC2086  # word-splitting the spec IS the argv
		STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" $spec
		[ "$RC" = 2 ] || { echo "  env:$spec: rc=$RC (want 2): $OUT"; return 1; }
		untouched "$r" "$before" "env:$spec" || return 1
	done
}

case_20() { # --no-refresh: the read-only path — no IP lookup, no plan, no apply, still reaches SSH
	local r before
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	before="$(cat "$r/infra/sandbox/terraform.tfvars")"
	STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" logs --no-refresh
	[ "$RC" = 0 ] || { echo "  rc=$RC: $OUT"; return 1; }
	has '^curl ' && { echo "  looked up the IP"; return 1; }
	has '^tofu .* plan' && { echo "  planned"; return 1; }
	has '^tofu .* apply' && { echo "  applied"; return 1; }
	[ "$(cat "$r/infra/sandbox/terraform.tfvars")" = "$before" ] || { echo "  tfvars rewritten"; return 1; }
	has '^ssh ' || { echo "  never reached ssh"; return 1; }
}

case_21() { # the box is down: nothing to refresh FOR — no plan, no apply, the real cause reported
	local r before
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	before="$(cat "$r/infra/sandbox/terraform.tfvars")"
	STUB_SERVER_DOWN=1 STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" check
	[ "$RC" != 0 ] || { echo "  check against a down box succeeded"; return 1; }
	has '^tofu .* plan' && { echo "  planned against a down box"; return 1; }
	has '^tofu .* apply' && { echo "  applied against a down box"; return 1; }
	[ "$(cat "$r/infra/sandbox/terraform.tfvars")" = "$before" ] || { echo "  tfvars rewritten"; return 1; }
	printf '%s' "$OUT" | grep -q 'The sandbox box is not up' || { echo "  wrong message: $OUT"; return 1; }
}

case_22() { # env:box --no-refresh, IP not admitted → the flag reaches env:box: refused before any plan
	local r before
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	before="$(cat "$r/infra/sandbox/terraform.tfvars")"
	STUB_IP=$NEW_IP STUB_PLAN_JSON=$PLAN_OK run "$r" box --no-refresh
	[ "$RC" != 0 ] || { echo "  env:box --no-refresh succeeded"; return 1; }
	has '^tofu .* plan' && { echo "  planned before refusing"; cat "$LOG"; return 1; }
	has '^tofu .* apply' && { echo "  applied"; return 1; }
	[ "$(cat "$r/infra/sandbox/terraform.tfvars")" = "$before" ] || { echo "  tfvars rewritten"; return 1; }
	printf '%s' "$OUT" | grep -q 'refusing to build a box this machine cannot reach' || { echo "  wrong message: $OUT"; return 1; }
}

case_23() { # env:reap --now --no-refresh, SSH refused → no plan/apply, fails closed, names the fix
	local r before
	r="$(repo "$1" "\"$OLD_IP/32\"")"
	before="$(cat "$r/infra/sandbox/terraform.tfvars")"
	STUB_SSH_RC=255 STUB_IP=$NEW_IP STUB_FW_JSON="$(fw_json "$OLD_IP/32")" STUB_PLAN_JSON=$PLAN_OK run "$r" reap --now --no-refresh
	[ "$RC" != 0 ] || { echo "  reap succeeded with SSH down"; return 1; }
	has '^tofu .* plan' && { echo "  planned"; return 1; }
	has '^tofu .* apply' && { echo "  applied"; return 1; }
	has 'create-image' && { echo "  snapshotted"; return 1; }
	has '^tofu .* destroy' && { echo "  destroyed"; return 1; }
	[ "$(cat "$r/infra/sandbox/terraform.tfvars")" = "$before" ] || { echo "  tfvars rewritten"; return 1; }
	printf '%s' "$OUT" | grep -q 'pnpm env:allow-ip' || { echo "  does not name the fix: $OUT"; return 1; }
}

echo "# cases against scripts/env.sh"
for c in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23; do
	if why="$("case_$c" "$ENV_SH")"; then ok "case $c"; else bad "case $c"$'\n'"$why"; fi
done

# ── M: mutations — each must make its named case FAIL ──────────────────────────────────────────
echo "# M: mutations (each must be caught)"
mutant() { # <name> <case> <python-free sed program>
	local m="$TMP/mutant-$1.sh"
	# A sed that errors writes an EMPTY mutant, which fails every case and would read as "caught".
	if ! sed -e "$3" "$ENV_SH" >"$m" || [ ! -s "$m" ]; then
		bad "mutation '$1' could not be applied"
		return
	fi
	if cmp -s "$m" "$ENV_SH"; then
		bad "mutation '$1' changed nothing — it is not testing what it names"
		return
	fi
	bash -n "$m" 2>/dev/null || {
		bad "mutation '$1' does not parse — a typo is not a mutation"
		return
	}
	if "case_$2" "$m" >/dev/null 2>&1; then
		bad "mutation '$1' went UNDETECTED by case $2"
	else
		ok "mutation '$1' caught by case $2"
	fi
}
# The firewall-only check stops looking at other addresses.
# shellcheck disable=SC2016  # literal $ — a sed program over env.sh's source
mutant other-address 3 's/select(.address != \$fw) \] | length) > 0/select(false) ] | length) > 0/'
# The before/after comparison is dropped.
# shellcheck disable=SC2016  # literal $ — a sed program over env.sh's source
mutant any-firewall-change 12 's/^      elif (\$ch | length) > 0$/      elif false/'
# Imports stop counting as changes.
mutant import-ignored 13 's/or .change.importing != null$/or false/'
# The in-place-update check is dropped.
mutant replace-allowed 4 's/select(.change.actions != \["update"\]$/select(false/'
# The "admits this IP afterwards" check is dropped.
# shellcheck disable=SC2016  # literal $ — a sed program over env.sh's source
mutant admit-unchecked 5 's/if ! printf .%s.n. "\$after" | cidrs_cover "\$2"; then/if false; then/'
# The dispatcher no longer refreshes before the first ssh.
mutant no-dispatch 2 's/^up | push | down | status | verify | logs | open | ssh | check | test | runner) ensure_ssh_allowlist ;;$/nothing-matches) ensure_ssh_allowlist ;;/'
# env:box forgets to check before building.
mutant box-unchecked 7 '/^  ensure_box_allowlist$/d'
# An undeterminable IP is waved through instead of failing closed.
mutant ip-fail-open 6 '/IP_ECHO_URLS)\.$/ s/|| die "/|| return 0; die "/'
# The dry run starts refreshing (an apply) instead of only reporting.
# shellcheck disable=SC2016  # literal $ — a sed program over env.sh's source
mutant dry-run-refreshes 17 's/^    reg="\$(read_registry)"$/    ensure_ssh_allowlist; reg="$(read_registry)"/'
# The reap hint is never printed.
mutant no-reap-hint 9 's/^    ssh_unreachable_hint$/    :/'

# --help falls through to the command instead of exiting (#5504).
mutant help-falls-through 18 's/^  -h | --help)$/  -h-disabled)/'
# The refresh runs on the command name, before the arguments are read — the shape #5504 fixed.
# shellcheck disable=SC2016  # literal $ — a sed program over env.sh's source
mutant refresh-before-parse 18 's/^ENV_CMD="\${1:-}"$/ENV_CMD="${1:-}"; case "$ENV_CMD" in check) ensure_ssh_allowlist ;; esac/'
# A no-argument command stops refusing arguments, so a typo reaches the refresh.
# shellcheck disable=SC2016  # literal $ — a sed program over env.sh's source
mutant args-unchecked 19 's/^  \[ "\$ENV_NARGS" = 0 \] || usage_error "env:\$ENV_CMD takes/  true || usage_error "env:$ENV_CMD takes/'
# --no-refresh is accepted and ignored.
mutant no-refresh-ignored 20 's/^  --no-refresh) ENV_NO_REFRESH=1 ;;$/  --no-refresh) ;;/'
# A down box gets its firewall applied anyway.
mutant down-box-refreshes 21 '/^  box_exists || return 0$/d'
# --no-refresh is parsed but never exported, so env:box and env:reap do not see it.
# shellcheck disable=SC2016  # literal $ — a sed program over env.sh's source
mutant no-refresh-not-exported 22 's/^\[ -z "\$ENV_NO_REFRESH" \] || export ALETHIA_SANDBOX_NO_IP_REFRESH=1$/:/'
# EACH no-argument command, on its own, starts accepting any argument: case 19 must catch every one
# (a command with no bad-argument line would let its mutant through).
for _c in down status verify logs open ssh check runner; do
	_rest="$(printf '%s\n' down status verify logs open ssh check runner | grep -vx "$_c" | paste -sd'|' - | sed 's/|/ | /g')"
	mutant "args-accepted-by-$_c" 19 "s/^down | status | verify | logs | open | ssh | check | runner)\$/$_c) : ;; $_rest)/"
done

echo
if [ "$fails" -gt 0 ]; then
	echo "✗ $fails failure(s)" >&2
	exit 1
fi
echo "✓ all passed"
