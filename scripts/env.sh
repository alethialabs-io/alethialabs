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
#   env:runner  a provisioning runner pointed at this env
#   env:reap    snapshot + DELETE the box if everything is idle
#   env:box     create/restore the box  (runs tofu apply — a human action)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TF_DIR="$ROOT/infra/sandbox"
SERVER_NAME="alethia-sandbox"
SNAPSHOT_LABEL="role=sandbox"
REMOTE=/opt/alethia
# Idle minutes before env:reap will snapshot-and-delete. Generous on purpose: the
# restore path costs 1-2 minutes and a box reaped out from under a long test run is
# far more expensive than a few idle euros.
REAP_AFTER_MIN="${ALETHIA_REAP_AFTER_MIN:-180}"

die() {
  echo "✗ $*" >&2
  exit 1
}

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."; }

# ── Identity ──────────────────────────────────────────────────────────────────────
# The slug is the branch name with the feat/ prefix stripped and anything that is not
# a DNS label flattened — it becomes a hostname, a database name and a tmux session.
slug() {
  local b
  b="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo dev)"
  b="${b#feat/}"
  b="${b#fix/}"
  b="$(printf '%s' "$b" | tr '[:upper:]/_' '[:lower:]--' | tr -cd 'a-z0-9-' | cut -c1-40)"
  b="${b%-}"
  printf '%s' "${b:-dev}"
}

owner() { printf '%s@%s' "$(id -un)" "$(hostname -s)"; }

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
  [ -n "$(box_ip)" ] && hcloud server describe "$SERVER_NAME" >/dev/null 2>&1
}

require_box() {
  local ip
  ip="$(box_ip)"
  if [ -z "$ip" ] || ! hcloud server describe "$SERVER_NAME" >/dev/null 2>&1; then
    cat >&2 <<MSG
✗ The sandbox box is not up.

  It was either never created, or env:reap snapshotted and deleted it (which is the
  normal idle state — a stopped Hetzner server still bills, a deleted one does not).

  Bring it back with:   pnpm env:box

  That runs \`tofu apply\` in infra/sandbox. Creating cloud infrastructure is a human
  action in this repo, so it is deliberately not folded into env:up.
MSG
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
  avail="$(hcloud server-type list -o json 2>/dev/null |
    jq -r --arg w "$want" '.[] | select(.name == $w) | .name' || true)"
  [ -n "$avail" ] || return 0

  # `hcloud datacenter describe` carries the authoritative per-DC availability list.
  local dc ok
  dc="$(hcloud datacenter list -o json 2>/dev/null | jq -r --arg l "$loc" '.[] | select(.name | startswith($l)) | .name' | head -1)"
  [ -n "$dc" ] || return 0
  ok="$(hcloud datacenter describe "$dc" -o json 2>/dev/null |
    jq -r --arg w "$want" --slurpfile st <(hcloud server-type list -o json) \
      '[.server_types.available[]] as $a | ($st[0][] | select(.name==$w) | .id) as $id | if ($a | index($id)) then "yes" else "no" end' 2>/dev/null || echo yes)"

  if [ "$ok" = "no" ]; then
    echo "⚠ $want is OUT OF STOCK in $loc right now." >&2
    echo "  Available there with >=16 GB:" >&2
    hcloud datacenter describe "$dc" -o json 2>/dev/null |
      jq -r --slurpfile st <(hcloud server-type list -o json) \
        '[.server_types.available[]] as $a | $st[0][] | select(.id as $i | $a | index($i)) | select(.memory >= 16) | "    \(.name)  \(.cores)c \(.memory)GB \(.disk)GB \(.architecture)"' 2>/dev/null >&2 || true
    echo "  Set server_type in $TF_DIR/terraform.tfvars and retry." >&2
    echo >&2
  fi
}

# ── Commands ──────────────────────────────────────────────────────────────────────

cmd_box() {
  need tofu
  [ -f "$TF_DIR/terraform.tfvars" ] ||
    die "no $TF_DIR/terraform.tfvars — copy terraform.tfvars.example and fill it in."

  preflight_capacity

  # Restore from the newest snapshot if one exists, so a reaped box comes back with
  # its seeded databases and warm node_modules rather than empty.
  local snap=""
  if command -v hcloud >/dev/null 2>&1; then
    snap="$(hcloud image list -t snapshot -l "$SNAPSHOT_LABEL" -o json 2>/dev/null |
      jq -r 'sort_by(.created) | last | .id // empty' || true)"
  fi

  if [ -n "$snap" ]; then
    echo "→ restoring from snapshot $snap"
    tofu -chdir="$TF_DIR" apply -var "image=$snap"
  else
    tofu -chdir="$TF_DIR" apply
  fi

  provision_box
  echo "✓ box up at $(box_ip)"
}

# Push the box-side scripts, the pinned shared compose file and the tunnel
# credentials. Runs on every env:up so changing a box script never means rebuilding.
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
    "$ROOT/scripts/box/" "root@$ip:$REMOTE/bin/"
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
# Written once per env: re-minting BETTER_AUTH_SECRET would invalidate every live
# session on that env, including one you are in the middle of using.
mint_env() {
  local slug_="$1" cport="$2" sport="$3" db="$4" fqdn url
  local domain
  domain="$(tofu -chdir="$TF_DIR" output -raw env_domain 2>/dev/null || echo dev.alethialabs.io)"
  if [ "$slug_" = "dev" ]; then fqdn="$domain"; else fqdn="$slug_.$domain"; fi
  url="https://$fqdn"

  local secret1 secret2 secret3 secret4
  secret1="$(openssl rand -hex 32)"
  secret2="$(openssl rand -hex 32)"
  secret3="$(openssl rand -hex 32)"
  secret4="$(openssl rand -hex 16)"

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
  if [ -z "$ip" ] || ! hcloud server describe "$SERVER_NAME" >/dev/null 2>&1; then
    echo "box:  down (reaped or never created) — pnpm env:box"
    return 0
  fi
  domain="$(tofu -chdir="$TF_DIR" output -raw env_domain 2>/dev/null || echo '?')"

  local type created
  type="$(hcloud server describe "$SERVER_NAME" -o json 2>/dev/null | jq -r '.server_type.name // "?"')"
  created="$(hcloud server describe "$SERVER_NAME" -o json 2>/dev/null | jq -r '.created // empty')"
  echo "box:  up   $ip   $type   since ${created:-?}"
  echo "envs: (cap from infra/sandbox env_cap)"
  ssh_box "$REMOTE/bin/env-registry.sh list" |
    jq -r --arg d "$domain" 'to_entries[] |
      "  \(.key)\n    url    https://\(if .key == "dev" then $d else .key + "." + $d end)\n    ports  console :\(.value.consolePort)  storage :\(.value.storagePort)\n    owner  \(.value.owner)   last seen \(.value.lastSeen)"'
  cat <<'NOTE'

  Sign-in: OAuth redirect URIs cannot be wildcarded, so social sign-in and the Stripe
  test webhook only work on the PRIMARY env. Branch envs are email-OTP only — the code
  is printed in `pnpm env:logs`, because no SES credential is copied to the box.
NOTE
}

cmd_logs() { ssh_box "tail -n 200 -f /var/log/alethia-$(slug).log"; }

cmd_open() {
  local domain slug_ url
  domain="$(tofu -chdir="$TF_DIR" output -raw env_domain 2>/dev/null || echo dev.alethialabs.io)"
  slug_="$(slug)"
  if [ "$slug_" = "dev" ]; then url="https://$domain"; else url="https://$slug_.$domain"; fi
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

cmd_runner() {
  local slug_ cport
  slug_="$(slug)"
  cport="$(ssh_box "$REMOTE/bin/env-registry.sh list" | jq -r --arg s "$slug_" '.[$s].consolePort // empty')"
  [ -n "$cport" ] || die "no environment for '$slug_' — run: pnpm env:up"
  # MODE=native, never docker. The box builds for its own architecture, and a runner
  # IMAGE built here must never be mistaken for a fleet image — an arch mismatch is
  # what churned ~100 VMs in 8 hours once already.
  ssh_box "cd $REMOTE/envs/$slug_ && MODE=native ALETHIA_WEB_ORIGIN=http://localhost:$cport bash scripts/dev-runner.sh"
}

cmd_reap() {
  need jq
  local idle
  box_exists || {
    echo "box already down."
    return 0
  }
  idle="$(ssh_box "$REMOTE/bin/env-registry.sh idle-minutes")"
  if [ "$idle" -lt "$REAP_AFTER_MIN" ]; then
    echo "not reaping: most recent activity was ${idle}m ago (threshold ${REAP_AFTER_MIN}m)."
    return 0
  fi

  echo "→ snapshotting before delete (everything idle ${idle}m)"
  hcloud server create-image --type snapshot \
    --description "alethia-sandbox $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --label "$SNAPSHOT_LABEL" "$SERVER_NAME" ||
    die "snapshot failed — NOT deleting the box."

  # Only the server is destroyed. The tunnel and DNS records stay, so env:box brings
  # the same hostnames back. While it is down, they return Cloudflare error 1033.
  tofu -chdir="$TF_DIR" destroy -target=hcloud_server.sandbox
  echo "✓ reaped. Restore with: pnpm env:box   (~1-2 min; hostnames 1033 until then)"
}

case "${1:-}" in
box) cmd_box ;;
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
runner) cmd_runner ;;
reap) cmd_reap ;;
*)
  sed -n '5,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
