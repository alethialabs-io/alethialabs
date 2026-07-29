#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# `pnpm env:*` — run this branch's environment on the sandbox box instead of on your
# Mac. The Mac keeps the editor, git and the cheap checks; everything that RUNS the
# product lives on the box (see .claude/skills/dev/SKILL.md and CLAUDE.md).
#
#   env:up      ensure this branch has an environment, and that it is running
#   env:push    rsync the working tree (the fast inner loop)   [--watch]
#   env:down    release this branch's environment
#   env:status  the box, every environment, capacity, cost
#   env:logs    tail this env's console  (sign-in codes are printed here)
#   env:open    open this env in a browser
#   env:ssh     shell on the box
#   env:check   tsc + lint + vitest ON THE BOX (worktrees are de-hydrated)
#   env:test    Playwright browser tests ON THE BOX; report + traces rsync'd back
#   env:runner  a provisioning runner pointed at this env
#   env:reap    snapshot + DELETE the box (stops the meter)   [--now]
#   env:timer   reap the box automatically once idle   [off|status]
#   env:box     create or restore the box   [--fresh = ignore snapshots]
set -euo pipefail

# ── $ROOT was doing three jobs at once, and only the first was right ──────────────
#
#   1. "this branch's working tree"      — correct: cd, slug(), push_tree's source
#   2. "where the box's IaC state lives" — WRONG: state is gitignored, so it exists ONLY
#                                          in the main checkout
#   3. "the box-global control scripts"  — WRONG: they belong to the shared box, not to
#                                          whichever branch last ran env:up
#
# Conflating 1 and 2 made every worktree report `box: down (reaped or never created)`
# while the box was up — `tofu output` does not error without state, it prints a warning
# and nothing, which box_ip's shape-check correctly swallows. That silence gated env:up,
# push, down, logs, ssh, check and runner: a session could not even RELEASE its own env.
#
# So they get separate names. MAIN_CHECKOUT is the same git-common-dir resolution
# .claude/hooks/session-runtime.sh uses.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MAIN_CHECKOUT="$ROOT"
_git_common="$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
case "$_git_common" in
*/.git)
  # In a linked worktree the common dir is the MAIN checkout's .git; its parent is the
  # main checkout, which is the only tree holding terraform.tfstate / terraform.tfvars.
  MAIN_CHECKOUT="$(cd "$(dirname "$_git_common")" 2>/dev/null && pwd || echo "$ROOT")"
  ;;
esac

TF_DIR="$MAIN_CHECKOUT/infra/sandbox"
SERVER_NAME="alethia-sandbox"
# The hcloud CLI's "active context" is ONE global value in ~/.config/hcloud/cli.toml,
# shared by every instance on this machine — and other sessions change it. It drifted to
# `tovr-sandbox` and then to `alethia-infra-tests` during a single task here, which made
# `hc server describe` fail and the live box read as DOWN.
#
# A wrong status is the mild failure. The severe one is env:reap: `server create-image`
# followed by `tofu destroy`, aimed at whatever project someone else last selected. So
# every call is pinned, and the active context is never consulted or mutated.
HCLOUD_CONTEXT_NAME="${ALETHIA_HCLOUD_CONTEXT:-alethia-sandbox}"
hc() { hcloud --context "$HCLOUD_CONTEXT_NAME" "$@"; }
SNAPSHOT_LABEL="role=sandbox"
REMOTE=/opt/alethia
# Idle minutes before env:reap will snapshot-and-delete. The restore path costs 1-2
# minutes and a box reaped out from under a long test run is far more expensive than a
# few idle euros, so this stays well clear of any real run (the longest measured browser
# run is 36 SECONDS).
#
# Was 180, sized for several people whose runs must not vanish mid-flight. With one user
# that is three idle hours after every session, and idle hours are the entire cost
# problem: Hetzner bills a server for as long as it EXISTS, so the difference between a
# box reaped promptly and one left up is the difference between EUR 0.72/mo and EUR 69.49.
REAP_AFTER_MIN="${ALETHIA_REAP_AFTER_MIN:-90}"

# The launchd timer that makes the reap automatic. env:reap was complete and proven for
# days while nothing ever CALLED it, and a cost control you have to remember is not a
# cost control — the box ran 24/7 on that gap.
LAUNCH_LABEL="io.alethialabs.sandbox-reap"
LAUNCH_PLIST="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist"
REAP_TIMER_LOG="${ALETHIA_REAP_LOG:-/tmp/alethia-reap.log}"
REAP_EVERY_SEC="${ALETHIA_REAP_EVERY_SEC:-1800}"

die() {
  echo "✗ $*" >&2
  exit 1
}

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."; }

# ── Identity ──────────────────────────────────────────────────────────────────────
# The slug is the branch name with the feat/ prefix stripped and anything that is not
# a DNS label flattened — it becomes a hostname, a database name and a tmux session.
#
# ALETHIA_ENV_SLUG overrides the branch, for ONE reason: Cloudflare Universal SSL covers
# `alethialabs.io` and `*.alethialabs.io` — one label deep. A branch env is
# `<slug>.dev.alethialabs.io`, which is TWO labels and therefore has no publicly valid
# certificate. Anything that needs a cloud to fetch this console over VERIFIED TLS only
# works on the primary `dev.alethialabs.io`: the workload-identity issuer above all (AWS
# builds its IAM OIDC provider from the discovery doc, GCP STS and Entra re-fetch the
# JWKS on every exchange), plus OAuth redirects and the Stripe webhook, none of which can
# be wildcarded. Slug "dev" claims that hostname — and without this override only a
# checkout literally on branch `dev` could take it, i.e. the main checkout, the one
# CLAUDE.md §1 forbids working in. Set ALETHIA_ENV_SLUG=dev to claim it from a worktree.
slug() {
  local b
  b="${ALETHIA_ENV_SLUG:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo dev)}"
  b="${b#feat/}"
  b="${b#fix/}"
  b="$(printf '%s' "$b" | tr '[:upper:]/_' '[:lower:]--' | tr -cd 'a-z0-9-' | cut -c1-40)"
  b="${b%-}"
  printf '%s' "${b:-dev}"
}

owner() { printf '%s@%s' "$(id -un)" "$(hostname -s)"; }

# The env's public hostname. ONE label deep, always.
#
# Branch envs used to be <slug>.dev.<domain>, which resolved fine and then failed TLS on
# every request: Cloudflare's Universal SSL covers the apex and ONE level of subdomain, so
# a two-level name is outside the certificate and the handshake is refused. Only `dev`
# itself worked. An Advanced Certificate would fix it for about the price of the box.
#
# So a hostname belongs to the SLOT, not the branch: the registry hands out a fixed console
# port per slot, and slot N is envN-<sub>.<domain>. `dev` keeps the bare name because OAuth
# redirect URIs and the Stripe webhook are registered against exactly that.
env_fqdn() { # <slug> <consolePort>
  local slug_="$1" port="$2" domain slot
  domain="$(env_domain)"
  [ "$slug_" = "dev" ] && {
    printf '%s' "$domain"
    return 0
  }
  # 3100 -> 1, 3200 -> 2, ... — the same pool env-registry.sh allocates from.
  slot=$(((port - 3000) / 100))
  printf 'env%s-%s' "$slot" "$domain"
}

# base64 of a RAW 64-byte ed25519 private key (seed||public). Go's ed25519.PrivateKey —
# and therefore verify.SigningKeyFromEnv — wants those 64 bytes, not a PEM, and openssl
# cannot emit them directly. For ed25519 both DER encodings are fixed-length, so the seed
# is the last 32 bytes of the PKCS8 DER and the public key the last 32 of the SPKI DER.
ed25519_raw_b64() {
  local der
  der="$(mktemp)"
  openssl genpkey -algorithm ED25519 -outform DER -out "$der" 2>/dev/null
  { tail -c 32 "$der"; openssl pkey -inform DER -in "$der" -pubout -outform DER 2>/dev/null | tail -c 32; } \
    | openssl base64 -A
  rm -f "$der"
}

# ── The box ───────────────────────────────────────────────────────────────────────
box_ip() {
  # Filter to a real IPv4 rather than trusting non-emptiness: with no state, `tofu
  # output -raw` prints "Warning: No outputs found" to STDOUT, which would sail past
  # a `[ -n "$ip" ]` test and make require_box believe the box is up — then every
  # rsync/ssh fails with a confusing hostname error instead of "run pnpm env:box".
  tofu -chdir="$TF_DIR" output -raw server_ipv4 2>/dev/null |
    grep -Eo '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || true
}

box_exists() {
  [ -n "$(box_ip)" ] && hc server describe "$SERVER_NAME" >/dev/null 2>&1
}

# Is an agent driving? Same signal scripts/lib/wt-lease.sh uses. Outside Claude this is
# unset, so a human is never gated by it.
agent_driving() { [ -n "${CLAUDE_PID:-}" ] && [ "${ALETHIA_ALLOW_IAC:-}" != "1" ]; }

require_box() {
  local ip

  # "I cannot read the state" and "the box is gone" used to produce the SAME message, and
  # the remedy it named (`pnpm env:box`) is catastrophic for the first case: applying
  # against empty state creates a SECOND server plus duplicate tunnel and DNS records,
  # breaking dev.alethialabs.io. Distinguish them, loudly.
  if [ ! -s "$TF_DIR/terraform.tfstate" ]; then
    cat >&2 <<MSG
✗ Cannot read the sandbox box's OpenTofu state.

  Looked in: $TF_DIR

  The state and terraform.tfvars are gitignored, so they exist ONLY in the main checkout
  — never in a worktree. This is NOT "the box is down", and running \`pnpm env:box\` here
  would apply against empty state and build a SECOND box, breaking dev.alethialabs.io.

  If you are in a worktree and see this, the resolution of MAIN_CHECKOUT above is wrong;
  that is a bug in this script, not something to work around.
MSG
    exit 1
  fi

  ip="$(box_ip)"
  if [ -z "$ip" ] || ! hc server describe "$SERVER_NAME" >/dev/null 2>&1; then
    cat >&2 <<MSG
✗ The sandbox box is not up.

  It was either never created, or env:reap snapshotted and deleted it (which is the
  normal idle state — a stopped Hetzner server still bills, a deleted one does not).
MSG
    if agent_driving; then
      cat >&2 <<'MSG'

  ASK THE MAINTAINER to bring it back. Restoring runs `tofu apply`, which is a human
  action in this repo (infra/README.md) and is refused for agents by
  .claude/hooks/guard-iac.sh. Do not try to route around that.
MSG
    else
      cat >&2 <<'MSG'

  Bring it back with:   pnpm env:box
MSG
    fi
    exit 1
  fi
  printf '%s' "$ip"
}

# Hetzner RECYCLES IP addresses. The first real apply landed on 178.104.237.182 — the
# address a previously-deleted box had held — so known_hosts still carried the old key and
# every ssh/rsync failed with "Host key verification failed". `accept-new` does NOT cover
# this: it accepts keys for UNKNOWN hosts, never a CHANGED one.
#
# That is fatal for a box designed to be reaped and recreated: each restore can land on a
# recycled address, and the whole env:* surface is SSH. So drop the stale entry when the
# box's key changes. This is not weakening host verification in any meaningful sense — the
# box is ours, we just created it, and its identity is the Hetzner API's answer, not a key
# we have ever pinned.
forget_stale_host_key() { # <ip>
  local ip="$1"
  ssh-keygen -R "$ip" >/dev/null 2>&1 || true
}

ssh_box() {
  local ip rc
  ip="$(require_box)"
  # shellcheck disable=SC2029  # remote expansion is intended
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$ip" "$@" && return 0
  rc=$?
  # NOT `if ! ssh …; then rc=$?`: inside that branch $? is the status of the NEGATION,
  # which is always 0, so the retry below would never fire. Verified in a shell before
  # relying on it.
  #
  # 255 is ssh's own transport failure — what a changed host key produces.
  [ "$rc" = 255 ] || return "$rc"
  forget_stale_host_key "$ip"
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$ip" "$@"
}

# The domain comes from state, or not at all. Both call sites used to fall back to the
# literal "dev.alethialabs.io", which turned a state-read failure into a confident wrong
# answer — and is why `env:open` appeared to work from a worktree while every other
# command was failing.
env_domain() {
  local d
  d="$(tofu -chdir="$TF_DIR" output -raw env_domain 2>/dev/null |
    grep -Eo '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || true)"
  [ -n "$d" ] || die "cannot read env_domain from $TF_DIR — is the box's state readable?"
  printf '%s' "$d"
}

# ── Capacity preflight ────────────────────────────────────────────────────────────
# Hetzner answers an unavailable type with a bare `resource_unavailable`, which reads
# like a bug in this repo. ARM (cax*) has been out EU-wide for a while — see the long
# comment in infra/sandbox/variables.tf — so name the problem and the alternatives.
preflight_capacity() {
  local want loc avail
  want="$(grep -E '^\s*server_type' "$TF_DIR/terraform.tfvars" 2>/dev/null | sed -E 's/.*"([^"]+)".*/\1/' || true)"
  want="${want:-cpx42}"
  loc="$(grep -E '^\s*location' "$TF_DIR/terraform.tfvars" 2>/dev/null | sed -E 's/.*"([^"]+)".*/\1/' || true)"
  loc="${loc:-nbg1}"

  command -v hcloud >/dev/null 2>&1 || return 0
  avail="$(hc server-type list -o json 2>/dev/null |
    jq -r --arg w "$want" '.[] | select(.name == $w) | .name' || true)"
  [ -n "$avail" ] || return 0

  # `hc datacenter describe` carries the authoritative per-DC availability list.
  local dc ok
  dc="$(hc datacenter list -o json 2>/dev/null | jq -r --arg l "$loc" '.[] | select(.name | startswith($l)) | .name' | head -1)"
  [ -n "$dc" ] || return 0
  ok="$(hc datacenter describe "$dc" -o json 2>/dev/null |
    jq -r --arg w "$want" --slurpfile st <(hc server-type list -o json) \
      '[.server_types.available[]] as $a | ($st[0][] | select(.name==$w) | .id) as $id | if ($a | index($id)) then "yes" else "no" end' 2>/dev/null || echo yes)"

  if [ "$ok" = "no" ]; then
    echo "⚠ $want is OUT OF STOCK in $loc right now." >&2
    echo "  Available there with >=16 GB:" >&2
    hc datacenter describe "$dc" -o json 2>/dev/null |
      jq -r --slurpfile st <(hc server-type list -o json) \
        '[.server_types.available[]] as $a | $st[0][] | select(.id as $i | $a | index($i)) | select(.memory >= 16) | "    \(.name)  \(.cores)c \(.memory)GB \(.disk)GB \(.architecture)"' 2>/dev/null >&2 || true
    echo "  Set server_type in $TF_DIR/terraform.tfvars and retry." >&2
    echo >&2
  fi
}

# The two commands that MUTATE infrastructure. Both are gated twice on purpose.
#
# `.claude/hooks/guard-iac.sh` blocks the tofu command text — but `pnpm env:box` contains
# no "tofu" at all, and the real apply is spawned inside this script where no PreToolUse
# hook can see it. THE WRAPPER WAS THE BYPASS, and require_box used to point agents
# straight at it. A hook list of wrapper names can never be proven exhaustive, so the
# wrapped script refuses too — that check cannot be dodged by finding another wrapper.
#
# They also have to run where the state file is: a worktree writing the main checkout's
# state through a TF_DIR pointer is state mutation across trees.
# The lifecycle wrappers are agent-runnable by decision: the cost model needs the box
# reaped and restored without waiting for a human. Raw tofu apply/destroy is still refused
# by .claude/hooks/guard-iac.sh, so "an agent can apply arbitrary infrastructure" stays
# false — this only opens the two commands that manage THIS box.
#
# They still have to run where the state file is: a worktree writing the main checkout's
# state through a TF_DIR pointer is state mutation across trees.
require_main_checkout() { # <command>
  if [ "$ROOT" != "$MAIN_CHECKOUT" ]; then
    die "\`$1\` must run in the main checkout ($MAIN_CHECKOUT) — it writes OpenTofu state."
  fi
}

# THE COMPENSATING CONTROL for letting agents reap.
#
# A hook cannot judge this — it does not know who holds which environment. This does: the
# registry records `owner` and `lastSeen` per env. Reaping deletes the box for EVERYONE, so
# an instance tidying up after itself must not end someone else's run, and `--now` must not
# be a way around that.
#
# Fails CLOSED: if the registry cannot be read, assume someone is there.
refuse_if_others_are_working() { # <force-flag>
  local reg others
  reg="$(ssh_box "$REMOTE/bin/env-registry.sh list" 2>/dev/null || true)"
  if [ -z "$reg" ]; then
    die "cannot read the env registry — refusing to reap a box that might be in use."
  fi

  # Anyone else's env touched in the last hour counts as in use.
  others="$(printf '%s' "$reg" | jq -r --arg me "$(owner)" --arg cut "$(date -u -v-60M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
    date -u -d '60 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" '
      to_entries[] | select(.value.owner != $me and .value.lastSeen > $cut)
      | "  \(.key)\t\(.value.owner)\tlast seen \(.value.lastSeen)"' 2>/dev/null || true)"

  if [ -n "$others" ]; then
    {
      echo "✗ Not reaping — someone else is working on this box."
      echo ""
      printf '%s\n' "$others"
      echo ""
      echo "  Reaping deletes the box for everyone, so this is refused even with --now."
      echo "  Ask them to run  pnpm env:down,  or wait for their env to go idle."
    } >&2
    exit 3
  fi
}

# ── Commands ──────────────────────────────────────────────────────────────────────

# A Primary IP can only be attached to a STOPPED server, and the provider does not report
# `public_net` when it reads an existing one — so a server that did not get its IP at
# creation shows a permanent `+ public_net {...}` diff that no apply can settle while it
# runs. Applying it anyway is not a no-op: it DETACHES the address and then refuses to
# reattach ("server_not_stopped"), leaving the box running with no public IPv4.
#
# That is not theory. On 2026-07-29 it took the live box down — ssh dead, site 502 —
# because the plan said "update in-place, nothing destroyed" and that read as safe. It is
# not: in-place on a server's NETWORK CONFIG is a different thing from in-place on a label.
#
# The repair is to recreate the server, which gets public_net at creation and clears the
# drift for good. So the check names that, rather than leaving someone to discover it.
refuse_public_net_change_on_running_box() {
  local plan js pending status
  plan="$(mktemp)"
  # NO `trap ... RETURN` here. A RETURN trap set inside a function stays armed for LATER
  # function returns, where $plan is out of scope — and with `set -u` that is fatal. It
  # made env:box exit 1 AFTER a completely successful restore ("plan: unbound variable"),
  # which any caller checking the exit code would read as a failed restore.
  # Clean up explicitly instead; the paths are few and all of them are here.
  tofu -chdir="$TF_DIR" plan -input=false -out="$plan" >/dev/null 2>&1 || {
    rm -f "$plan"
    return 0
  }

  js="$(tofu -chdir="$TF_DIR" show -json "$plan" 2>/dev/null || true)"
  rm -f "$plan"
  [ -n "$js" ] || return 0
  pending="$(printf '%s' "$js" | jq -r '
    [ .resource_changes[]?
      | select(.address == "hcloud_server.sandbox")
      | select(.change.actions | index("update"))
      | select((.change.before.public_net // []) != (.change.after.public_net // []))
    ] | length' 2>/dev/null || echo 0)"
  [ "${pending:-0}" -gt 0 ] || return 0

  status="$(hc server describe "$SERVER_NAME" -o json 2>/dev/null | jq -r '.status // empty' || true)"
  [ "$status" = "running" ] || return 0

  cat >&2 <<'MSG'
✗ Refusing to apply: this would change the server's public_net while it is RUNNING.

  Hetzner can only attach a Primary IP to a STOPPED server. Applying anyway DETACHES the
  address and then fails to reattach it, leaving the box up with no public IPv4 — ssh dead,
  the site 502. That happened on 2026-07-29; the plan said "update in-place, nothing
  destroyed", which is not the same as safe for a network change.

  The drift is permanent for a server that did not receive its IP at creation, because the
  provider does not report public_net when it reads one.

  → Fix it by RECREATING the box, which attaches the address at creation:
        pnpm env:reap --now     # the Primary IP is protected and survives
        pnpm env:box            # comes back on the same address, drift gone

  → Or, if you must do it in place, stop the server first and accept the downtime.
MSG
  exit 4
}

# NON-INTERACTIVE ON PURPOSE. tofu apply/destroy prompt for approval, and anything that
# is not a terminal — an agent, a scheduled reap, CI — reads EOF and dies:
#   Enter a value: Error: error asking for approval: EOF
# env:reap hit exactly that after taking its snapshot. The prompt is not what makes these
# safe: guard-iac.sh (raw tofu still blocked), require_main_checkout and
# refuse_if_others_are_working all run before here. A prompt that only fires for humans
# adds nothing and breaks every other caller — including the nightly reap the cost model
# depends on.
cmd_box() {
  require_main_checkout "env:box"
  need tofu
  need jq
  refuse_public_net_change_on_running_box
  [ -f "$TF_DIR/terraform.tfvars" ] ||
    die "no $TF_DIR/terraform.tfvars — copy terraform.tfvars.example and fill it in."

  preflight_capacity

  # Restore from the newest snapshot if one exists, so a reaped box comes back with
  # its seeded databases and warm node_modules rather than empty.
  #
  # --fresh builds from the base image instead. Without it there was NO WAY to ignore a
  # snapshot, which made the documented cpx32 downsize impossible: Hetzner refuses to
  # restore a 320 GB (cpx42) snapshot onto a 160 GB (cpx32) disk, and cmd_box always
  # reached for the newest snapshot.
  local snap="" fresh=""
  [ "${1:-}" = "--fresh" ] && fresh=1
  if [ -z "$fresh" ] && command -v hcloud >/dev/null 2>&1; then
    snap="$(hc image list -t snapshot -l "$SNAPSHOT_LABEL" -o json 2>/dev/null |
      jq -r 'sort_by(.created) | last | (.id | tostring) + " " + (.disk_size | tostring)' || true)"
  fi

  local snap_id="${snap%% *}" snap_disk="${snap##* }"
  if [ -n "$snap_id" ] && [ "$snap_id" != "null" ]; then
    # Catch the disk mismatch HERE, with a message that names disks — Hetzner's own
    # failure arrives mid-apply and does not mention them at all.
    local want_disk
    want_disk="$(hc server-type describe "$(grep -E '^\s*server_type' "$TF_DIR/terraform.tfvars" 2>/dev/null |
      sed -E 's/.*"([^"]+)".*/\1/' || echo cpx32)" -o json 2>/dev/null | jq -r '.disk // empty' || true)"
    if [ -n "$want_disk" ] && [ -n "$snap_disk" ] && [ "$snap_disk" != "null" ] &&
      [ "${snap_disk%.*}" -gt "$want_disk" ] 2>/dev/null; then
      die "snapshot $snap_id is ${snap_disk}GB but the target server type has only ${want_disk}GB.
  Hetzner cannot restore onto a smaller disk. Either keep the larger type, or build fresh
  and accept losing the box's state:   pnpm env:box --fresh"
    fi
    echo "→ RESTORING from snapshot $snap_id (databases and warm node_modules preserved)"
    tofu -chdir="$TF_DIR" apply -input=false -auto-approve -var "image=$snap_id"
  else
    if [ -n "$fresh" ]; then
      echo "→ BUILDING FRESH (--fresh): no snapshot restored, so envs start empty"
    else
      echo "→ BUILDING FRESH: no snapshot found, so envs start empty"
    fi
    tofu -chdir="$TF_DIR" apply -input=false -auto-approve
  fi

  provision_box
  restore_live_envs
  echo "✓ box up at $(box_ip)"
}

# A power cycle or a restore kills every environment's `next dev`: the containers come back
# on their own (restart: unless-stopped) but tmux does not survive a reboot. After the
# 2026-07-29 power cycle the shared tier was healthy and every console was gone, which
# reads as "the box is broken" rather than "the sessions need restarting".
#
# The registry already knows which environments exist, so bring back exactly those.
restore_live_envs() {
  local reg slugs
  reg="$(ssh_box "$REMOTE/bin/env-registry.sh list" 2>/dev/null || true)"
  [ -n "$reg" ] || return 0
  slugs="$(printf '%s' "$reg" | jq -r 'keys[]' 2>/dev/null || true)"
  [ -n "$slugs" ] || return 0

  echo "→ restarting environments the box was running: $(printf '%s' "$slugs" | tr '\n' ' ')"
  printf '%s\n' "$slugs" | while read -r sl; do
    [ -n "$sl" ] || continue
    # Already up? tmux session present means the console survived; leave it alone.
    if ssh_box "tmux has-session -t 'alethia-$sl' 2>/dev/null"; then
      echo "    $sl — already running"
      continue
    fi
    echo "    $sl — restarting (run 'pnpm env:up' from its worktree if it needs a fresh push)"
    local row cport sport db
    row="$(printf '%s' "$reg" | jq -c --arg s "$sl" '.[$s]')"
    cport="$(printf '%s' "$row" | jq -r .consolePort)"
    sport="$(printf '%s' "$row" | jq -r .storagePort)"
    db="$(printf '%s' "$row" | jq -r .database)"
    ssh_box "test -d $REMOTE/envs/$sl && $REMOTE/bin/env-mode.sh '$sl' '$cport' '$sport' '$db'" ||
      echo "      ✗ $sl did not come back — pnpm env:up from its worktree"
  done
}

# Push the box-side scripts, the pinned shared compose file and the tunnel
# credentials. Runs on every env:up so changing a box script never means rebuilding.
#
# FROM THE MAIN CHECKOUT, not from this branch. These files are the shared box's
# control plane — env-registry.sh arbitrates every env's ports and the cap — and this
# runs on EVERY env:up. Sourcing them from the branch meant whichever branch ran
# env:up last silently redefined the allocator for everyone else's env, including a
# branch that happened to be mid-edit on those very files.
provision_box() {
  local ip
  ip="$(require_box)"

  # A freshly created or restored box may hold a RECYCLED address whose old key is still
  # in known_hosts; clear it before the first connection rather than failing 60 times.
  forget_stale_host_key "$ip"

  # Wait for cloud-init on a freshly created box.
  for _ in $(seq 1 60); do
    ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes \
      "root@$ip" 'test -f /opt/alethia/READY' 2>/dev/null && break
    sleep 5
  done

  rsync -az -e "ssh -o StrictHostKeyChecking=accept-new" \
    "$MAIN_CHECKOUT/scripts/box/" "root@$ip:$REMOTE/bin/"

  # /opt/alethia/box.env carries the env cap and the domain. cloud-init wrote it once at
  # creation, but user_data is now ignored on the server (changing it FORCES REPLACEMENT
  # — bumping the cap once planned "1 to add, 1 to destroy" against the live box). So the
  # cap is delivered here instead, and takes effect on the next env:up.
  local cap dom
  cap="$(grep -oE 'env_cap[^0-9]+[0-9]+' "$TF_DIR/terraform.tfvars" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
  dom="$(env_domain)"
  ssh_box "printf 'ALETHIA_ENV_DOMAIN=%s\nALETHIA_ENV_CAP=%s\n' '$dom' '${cap:-4}' > $REMOTE/box.env"
  ssh_box "mkdir -p $REMOTE/shared && mv $REMOTE/bin/shared-compose.yml $REMOTE/shared/docker-compose.yml && chmod +x $REMOTE/bin/*.sh"

  # Tunnel credentials, minted from tofu state — no `cloudflared tunnel login`, no
  # hand-scp'd file. Written only if absent: rewriting them is harmless but noisy.
  local creds id
  creds="$(tofu -chdir="$TF_DIR" output -raw tunnel_credentials 2>/dev/null || true)"
  id="$(tofu -chdir="$TF_DIR" output -raw tunnel_id 2>/dev/null || true)"
  if [ -n "$creds" ] && [ -n "$id" ]; then
    printf '%s' "$creds" | ssh_box "mkdir -p $REMOTE/cloudflared && cat > $REMOTE/cloudflared/credentials.json"
    printf '%s' "$id" | ssh_box "cat > $REMOTE/cloudflared/tunnel-id"
  fi
}

# rsync the WORKING TREE, uncommitted work included — the box exists to run what you
# have in front of you, not what you have pushed. node_modules/.next/.git are excluded:
# they are platform-specific or huge, and the box builds its own.
push_tree() {
  local ip slug_
  ip="$(require_box)"
  slug_="$(slug)"
  # --delete keeps the box honest about renames and deletions, which makes these two
  # excludes MANDATORY rather than tidy:
  #   .env                      is minted ON the box and exists nowhere else, so
  #                             --delete would remove it on every push; the next env:up
  #                             would then re-mint it with fresh secrets and invalidate
  #                             every live session on that env.
  #   apps/console/.env.local   holds the env's OpenFGA store id, likewise box-side.
  # Excluding .env also enforces the other half of the rule: even if a laptop worktree
  # does have one, its live keys can never be pushed to a snapshotted box.
  rsync -az --delete \
    --exclude=node_modules --exclude=.next --exclude=.git --exclude=.turbo \
    --exclude=test-results --exclude=playwright-report --exclude='*.tfstate*' \
    --exclude=.terraform \
    --exclude=/.env --exclude='.env.local' --exclude='.env.*.local' \
    --exclude='apps/*/.env.local' \
    -e "ssh -o StrictHostKeyChecking=accept-new" \
    "$ROOT/" "root@$ip:$REMOTE/envs/$slug_/"
}

cmd_push() {
  local slug_
  slug_="$(slug)"
  if [ "${1:-}" = "--watch" ]; then
    need fswatch
    echo "→ watching $ROOT — pushing to $slug_ on change (ctrl-c to stop)"
    push_tree
    # Debounced: --latency batches a burst of saves into one rsync, so a formatter
    # rewriting twenty files does not trigger twenty pushes.
    fswatch -o -l 1 -e '\.git' -e 'node_modules' -e '\.next' -e '\.turbo' "$ROOT" |
      while read -r _; do
        push_tree && echo "  pushed $(date +%H:%M:%S)"
      done
  else
    push_tree
    echo "✓ pushed to $slug_"
  fi
}

cmd_up() {
  need jq
  need rsync
  local slug_ row cport sport db fresh=""
  [ "${1:-}" = "--fresh" ] && fresh="fresh"
  slug_="$(slug)"

  provision_box

  echo "→ shared tier"
  ssh_box "$REMOTE/bin/env-shared.sh"

  echo "→ allocating environment '$slug_'"
  row="$(ssh_box "$REMOTE/bin/env-registry.sh alloc '$slug_' '$(owner)'")" || exit $?
  cport="$(printf '%s' "$row" | jq -r .consolePort)"
  sport="$(printf '%s' "$row" | jq -r .storagePort)"
  db="$(printf '%s' "$row" | jq -r .database)"

  echo "→ pushing working tree"
  push_tree
  mint_env "$slug_" "$cport" "$sport" "$db"

  ssh_box "$REMOTE/bin/env-mode.sh '$slug_' '$cport' '$sport' '$db' '$fresh'"
  ssh_box "$REMOTE/bin/env-registry.sh touch '$slug_'"
}

# Write the env's .env — MINTED ON THE BOX, never copied from yours.
#
# Your .env carries live Stripe / SES / OAuth / Anthropic keys. Copying it onto a box
# that gets snapshotted, deleted and recreated would quietly turn a dev sandbox into
# an exfiltration surface. This writes the minimal set that boots the console far
# enough to authenticate, with freshly generated secrets, so nothing on the box can
# reach a real environment.
#
# Note what is DELIBERATELY ABSENT: ALETHIA_SES_REGION. With no SES region,
# getEmailConfig() returns ses:null and sendEmail LOGS the message instead of sending
# it (packages/email/src/{config,send}.ts) — so the sign-in code appears in
# `pnpm env:logs`. That is how a branch env signs in with zero copied credentials.
#
# Note what is DELIBERATELY PRESENT, and why each is GENERATED here rather than copied:
#
#   ALETHIA_OIDC_SIGNING_KEY  — the workload-identity issuer key. oidcIssuerConfigured()
#     (lib/oidc/issuer.ts) is a bare presence check on this one variable, and it gates
#     the ENTIRE managed-cloud connector surface: without it computePlatformConfigured()
#     reports aws/gcp/azure/alibaba as "not enabled on this instance", /api/oidc/jwks and
#     the discovery doc 404, and every /api/runners/<cloud>-token route returns 501. A
#     sandbox that cannot connect a cloud cannot exercise the product. Generated, never
#     copied: the hosted issuer's key must not exist on a box that gets snapshotted, and
#     each env being its own issuer is correct — a cloud trust is pinned to an issuer URL.
#   ALETHIA_RECEIPT_SIGNING_KEY — without it packages/core/verify emits receipts with
#     algorithm:"none" (verify/signing.go), so a deploy "succeeds" while producing
#     evidence that proves nothing. Unsigned evidence is the failure mode this key exists
#     to prevent, so a dev env should not be quietly exempt from it.
#   ALETHIA_SNAPSHOT_HMAC_KEY — config_snapshot integrity (lib/runners/snapshot-sig.ts).
#   ALETHIA_RUNNER_BOOTSTRAP_TOKEN — minting it here removes a two-pass dance: without
#     it the first `pnpm env:runner` generates one, appends it to this file, tells you to
#     restart the console and exits WITHOUT starting a runner (scripts/dev-runner.sh).
#
# Written once per env: re-minting BETTER_AUTH_SECRET would invalidate every live
# session on that env, including one you are in the middle of using. The same
# write-once rule is what makes the OIDC key safe across `env:up` — re-minting it would
# break every cloud trust already pinned to this issuer, and Entra caches the JWKS for
# ~24h so the breakage would outlive the fix. A reap-and-recreate DOES re-mint: reconnect
# the connectors, or stash this file before `pnpm env:reap`.
mint_env() {
  local slug_="$1" cport="$2" sport="$3" db="$4" fqdn url
  fqdn="$(env_fqdn "$slug_" "$cport")"
  url="https://$fqdn"

  local secret1 secret2 secret3 secret4 oidc_key receipt_key snapshot_key bootstrap_token
  secret1="$(openssl rand -hex 32)"
  secret2="$(openssl rand -hex 32)"
  secret3="$(openssl rand -hex 32)"
  secret4="$(openssl rand -hex 16)"
  # base64(PKCS8 RSA-2048 PEM) on ONE line — mirrors rsa_b64() in scripts/bootstrap-secrets.sh.
  oidc_key="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | openssl base64 -A)"
  # base64 of the RAW 64-byte ed25519 private key (seed||public) — the shape Go's
  # ed25519.PrivateKey and verify.SigningKeyFromEnv expect, NOT a PEM. openssl has no
  # raw-ed25519 export, but the trailing 32 bytes of the PKCS8 DER are the seed and the
  # trailing 32 of the SPKI DER are the public key, both fixed-length for ed25519.
  # Mirrors ed25519_raw_b64() in scripts/bootstrap-secrets.sh.
  receipt_key="$(ed25519_raw_b64)"
  snapshot_key="$(openssl rand -base64 32)"
  bootstrap_token="$(openssl rand -hex 32)"

  # shellcheck disable=SC2029
  ssh_box "test -f $REMOTE/envs/$slug_/.env || cat > $REMOTE/envs/$slug_/.env" <<ENV
# Minted by scripts/env.sh for the '$slug_' environment. Not copied from any laptop.
ALETHIA_DATABASE_URL=postgres://alethia:alethia-dev-secret@localhost:5433/$db
ALETHIA_APP_DATABASE_URL=postgres://alethia_app:$secret4@localhost:5433/$db
ALETHIA_APP_DB_PASSWORD=$secret4
ALETHIA_DB_USER=alethia
ALETHIA_DB_NAME=$db
ALETHIA_DB_PORT=5433

ALETHIA_STORAGE_ENDPOINT=http://localhost:$sport
ALETHIA_STORAGE_REGION=us-east-1
ALETHIA_STORAGE_ACCESS_KEY_ID=alethia
ALETHIA_STORAGE_SECRET_ACCESS_KEY=alethia-dev-secret
ALETHIA_STORAGE_AUTO_CREATE_BUCKETS=true

NEXT_PUBLIC_APP_URL=$url
BETTER_AUTH_URL=$url
ALETHIA_WEB_ORIGIN=$url
BETTER_AUTH_SECRET=$secret1
CLI_JWT_SECRET=$secret2
ALETHIA_CRED_ENCRYPTION_KEY=$secret3

ALETHIA_OIDC_SIGNING_KEY=$oidc_key
ALETHIA_RECEIPT_SIGNING_KEY=$receipt_key
ALETHIA_SNAPSHOT_HMAC_KEY=$snapshot_key
ALETHIA_RUNNER_BOOTSTRAP_TOKEN=$bootstrap_token

OPENFGA_API_URL=http://localhost:8082
ALETHIA_DEPLOYMENT_MODE=hosted
ALETHIA_LICENSE_ACTIVE=false
ALETHIA_RUNNER_OPERATOR=self
PORT=$cport
ENV
}

cmd_down() {
  local slug_
  slug_="$(slug)"
  ssh_box "tmux kill-session -t 'alethia-$slug_' 2>/dev/null || true
           docker rm -f 'alethia-seaweed-$slug_' >/dev/null 2>&1 || true
           $REMOTE/bin/env-registry.sh release '$slug_'
           $REMOTE/bin/env-tunnel.sh >/dev/null 2>&1 || true"
  echo "✓ released '$slug_' (its database is kept — env:up --fresh drops it)"
}

cmd_status() {
  need jq
  local ip domain
  ip="$(box_ip)"
  if [ -z "$ip" ] || ! hc server describe "$SERVER_NAME" >/dev/null 2>&1; then
    echo "box:  down (reaped or never created) — pnpm env:box"
    return 0
  fi
  domain="$(env_domain)"

  local type created
  type="$(hc server describe "$SERVER_NAME" -o json 2>/dev/null | jq -r '.server_type.name // "?"')"
  created="$(hc server describe "$SERVER_NAME" -o json 2>/dev/null | jq -r '.created // empty')"
  echo "box:  up   $ip   $type   since ${created:-?}"
  echo "envs: (cap from infra/sandbox env_cap)"
  ssh_box "$REMOTE/bin/env-registry.sh list" |
    jq -r --arg d "$domain" 'to_entries[] |
      "  \(.key)\n    url    https://\(if .key == "dev" then $d else "env" + (((.value.consolePort - 3000) / 100) | tostring) + "-" + $d end)\n    ports  console :\(.value.consolePort)  storage :\(.value.storagePort)\n    owner  \(.value.owner)   last seen \(.value.lastSeen)"'
  cat <<'NOTE'

  Sign-in: OAuth redirect URIs cannot be wildcarded, so social sign-in and the Stripe
  test webhook only work on the PRIMARY env. Branch envs are email-OTP only — the code
  is printed in `pnpm env:logs`, because no SES credential is copied to the box.
NOTE
}

cmd_logs() { ssh_box "tail -n 200 -f /var/log/alethia-$(slug).log"; }

cmd_open() {
  local domain slug_ url
  slug_="$(slug)"
  cport="$(ssh_box "$REMOTE/bin/env-registry.sh list" | jq -r --arg s "$slug_" '.[$s].consolePort // empty')"
  [ -n "$cport" ] || die "no environment for '$slug_' — run: pnpm env:up"
  url="https://$(env_fqdn "$slug_" "$cport")"
  echo "$url"
  command -v open >/dev/null 2>&1 && open "$url"
}

cmd_ssh() {
  local ip
  ip="$(require_box)"
  echo "→ $SERVER_NAME  ($ip).  Attach to an env:  tmux attach -t alethia-<slug>"
  ssh -o StrictHostKeyChecking=accept-new -t "root@$ip" "cd $REMOTE/envs/$(slug) 2>/dev/null; exec bash -l"
}

# Worktrees are de-hydrated (no node_modules), so the checks that used to run locally
# run here. The box already has the install warm from env:up.
cmd_check() {
  local slug_
  slug_="$(slug)"
  push_tree
  ssh_box "cd $REMOTE/envs/$slug_ && pnpm install --frozen-lockfile >/dev/null && \
           pnpm -F console check-types && pnpm -F console lint && pnpm -F console test"
}

# Browser tests, on the box. This is what the box is FOR — the Mac cannot run them.
#
# WHY ON THE BOX AND NOT FROM HERE, pointed at the tunnel: sign-in scrapes the one-time
# code out of the console's stdout (apps/console/e2e/helpers/otp.ts reads DEV_CONSOLE_LOG
# as a LOCAL file). That log only exists on the box, at /var/log/alethia-<slug>.log. No
# amount of pointing E2E_BASE_URL at the public URL fixes that — the Playwright process
# has to be able to read the file, so it has to be the same machine.
#
# The recipe mirrors the one CI already proves (.github/workflows/ci.yml, e2e-browser):
# install -> migrate -> browsers -> non-vacuity guard -> run -> collect artifacts. The box
# already has the first two warm from env:up.
cmd_test() {
  need jq
  local slug_ cport domain fqdn proj=""
  slug_="$(slug)"

  cport="$(ssh_box "$REMOTE/bin/env-registry.sh list" | jq -r --arg s "$slug_" '.[$s].consolePort // empty')"
  [ -n "$cport" ] || die "no environment for '$slug_' — run: pnpm env:up"
  fqdn="$(env_fqdn "$slug_" "$cport")"

  # Default to the project CI gates on. Anything else is opt-in and named.
  proj="${1:---project=hero}"

  push_tree

  # `playwright install --with-deps` needs root apt for ~16 shared libs (libnss3, libgbm1,
  # libasound2t64 ...) that cloud-init does not carry. We ssh as root, so this just works;
  # browsers cache in ~/.cache/ms-playwright, which the snapshot preserves, so it is a
  # first-run cost only.
  #
  # CI is deliberately UNSET: playwright.config.ts sets `reuseExistingServer: !isCI`, so
  # CI=1 would make Playwright boot its OWN server and fight the running env for the port.
  #
  # E2E_BASE_URL is the HTTPS tunnel URL, not localhost: the minted .env sets
  # BETTER_AUTH_URL to that hostname and Better Auth trusts only that origin, so a plain
  # http://localhost origin is rejected before any test can sign in.
  #
  # The --list guard is CI's: a testMatch drift that matches zero tests otherwise "passes".
  echo "→ browser tests for '$slug_' on the box  ($proj → https://$fqdn)"
  ssh_box "set -e
    cd $REMOTE/envs/$slug_
    pnpm install --frozen-lockfile >/dev/null
    pnpm -F console exec playwright install --with-deps chromium >/dev/null
    export DEV_CONSOLE_LOG=/var/log/alethia-$slug_.log
    export E2E_BASE_URL=https://$fqdn
    unset CI
    list=\$(pnpm -F console exec playwright test $proj --list 2>&1) || { echo \"\$list\"; exit 1; }
    echo \"\$list\" | grep -qE 'Total: [1-9][0-9]* test' || {
      echo '✗ that project matched 0 tests — testMatch drift, not a pass.' >&2; exit 1; }
    pnpm -F console exec playwright test $proj" || {
    echo "" >&2
    echo "✗ tests failed — pulling the report and traces back anyway." >&2
    fetch_artifacts "$slug_"
    restart_env_console "$slug_"
    exit 1
  }

  fetch_artifacts "$slug_"
  restart_env_console "$slug_"
}

# A dev-mode Next server that has served a Playwright run does not give the memory back.
# Measured on the box: an env sat at ~3 GB RSS before its first browser run and ~9 GB
# afterwards, and stayed there — while NODE_OPTIONS=--max-old-space-size=3072 was applied
# the whole time. The heap cap bounds V8's old space, not Turbopack's native memory or its
# workers, so it does not bound RSS at all.
#
# On a shared box that difference is three usable slots versus one, and it is the reason a
# smaller box could not host the very tests it exists to run. Restarting the console after
# a run costs one Next cold start and returns ~6 GB.
restart_env_console() { # <slug>
  local slug_="$1" before after row cport sport db
  before="$(ssh_box "ps -eo rss,args | grep -F 'envs/$slug_' | grep -v grep | awk '{s+=\$1} END {print int(s/1024)}'" 2>/dev/null || echo "")"
  row="$(ssh_box "$REMOTE/bin/env-registry.sh list" 2>/dev/null | jq -c --arg s "$slug_" '.[$s] // empty')"
  [ -n "$row" ] || return 0
  cport="$(printf '%s' "$row" | jq -r .consolePort)"
  sport="$(printf '%s' "$row" | jq -r .storagePort)"
  db="$(printf '%s' "$row" | jq -r .database)"

  ssh_box "tmux kill-session -t 'alethia-$slug_' 2>/dev/null || true
           $REMOTE/bin/env-mode.sh '$slug_' '$cport' '$sport' '$db'" >/dev/null 2>&1 || {
    echo "  ⚠ console did not come back — pnpm env:up to restore it" >&2
    return 0
  }
  after="$(ssh_box "ps -eo rss,args | grep -F 'envs/$slug_' | grep -v grep | awk '{s+=\$1} END {print int(s/1024)}'" 2>/dev/null || echo "")"
  if [ -n "$before" ] && [ -n "$after" ]; then
    echo "  console restarted — ${before}MB → ${after}MB"
  else
    echo "  console restarted"
  fi
}

# Bring the report, screenshots and traces back. env.sh had no reverse path at all, so the
# only way to see a failure was to ssh in and read files by hand — which is exactly when
# you least want to. push_tree excludes both directories, so --delete never wipes them.
fetch_artifacts() { # <slug>
  local ip slug_="$1"
  ip="$(require_box)"
  mkdir -p "$ROOT/apps/console"
  rsync -az -e "ssh -o StrictHostKeyChecking=accept-new" \
    "root@$ip:$REMOTE/envs/$slug_/apps/console/playwright-report/" \
    "$ROOT/apps/console/playwright-report/" 2>/dev/null || true
  rsync -az -e "ssh -o StrictHostKeyChecking=accept-new" \
    "root@$ip:$REMOTE/envs/$slug_/apps/console/test-results/" \
    "$ROOT/apps/console/test-results/" 2>/dev/null || true
  echo "  report:  apps/console/playwright-report/index.html"
  echo "  traces:  apps/console/test-results/"

  # Snapshot storage is billed per GB and the box is snapshotted on every reap, so old
  # traces and 4K stills would quietly inflate the bill. Nothing else prunes them.
  ssh_box "find $REMOTE/envs/$slug_/apps/console/test-results -maxdepth 1 -mtime +3 -exec rm -rf {} + 2>/dev/null || true"
}

cmd_runner() {
  local slug_ cport
  slug_="$(slug)"
  cport="$(ssh_box "$REMOTE/bin/env-registry.sh list" | jq -r --arg s "$slug_" '.[$s].consolePort // empty')"
  [ -n "$cport" ] || die "no environment for '$slug_' — run: pnpm env:up"
  # MODE defaults to native. The box builds for its own architecture, and a runner IMAGE
  # BUILT here must never be mistaken for a fleet image — an arch mismatch is what churned
  # ~100 VMs in 8 hours once already. That argument is about building, not about running,
  # so MODE/CRED/RUNNERS/SLOTS/PROVIDERS are forwarded rather than pinned: MODE=docker with
  # a PULLED, already-published image is a legitimate way to run the shipped artifact
  # against this console. Never `REBUILD=1` here.
  #
  # CRED is load-bearing beyond credentials: dev-runner.sh derives the runner's OPERATOR
  # from it (bootstrap → managed, self → self), and the keyless AWS and GCP federation
  # branches only run when operator=managed. Leave it at bootstrap to exercise keyless.
  ssh_box "cd $REMOTE/envs/$slug_ && \
    MODE='${MODE:-native}' CRED='${CRED:-bootstrap}' RUNNERS='${RUNNERS:-1}' \
    ${SLOTS:+SLOTS='$SLOTS'} ${PROVIDERS:+PROVIDERS='$PROVIDERS'} ${RUNNER_IMAGE:+RUNNER_IMAGE='$RUNNER_IMAGE'} \
    ALETHIA_WEB_ORIGIN=http://localhost:$cport bash scripts/dev-runner.sh"
}

cmd_reap() {
  require_main_checkout "env:reap"
  need jq
  local idle now=""
  [ "${1:-}" = "--now" ] && now=1
  box_exists || {
    echo "box already down — nothing billing but the IP (EUR 0.50/mo) and the snapshot."
    return 0
  }
  refuse_if_others_are_working
  idle="$(ssh_box "$REMOTE/bin/env-registry.sh idle-minutes")"

  # --now is "I am finished for the day". The idle threshold assumes several people whose
  # runs must not be reaped out from under them; with one user it mostly means the box is
  # NEVER reaped — and an unreaped box is the entire cost problem, because Hetzner bills a
  # server for as long as it EXISTS, running or not.
  if [ -z "$now" ] && [ "$idle" -lt "$REAP_AFTER_MIN" ]; then
    echo "not reaping: most recent activity was ${idle}m ago (threshold ${REAP_AFTER_MIN}m)."
    echo "  Finished for the day?  pnpm env:reap --now"
    return 0
  fi
  if [ -n "$now" ] && [ "$idle" -lt 30 ]; then
    echo "⚠ --now, but something was active ${idle}m ago. Reaping anyway; a run in flight will die."
  fi

  # Snapshot storage is billed per GB, so what is on disk when you reap is what you pay
  # to keep. env:test prunes old traces for this reason.
  echo "→ snapshotting before delete (last activity ${idle}m ago)"
  hc server create-image --type snapshot \
    --description "alethia-sandbox $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --label "$SNAPSHOT_LABEL" "$SERVER_NAME" ||
    die "snapshot failed — NOT deleting the box."

  # Prune AFTER the new snapshot succeeded, never before: old snapshots deleted ahead of
  # a snapshot that then fails is how you lose the box's state entirely.
  #
  # Nothing pruned these before, and cmd_reap makes one every time. At ~20GB and
  # EUR 0.0143/GB, 30 reaps is EUR 8.58/mo — more than the cpx32 box the reaping exists to
  # save money on. The saving leaked straight back out.
  local keep="${ALETHIA_SNAPSHOT_KEEP:-2}" stale
  stale="$(hc image list -t snapshot -l "$SNAPSHOT_LABEL" -o json 2>/dev/null |
    jq -r --argjson k "$keep" 'sort_by(.created) | reverse | .[$k:] | .[].id' || true)"
  if [ -n "$stale" ]; then
    echo "→ pruning $(printf '%s\n' "$stale" | grep -c .) old snapshot(s), keeping $keep"
    printf '%s\n' "$stale" | while read -r id; do
      [ -n "$id" ] && hc image delete "$id" >/dev/null 2>&1 || true
    done
  fi

  # Only the server is destroyed. The tunnel, the DNS records and the Primary IP stay, so
  # env:box brings the same hostnames back ON THE SAME ADDRESS.
  # -auto-approve: see the note above cmd_box. The gates that matter ran already.
  tofu -chdir="$TF_DIR" destroy -input=false -auto-approve -target=hcloud_server.sandbox
  echo "✓ reaped — the server meter has stopped. Still billing: the Primary IP"
  echo "  (EUR 0.50/mo, which is what keeps the address stable) and the snapshot."
  echo "  Restore with: pnpm env:box   (~1-2 min, SAME address; hostnames error until then)"
}

# `pnpm env:timer` — run env:reap on a schedule, so an idle box cannot survive the night.
#
# Deliberately runs reap WITHOUT --now: the script already does all the deciding, and it
# is safe unattended for a reason worth stating. refuse_if_others_are_working only counts
# envs touched in the last 60 minutes, and REAP_AFTER_MIN is 90 — so by the time a box is
# reapable, nothing can still be blocking it. The two thresholds cannot deadlock as long
# as REAP_AFTER_MIN stays above 60, which cmd_timer asserts below rather than trusting.
#
# A run that fires too early prints "not reaping" and exits 0. That is the common case and
# it must stay cheap and silent.
cmd_timer() {
  case "${1:-on}" in
  status)
    if [ -f "$LAUNCH_PLIST" ]; then
      echo "installed: $LAUNCH_PLIST"
      # Capture, then match — do NOT pipe into `grep -q`. grep exits on the first match
      # and closes the pipe, launchctl takes SIGPIPE, and `set -o pipefail` reports the
      # pipeline as FAILED even though the match succeeded. It is timing-dependent, so
      # it passes in a quick test and then lies in the field: this reported "loaded: NO"
      # about a timer that was demonstrably loaded and had already run.
      local loaded=""
      loaded="$(launchctl list 2>/dev/null || true)"
      case "$loaded" in
      *"$LAUNCH_LABEL"*) echo "loaded:    yes (every $((REAP_EVERY_SEC / 60))m)" ;;
      *) echo "loaded:    NO — pnpm env:timer to reload" ;;
      esac
      echo "log:       $REAP_TIMER_LOG"
      [ -s "$REAP_TIMER_LOG" ] && {
        echo "last runs:"
        tail -5 "$REAP_TIMER_LOG" | sed 's/^/  /'
      }
    else
      echo "not installed — an idle box will bill until someone remembers."
      echo "  pnpm env:timer"
    fi
    return 0
    ;;
  off)
    launchctl unload "$LAUNCH_PLIST" 2>/dev/null || true
    rm -f "$LAUNCH_PLIST"
    echo "✓ timer removed. Nothing reaps the box now — pnpm env:reap --now by hand."
    return 0
    ;;
  on | "") ;;
  *) die "usage: pnpm env:timer [on|off|status]" ;;
  esac

  # A deadlock here is silent and expensive: the box would simply never be reaped.
  [ "$REAP_AFTER_MIN" -gt 60 ] ||
    die "REAP_AFTER_MIN is ${REAP_AFTER_MIN}m but refuse_if_others_are_working blocks on
  activity in the last 60m — the timer could never reap. Raise it above 60."

  # launchd does NOT give a job your shell's PATH; it gets /usr/bin:/bin:/usr/sbin:/sbin,
  # where none of these live. Resolve them now and embed the real directories, so the
  # failure is at install time and visible rather than at 3am in a log nobody reads.
  local paths="" p d
  for p in hcloud tofu jq ssh rsync; do
    d="$(command -v "$p" 2>/dev/null)" || die "$p is required by env:reap but not on PATH."
    d="$(dirname "$d")"
    case ":$paths:" in *":$d:"*) ;; *) paths="${paths:+$paths:}$d" ;; esac
  done
  paths="$paths:/usr/bin:/bin:/usr/sbin:/sbin"

  case "$MAIN_CHECKOUT$paths" in
  *'<'* | *'&'*) die "path contains XML metacharacters; refusing to write a broken plist." ;;
  esac

  mkdir -p "$(dirname "$LAUNCH_PLIST")"
  cat >"$LAUNCH_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCH_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$MAIN_CHECKOUT/scripts/env.sh</string>
    <string>reap</string>
  </array>
  <!-- require_main_checkout refuses to write OpenTofu state from anywhere else. -->
  <key>WorkingDirectory</key><string>$MAIN_CHECKOUT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$paths</string></dict>
  <key>StartInterval</key><integer>$REAP_EVERY_SEC</integer>
  <!-- Also on login: a laptop shut mid-session is exactly when a box gets forgotten. -->
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$REAP_TIMER_LOG</string>
  <key>StandardErrorPath</key><string>$REAP_TIMER_LOG</string>
</dict>
</plist>
PLIST

  launchctl unload "$LAUNCH_PLIST" 2>/dev/null || true
  launchctl load "$LAUNCH_PLIST" || die "launchctl load failed — see $LAUNCH_PLIST"

  echo "✓ timer installed — env:reap runs every $((REAP_EVERY_SEC / 60))m and reaps the box"
  echo "  once it has been idle ${REAP_AFTER_MIN}m. An early run prints 'not reaping' and exits."
  echo "  log:     $REAP_TIMER_LOG          status:  pnpm env:timer status"
  echo "  remove:  pnpm env:timer off"
  echo ""
  echo "  This does NOT replace pnpm env:reap --now when you finish for the day — it only"
  echo "  guarantees a forgotten box dies within ${REAP_AFTER_MIN}m rather than billing all month."
}

case "${1:-}" in
box)
  shift || true
  cmd_box "$@"
  ;;
up)
  shift || true
  cmd_up "$@"
  ;;
push)
  shift || true
  cmd_push "$@"
  ;;
down) cmd_down ;;
status) cmd_status ;;
logs) cmd_logs ;;
open) cmd_open ;;
ssh) cmd_ssh ;;
check) cmd_check ;;
test)
  shift || true
  cmd_test "$@"
  ;;
runner) cmd_runner ;;
reap)
  shift || true
  cmd_reap "$@"
  ;;
timer)
  shift || true
  cmd_timer "$@"
  ;;
*)
  sed -n '5,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
