#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs ON the box. Brings ONE branch environment up.
#
#   env-mode.sh <slug> <consolePort> <storagePort> <database> [fresh] [empty|seed|keep]
#
# Deliberately outside cloud-init: `env:up` rsyncs it every time, so changing how an
# env boots never means rebuilding a box.
#
# Environments are PEERS, not tenants. Each gets its own tree (/opt/alethia/envs/<slug>),
# its own database, its own OpenFGA store, its own SeaweedFS container and its own
# console port — but they SHARE one Postgres and one OpenFGA, because those isolate
# logically and a container set per env would spend the box's 16 GB on nothing.
#
# SeaweedFS is the exception and it is not a style choice: bucket names are hardcoded
# constants in the app (apps/console/lib/storage/plan-artifact.ts:9 "plan-artifacts",
# tofu-state.ts:15 "project-tofu-state") with no env-driven prefix, so one shared
# SeaweedFS would collide OpenTofu STATE between branches. Per-env container it is.
set -euo pipefail

# ── Should this boot seed demo data? ──────────────────────────────────────────────
#
# A branch env came up EMPTY until 2026-09-01: every list page rendered its empty state,
# so a UI audit measured an empty product and nobody manually checking a branch env had
# ever seen a populated page. `seed:demo` already existed and was never wired in.
#
# Seeded is therefore the DEFAULT, and `--empty` is the deliberate opt-out — the empty
# state is itself a thing the console has to render correctly, so an env that can only be
# seeded proves half the contract.
#
# The choice is REMEMBERED, in /opt/alethia/envs/.seed-mode-<slug>, and both halves of
# that matter:
#
#   · Without it, `env:up --empty` followed by any later plain `env:up` (to restart the
#     console after a push, say) would silently populate the env the audit is measuring
#     as empty. The flag would appear to work and then stop working, with no message.
#   · Marking a seeded env as seeded is what stops every subsequent `env:up` from tearing
#     the demo org down and rebuilding it — `seed:demo` refreshes rather than appends, so
#     a re-seed would discard whatever you had done inside that org since. `--seed` asks
#     for that refresh explicitly; `--fresh` implies it, because it drops the database.
#
# The file lives NEXT TO the env directory, not inside it: push_tree rsyncs with
# --delete, so a marker inside /opt/alethia/envs/<slug>/ would be deleted on the next
# `env:push` — the same trap that .env is excluded to avoid. It deliberately survives
# `env:down`, which keeps the database; releasing a slot must not silently re-seed.
#
# Not every caller is an `env:up`. `restore_live_envs` and `restart_env_console` in
# scripts/env.sh hand an environment back exactly as they found it, and they run against
# environments this session does not own — the shared `dev` integration env and whatever
# branch env another instance holds. They pass `keep`, which neither seeds nor RECORDS.
# Recording matters as much as not seeding: a restart that wrote `empty` into an unmarked
# env would stop that env's owner from ever getting a seeded one from a plain `env:up`.
#
# Decision only — no I/O — so the matrix below can be exercised with `--self-test`
# anywhere, including on the mac. Echoes: "<yes|no|reset> <mode-to-record> <why>", where
# `reset` means "tear the demo org down" and a recorded mode of `keep` means "record
# nothing".
seed_decision() { # <requested: ''|empty|seed|keep> <recorded: ''|empty|demo> <fresh: ''|fresh>
  local req="$1" rec="$2" fresh="$3"
  case "$req" in
  keep)
    echo "no keep a restart never seeds and never records"
    return 0
    ;;
  empty)
    # Skipping the seeder is NOT how you empty an already-seeded env: the teardown lives
    # INSIDE seed:demo, so a skip leaves every demo row in the database while the boot
    # banner announces EMPTY — this issue's own defect with the sign flipped. `--fresh`
    # is the one case that needs no teardown, because it dropped the database outright.
    if [ "$rec" = "demo" ] && [ "$fresh" != "fresh" ]; then
      echo "reset empty --empty on a seeded env tears the demo org down"
    else
      echo "no empty --empty was passed"
    fi
    return 0
    ;;
  seed)
    echo "yes demo --seed was passed"
    return 0
    ;;
  esac
  case "$rec" in
  empty) echo "no empty this env was brought up --empty" ;;
  demo)
    if [ "$fresh" = "fresh" ]; then
      echo "yes demo --fresh dropped the database"
    else
      echo "no demo already seeded — pnpm env:up --seed refreshes it"
    fi
    ;;
  *) echo "yes demo this env has never been seeded" ;;
  esac
}

# ── Which EDITION is the running console actually serving? ───────────────────────
#
# An env boots, serves, and looks completely healthy while resolving COMMUNITY
# entitlements. Nothing prints, nothing 500s: a `team`/`active` subscription row is read
# correctly and the API still answers `invite-member` with 403, because the paid
# `organizations` entitlement is not there to grant. Every "I verified it on a branch env"
# claim about an enterprise-scoped surface is then a claim about the community build
# (#3732). So the boot SAYS which one it got, the way ci.yml's `Guard — ee/dist must exist`
# step does for CI.
#
# THE DISCRIMINATOR, measured on the box on 2026-09-01 in both directions — the same env,
# one `pnpm -F @alethia/ee build` apart, nothing else changed:
#
#   POST /api/auth/organization/create   with an empty JSON body, no session
#     404  — Next has no such route          ⇒ the organization plugin is NOT registered
#     400  — better-auth's own body validation ⇒ it IS registered
#
# It needs no account and writes nothing: validation refuses the empty body long before
# any row is created. `organization/list` answers 404 either way and is NOT a
# discriminator — that was the first probe tried here, and it reported "community" against
# an enterprise console.
#
# WHAT IT PROVES, exactly. It measures whether `getEnterprise()` loaded @alethia/ee, which
# is the SAME seam entitlements come through: lib/enterprise.ts registers the auth plugins
# and `resolveEntitlements` from one load, so plugin-absent ⇔ ee-absent ⇔ community
# entitlements. It is not itself an entitlement assertion — `pnpm env:test` is where a
# paid call gets made — but it cannot be green while the entitlement seam is community.
#
# Decision only, no I/O, so `--self-test` can exercise it anywhere.
# Echoes "<verdict> <why>"; verdict is enterprise | community | DEFECT | unknown.
scope_verdict() { # <http status of the probe> <ALETHIA_EDITION as seen by the console>
  local code="$1" edition="$2"
  case "$code" in
  000 | "" | 5??)
    echo "unknown the console did not answer the probe (status ${code:-none})"
    ;;
  404)
    # A pinned community edition is a legitimate thing to run — it is how the community
    # build gets exercised at all. Unpinned and community is the silent defect.
    if [ "$edition" = "community" ]; then
      echo "community ALETHIA_EDITION=community is pinned for this env"
    else
      echo "DEFECT the organization plugin is absent — this console resolves COMMUNITY entitlements"
    fi
    ;;
  *)
    echo "enterprise the organization plugin is registered"
    ;;
  esac
}

if [ "${1:-}" = "--self-test" ]; then
  pass=0
  fail=0
  expect() { # <case> <requested> <recorded> <fresh> <expected>
    local got
    got="$(seed_decision "$2" "$3" "$4")"
    # The WHY is prose and will be reworded; the verdict and the recorded mode are the
    # contract, so assert those two fields and let the third drift.
    got="$(printf '%s' "$got" | cut -d' ' -f1,2)"
    if [ "$got" = "$5" ]; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      echo "  ✗ $1: expected '$5', got '$got'"
    fi
  }
  expect "a new env seeds"                    ""      ""      ""      "yes demo"
  expect "a seeded env is not re-seeded"      ""      "demo"  ""      "no demo"
  expect "--fresh re-seeds (db was dropped)"  ""      "demo"  "fresh" "yes demo"
  expect "--empty stays empty across ups"     ""      "empty" ""      "no empty"
  expect "--empty stays empty under --fresh"  ""      "empty" "fresh" "no empty"
  expect "--seed refreshes a seeded env"      "seed"  "demo"  ""      "yes demo"
  expect "--seed re-populates an empty env"   "seed"  "empty" ""      "yes demo"
  expect "--empty wins on a brand new env"    "empty" ""      ""      "no empty"
  # --empty has to EMPTY, not merely decline to seed. The teardown lives inside seed:demo,
  # so on a recorded-`demo` env the only honest answer is `reset`; --fresh already dropped
  # the database, which is why the pair below must disagree.
  expect "--empty tears a seeded env down"    "empty" "demo"  ""      "reset empty"
  expect "--empty --fresh needs no teardown"  "empty" "demo"  "fresh" "no empty"
  expect "--empty on an empty env is a no-op" "empty" "empty" ""      "no empty"
  # A restart is not an env:up: it must not seed, and must not record a mode either.
  expect "a restart of an unmarked env"       "keep"  ""      ""      "no keep"
  expect "a restart of a seeded env"          "keep"  "demo"  ""      "no keep"
  expect "a restart of an empty env"          "keep"  "empty" ""      "no keep"

  # scope_verdict — the #3732 half. Only the verdict is the contract; the why is prose.
  scope() { # <case> <http status> <edition> <expected verdict>
    local got
    got="$(scope_verdict "$2" "$3" | cut -d' ' -f1)"
    if [ "$got" = "$4" ]; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      echo "  ✗ $1: expected '$4', got '$got'"
    fi
  }
  # 400 is better-auth validating an empty body, which only a REGISTERED plugin does.
  scope "400 = the org plugin answered"        400 ""          "enterprise"
  scope "…and edition is irrelevant when it did" 400 "community" "enterprise"
  # Anything else in the 2xx/4xx range still means a route exists — only 404 means absent.
  scope "401 still means the route exists"     401 ""          "enterprise"
  # 404 = Next has no such route = no organization plugin = community entitlements.
  scope "404 unpinned is the silent defect"    404 ""          "DEFECT"
  scope "404 with auto is the silent defect"   404 "auto"      "DEFECT"
  scope "404 with enterprise is worse, not ok" 404 "enterprise" "DEFECT"
  # …unless community was asked for, which is how the community build gets exercised.
  scope "404 pinned community is deliberate"   404 "community" "community"
  # A console that cannot answer must not be reported either way. `000` is curl's
  # "no response", and an empty string is what a failed capture actually yields — the two
  # differ, so both are asserted rather than assumed to be the same case.
  scope "no answer is not a verdict"           000 ""          "unknown"
  scope "an empty status is not a verdict"     ""  ""          "unknown"
  scope "a 500 is not a community verdict"     503 ""          "unknown"
  echo "  ${pass} passed, ${fail} failed"
  [ "$fail" -eq 0 ]
  exit
fi

SLUG="${1:?slug}"
CPORT="${2:?console port}"
SPORT="${3:?storage port}"
DB="${4:?database}"
FRESH="${5:-}"
SEED_REQUEST="${6:-}"

# shellcheck disable=SC1091
[ -f /opt/alethia/box.env ] && . /opt/alethia/box.env
DOMAIN="${ALETHIA_ENV_DOMAIN:?ALETHIA_ENV_DOMAIN missing from /opt/alethia/box.env}"

REPO="/opt/alethia/envs/$SLUG"
LOG="/var/log/alethia-$SLUG.log"
SESSION="alethia-$SLUG"
SEAWEED="alethia-seaweed-$SLUG"
SHARED_COMPOSE=(docker compose -f /opt/alethia/shared/docker-compose.yml)
# The hostname belongs to the SLOT, not the branch — the same mapping env_fqdn() applies
# in scripts/env.sh, derived from the console port the registry allocated:
# 3100 -> env1-, 3200 -> env2-. `dev` keeps the bare domain (OAuth redirect URIs and the
# Stripe webhook are registered against exactly that name and cannot be wildcarded).
#
# This built "$SLUG.$DOMAIN" until 2026-07-30. That is TWO labels deep, outside
# Cloudflare's Universal SSL, and once the `*.dev` wildcard was removed it stopped
# resolving at all — so `env:up` finished by printing a URL that no longer existed, which
# is worse than printing nothing. The minted .env was always correct; only this line lied.
#
# It survived the slot-hostname change because it is a SECOND, independent construction of
# the same hostname: that change updated env.sh and env-tunnel.sh and claimed env_fqdn was
# the only place a hostname is built. Grep before believing that kind of claim.
if [ "$SLUG" = "dev" ]; then
  FQDN="$DOMAIN"
else
  FQDN="env$(((CPORT - 3000) / 100))-$DOMAIN"
fi
URL="https://$FQDN"

cd "$REPO"
export PATH="$PATH:/usr/local/go/bin"

# HERE, and not next to the `tmux new` that needs it — see the long note there. The tmux
# SERVER captures the environment of whatever process happens to start it and hands a copy
# to every session it ever creates, so it must be born now, while this script's environment
# is still the one ssh gave it, and not after the migration step below exports this env's
# entire .env into it (#3732). Idempotent: a server that is already running is left alone,
# which is exactly why the scrub down there is also needed.
tmux start-server 2>/dev/null || true

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

psql_su() { "${SHARED_COMPOSE[@]}" exec -T postgres psql -U alethia -v ON_ERROR_STOP=1 "$@"; }

# ── Database ─────────────────────────────────────────────────────────────────────
if [ "$FRESH" = "fresh" ]; then
  log "--fresh: dropping database $DB"
  # WITH (FORCE) so a leftover `next dev` connection cannot hold the drop hostage;
  # the point of --fresh is that it always works.
  psql_su -d alethia -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)"
fi

if [ "$(psql_su -d alethia -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | tr -d '[:space:]')" != "1" ]; then
  log "Creating database $DB"
  psql_su -d alethia -c "CREATE DATABASE \"$DB\" OWNER alethia"
fi

# ── Per-env object storage ───────────────────────────────────────────────────────
# Bound to loopback like the shared tier. `-ip.bind=0.0.0.0` is the container's own
# interface binding (the healthcheck needs it); the published port is still local.
if ! docker ps --format '{{.Names}}' | grep -qx "$SEAWEED"; then
  log "Starting SeaweedFS for $SLUG on :$SPORT"
  docker rm -f "$SEAWEED" >/dev/null 2>&1 || true
  docker run -d --name "$SEAWEED" --restart unless-stopped \
    -p "127.0.0.1:$SPORT:8333" \
    -v "alethia-seaweed-$SLUG:/data" \
    -v "$REPO/deploy/seaweedfs/s3.json:/etc/seaweedfs/s3.json:ro" \
    --memory 512m \
    chrislusf/seaweedfs:latest \
    server -dir=/data -s3 -s3.config=/etc/seaweedfs/s3.json \
    -master.volumeSizeLimitMB=1024 -ip.bind=0.0.0.0 >/dev/null
fi

# ── Dependencies ─────────────────────────────────────────────────────────────────
log "Installing dependencies"
pnpm install --frozen-lockfile

# @alethia/ee ships as a workspace package whose dist a fresh tree links but never
# builds; without it loadEnterprise()'s tolerant require throws MODULE_NOT_FOUND,
# getAuthPlugins() returns [], /api/auth/organization/* 404s, and lib/auth/scope.ts falls
# back to `{ orgId: userId }` with COMMUNITY_ENTITLEMENTS. Same reasoning as
# scripts/dev-up.sh:116 and the two `Build @alethia/ee` steps in ci.yml.
#
# UNCONDITIONAL, where this used to build only `if [ ! -f ee/dist/index.js ]` (#3732).
# ee/dist is gitignored, so it is never in a pushed tree, and push_tree rsyncs with
# --delete: EVERY `pnpm env:push` removed it from a live env. The old guard was therefore
# not "build it once" but "build it on every env:up and leave it deleted after every
# env:push" — and a `next dev` server re-evaluates lib/enterprise.ts on its next recompile,
# so the console silently dropped to community scope with no restart and no message.
# env.sh now rebuilds after each push too; this is the boot half of the same rule.
#
# It is also the only thing that keeps dist in step with ee/src: a conditional build makes
# an edited ee/src/*.ts invisible for as long as an old dist happens to be lying there.
# esbuild bundles one entry point in about a second, so there is nothing to save.
if [ -f ee/package.json ]; then
  log "Building @alethia/ee"
  pnpm -F @alethia/ee build
  # Asserted, not assumed. A build that fails under `set -e` stops here anyway, but a build
  # that "succeeds" while writing nothing would hand back an env that boots, serves, looks
  # healthy, and answers every enterprise-scoped question with the community answer — which
  # is precisely the failure this file is being changed to make impossible.
  [ -f ee/dist/index.js ] || {
    echo "✗ ee/dist/index.js is missing after building @alethia/ee." >&2
    echo "  Refusing to start: the console would resolve COMMUNITY entitlements, so every" >&2
    echo "  enterprise-scoped check against this env would pass or fail for the wrong reason." >&2
    exit 1
  }
fi

# ── Schema ───────────────────────────────────────────────────────────────────────
log "Migrating $DB"
set -a
# shellcheck disable=SC1091
. "$REPO/.env"
set +a
pnpm -C apps/console db:migrate

# ── Demo data ────────────────────────────────────────────────────────────────────
#
# BEFORE the console starts, not after, and that ordering is load-bearing: the FGA
# backfill runs once per app instance at boot (instrumentation.ts -> tuple-sync), so
# rows written now are mirrored into this env's store by the very next line that starts
# the dev server. Seeding a running console would leave the tuples until the next
# restart.
#
# `seed:demo` (apps/console/scripts/seed-demo.ts) writes DB rows the real UI renders —
# keyless connectors, designed projects + canvas, PLAN/DEPLOY jobs carrying real verify
# reports and signed receipts, evidence, day-2 posture and a runner fleet. There is no
# demo-mode branch in the app; the console is simply looking at data.
SEED_MODE_FILE="/opt/alethia/envs/.seed-mode-$SLUG"
SEED_LOG="/var/log/alethia-$SLUG-seed.log"
SEED_RECORDED="$(cat "$SEED_MODE_FILE" 2>/dev/null || true)"
read -r SEED_DO SEED_RECORD SEED_WHY <<<"$(seed_decision "$SEED_REQUEST" "$SEED_RECORDED" "$FRESH")"

case "$SEED_DO" in
yes)
  log "Seeding demo data ($SEED_WHY)"
  # `set -euo pipefail` is on, so pipefail makes this `if` test the SEEDER's status, not
  # tee's — a pipe otherwise launders the exit code and a failed seed would read as a
  # successful one, which is this issue's own failure mode in a new disguise.
  if ! pnpm -F console seed:demo 2>&1 | tee "$SEED_LOG"; then
    echo "✗ demo seed failed — full output in $SEED_LOG" >&2
    echo "  This is fatal on purpose: an env:up that promises a populated env and quietly" >&2
    echo "  delivers an empty one is the defect this step exists to fix. To bring the env" >&2
    echo "  up without demo data:  pnpm env:up --empty" >&2
    exit 1
  fi
  ;;
reset)
  # No `--slug`: the seed above passes none either, so both halves act on seed-demo.ts's
  # default demo org. Passing $SLUG here would name a DIFFERENT org (the env's slug is not
  # the demo org's) and tear down nothing while reporting success.
  #
  # seed-demo.ts refuses to tear down an org that holds projects and is not demo-marked,
  # so this cannot eat hand-made work in an org this mechanism never seeded.
  log "Emptying the demo org ($SEED_WHY)"
  if ! pnpm -F console seed:demo --reset --reset-only 2>&1 | tee "$SEED_LOG"; then
    echo "✗ demo teardown failed — full output in $SEED_LOG" >&2
    echo "  Fatal on purpose: this boot would otherwise print 'seed: EMPTY' over a" >&2
    echo "  database that still holds the demo org, which is the defect --empty exists" >&2
    echo "  to avoid. To empty it by dropping the database instead:" >&2
    echo "     pnpm env:up --empty --fresh" >&2
    exit 1
  fi
  ;;
*)
  log "Not seeding demo data ($SEED_WHY)"
  ;;
esac

# `keep` records NOTHING (see seed_decision): a restart that wrote a mode would decide the
# seed mode of an env whose owner never asked for one.
if [ "$SEED_RECORD" = "keep" ]; then
  SEED_EFFECTIVE="$SEED_RECORDED"
else
  printf '%s\n' "$SEED_RECORD" >"$SEED_MODE_FILE"
  SEED_EFFECTIVE="$SEED_RECORD"
fi

# Which account holds the data. Read back from the seeder's OWN output rather than
# hardcoded here, because a second copy of that address would decay silently the day the
# demo persona changes — and signing in as anyone else lands you in an empty personal org,
# which looks exactly like the seed having failed.
SEED_LOGIN=""
case "$SEED_EFFECTIVE" in
demo)
  SEED_LOGIN="$(sed -n 's/^ *login *//p' "$SEED_LOG" 2>/dev/null | head -1 || true)"
  SEED_NOTE="demo data — ${SEED_LOGIN:-see $SEED_LOG}"
  ;;
empty)
  SEED_NOTE="EMPTY — no demo data (pnpm env:up --seed populates it)"
  ;;
*)
  # A restart of an env that predates the marker. This boot neither seeded nor emptied it
  # and has no way to know what is in it; printing EMPTY here would be the same lie the
  # `reset` branch above exists to stop.
  SEED_NOTE="unknown — no mode recorded (pnpm env:up --seed populates it, --empty empties it)"
  ;;
esac

# ── OpenFGA store (one per env, on the shared server) ────────────────────────────
# Mirrors scripts/dev-up.sh:132-158. The app writes the model + tuples into the store
# on boot (instrumentation.ts -> tuple-sync backfill); this only has to make it exist.
STORE_ID="$(grep -E '^OPENFGA_STORE_ID=' apps/console/.env.local 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [ -n "$STORE_ID" ] && curl -fs "http://localhost:8082/stores/$STORE_ID" >/dev/null 2>&1; then
  log "Reusing OpenFGA store $STORE_ID"
else
  log "Creating OpenFGA store for $SLUG"
  RESP="$(curl -fsS -X POST http://localhost:8082/stores \
    -H 'content-type: application/json' -d "{\"name\":\"alethia-$SLUG\"}")"
  STORE_ID="$(printf '%s' "$RESP" | jq -r '.id')"
  [ -n "$STORE_ID" ] && [ "$STORE_ID" != "null" ] || {
    echo "✗ could not create OpenFGA store. Response: $RESP" >&2
    exit 1
  }
  printf 'OPENFGA_API_URL=http://localhost:8082\nOPENFGA_STORE_ID=%s\n' "$STORE_ID" >apps/console/.env.local
  echo "  created store $STORE_ID"
fi
/opt/alethia/bin/env-registry.sh store "$SLUG" "$STORE_ID"

# ── Compile freshness (#2812) ─────────────────────────────────────────────────────
#
# THE FAILURE. `.next` is excluded from the rsync, so this box keeps its own compile cache across
# pushes. A stale cache serves the PREVIOUS module while `env:push` and `env:up` both report
# success. An aria-label fix once sat invisible across two restarts; it was only caught because
# someone happened to be reading childNodes and expected something specific. A vaguer check —
# "does the page look right" — would have passed. And it cuts both ways: a stale build makes a
# FIXED thing still look broken, and a BROKEN thing still look fixed.
#
# This box is the only place anything visual can be verified. CI proves a change parses,
# type-checks and resolves its imports; it proves nothing about rendering. So a browser silently
# showing a previous bundle is a hole underneath the last line of defence.
#
# WHY PREVENTION AND NOT A PROBE. The obvious fix is to bake an id into the bundle and compare it
# after boot. It does not work, and the reason is worth writing down so nobody rebuilds it: the id
# would have to arrive via NEXT_PUBLIC_* (inlined at compile time), Next invalidates its cache when
# an env file changes, so the id and the cache move together and the probe passes by construction —
# including when a COMPONENT is stale, which is the actual reported failure. A check that cannot
# fail is worse than none: it would have signed off the very bug it was written for.
#
# So: key on the SOURCE TREE. If what was pushed differs from what was compiled, drop the compile
# cache. Unchanged restarts stay fast; a changed tree always gets a real compile.
#
# Metadata, not content: rsync updates size and mtime on every file it replaces, so path+size+mtime
# moves whenever a file arrives. Hashing bytes would cost seconds per boot to answer the same
# question. `sort` because find's order is not stable across runs.
# PATHS ARE RELATIVE AND MTIMES ARE WHOLE SECONDS, on both sides. The laptop computes the same
# hash (env.sh → tree_stamp) and the two are compared by `pnpm env:verify`; an absolute path or a
# sub-second float would differ between the two machines for reasons that have nothing to do with
# the code, and the check would cry wolf on every run. rsync -a preserves size and mtime, so a
# file that arrived unchanged hashes the same on both.
TREE_STAMP_FILE="$REPO/.next-tree-stamp"
TREE_STAMP="$(cd "$REPO" && find apps packages -type f \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.json' -o -name '*.mjs' \) \
  -not -path '*/node_modules/*' -not -path '*/.next/*' -printf '%p %s %T@\n' 2>/dev/null |
  awk '{printf "%s %s %d\n", $1, $2, $3}' | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"
if [ "$TREE_STAMP" != "$(cat "$TREE_STAMP_FILE" 2>/dev/null || true)" ]; then
  log "Source changed since the last boot — dropping the compile cache"
  rm -rf "$REPO/apps/console/.next"
  printf '%s\n' "$TREE_STAMP" >"$TREE_STAMP_FILE"
else
  log "Source unchanged since the last boot — keeping the compile cache"
fi

# Surfaced on /api/health?shallow=1 so the loop is closed at the other end too: `pnpm env:status`
# prints the tree the served page was compiled from, and it is the same hash env.sh computes for
# YOUR working tree. Equal means the page in your browser is the tree on your disk.
touch apps/console/.env.local
grep -v '^NEXT_PUBLIC_ALETHIA_BUILD_ID=' apps/console/.env.local >apps/console/.env.local.tmp || true
printf 'NEXT_PUBLIC_ALETHIA_BUILD_ID=%s\n' "$TREE_STAMP" >>apps/console/.env.local.tmp
mv apps/console/.env.local.tmp apps/console/.env.local

# ── Tunnel ───────────────────────────────────────────────────────────────────────
log "Cloudflare tunnel"
/opt/alethia/bin/env-tunnel.sh

# ── The dev server ───────────────────────────────────────────────────────────────
# tmux, not systemd: an environment is something you attach to and watch.
# `tmux attach -t alethia-<slug>` after an ssh gives you that branch's dev server log,
# which is most of why you would be on this box at all. One session per environment,
# so restarting yours never touches anyone else's.
#
# NODE_OPTIONS caps the heap: nothing in either repo compose file declares a limit,
# and on a shared box one runaway Turbopack compile OOM-kills its neighbours.
log "Starting console on :$CPORT"
tmux kill-session -t "$SESSION" 2>/dev/null || true

# ── ONE ENV'S .env MUST NOT REACH ANOTHER ENV'S CONSOLE ──────────────────────────
#
# This is the second half of #3732, and it is the half that made the first half look
# unfixable: rebuilding @alethia/ee and restarting the console changed nothing, because the
# console was not failing to LOAD ee — it was never trying. `ALETHIA_EDITION=community` was
# in its environment, and loadEnterprise() returns null on that before it reaches the
# require at all.
#
# Where it came from. The migration step above sources $REPO/.env under `set -a`, which
# EXPORTS every one of that env's variables into this script's own shell and leaves them
# there (the seeder below needs them). `tmux new` then starts the tmux SERVER if none is
# running — and the server captures the environment of whatever process started it, and
# hands a copy to every session created afterwards, for as long as it lives.
#
# So the FIRST env booted after a box comes up writes its entire .env into the tmux server,
# and every env booted after that inherits it. Variables the second env's own .env re-sets
# are overwritten by the `set -a && . .env` in its session command and are fine; the ones it
# does NOT set are silently the first env's. Measured on the box on 2026-09-01: the tmux
# global environment held demo-ladder's database URL, its BETTER_AUTH_URL, its signing keys
# and its hand-added ALETHIA_EDITION=community — and env2's console, whose own .env names no
# edition, booted community and stayed community across every rebuild and restart.
#
# Two measures, because prevention alone cannot heal a server that is already carrying it:
#
#   · `tmux start-server` runs at the TOP of this script, before the .env is sourced, so a
#     server born on this boot is born from an environment that holds no env's .env.
#   · this scrub removes what a server born on an EARLIER boot already holds — including one
#     started before this change shipped. The key set is DERIVED
#     from the .env files themselves — the union of what any env can leak — rather than
#     hand-listed, because a hand-written list of variables to scrub stops covering the day
#     someone adds one and says nothing.
for _k in $(cat /opt/alethia/envs/*/.env 2>/dev/null |
  grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' | tr -d '=' | LC_ALL=C sort -u); do
  tmux set-environment -gu "$_k" 2>/dev/null || true
done
unset _k

tmux new -d -s "$SESSION" \
  "cd $REPO && set -a && . $REPO/.env && set +a && \
   PORT=$CPORT NODE_OPTIONS=--max-old-space-size=3072 \
   pnpm -C apps/console dev 2>&1 | tee $LOG"

log "Waiting for :$CPORT"
for _ in $(seq 1 150); do
  if curl -fsS -o /dev/null "http://localhost:$CPORT/api/health" 2>/dev/null ||
    curl -fsS -o /dev/null "http://localhost:$CPORT/login" 2>/dev/null; then
    echo
    echo "  ✓ $SLUG is up   $URL"
    # The tree the SERVED page was compiled from. Compare it to what env.sh prints for your
    # working tree: equal means the browser is showing the code on your disk. This is reported
    # rather than asserted here, because the assertion belongs where the two trees can both be
    # seen — on the laptop, in env.sh.
    echo "    tree:  $TREE_STAMP"
    echo "    seed:  $SEED_NOTE"

    # WHICH EDITION IS ANSWERING (#3732) — see scope_verdict above for the probe and what
    # it does and does not prove. Printed on every boot, because the whole failure mode is
    # that nothing printed: the env came up, served, and looked healthy while every
    # enterprise-scoped question got the community answer.
    #
    # The probe runs against the console THAT JUST ANSWERED, on loopback, so it reports what
    # this boot actually got rather than what the files on disk imply it should have got.
    # ee/dist existing is the precondition; this is the outcome, and the two came apart for
    # a fortnight.
    # Retried, because the readiness loop above breaks as soon as /login answers and this is
    # a DIFFERENT route: `next dev` compiles a route on its first request, so a single
    # attempt can time out on the compile and report "unknown" against a perfectly good env.
    # A cold /api/auth/* compile was measured at ~4s here; the budget is deliberately much
    # larger than that, and giving up still reports `unknown` rather than a verdict.
    SCOPE_CODE=000
    for _ in 1 2 3; do
      SCOPE_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
        -X POST -H 'content-type: application/json' -d '{}' \
        "http://localhost:$CPORT/api/auth/organization/create" 2>/dev/null || echo 000)"
      [ "$SCOPE_CODE" != "000" ] && break
      sleep 3
    done
    SCOPE_EDITION="$(grep -E '^ALETHIA_EDITION=' "$REPO/.env" 2>/dev/null | cut -d= -f2- || true)"
    read -r SCOPE_VERDICT SCOPE_WHY <<<"$(scope_verdict "$SCOPE_CODE" "$SCOPE_EDITION")"
    case "$SCOPE_VERDICT" in
    enterprise) echo "    scope: enterprise — $SCOPE_WHY" ;;
    community) echo "    scope: community (deliberate) — $SCOPE_WHY" ;;
    unknown) echo "    scope: UNKNOWN — $SCOPE_WHY" ;;
    *)
      # FATAL, and this is the point of the change. An env that resolves community
      # entitlements while nobody asked it to is not a working env with a caveat — it is an
      # env on which every enterprise-scoped verification is vacuous, and it looks identical
      # to a good one. Same call CI's `Guard — ee/dist must exist` step makes.
      echo "" >&2
      echo "✗ $SLUG came up in COMMUNITY scope — $SCOPE_WHY" >&2
      echo "  A team/active subscription row on this env will still be refused with" >&2
      echo "  403 upgrade_required, because the paid 'organizations' entitlement is not" >&2
      echo "  there to grant. Any enterprise-scoped check against it would be vacuous." >&2
      echo "" >&2
      echo "  ee/dist/index.js: $( [ -f "$REPO/ee/dist/index.js" ] && echo present || echo MISSING)" >&2
      echo "  ALETHIA_EDITION in this env's .env: ${SCOPE_EDITION:-unset (= auto)}" >&2
      echo "  ALETHIA_EDITION in the tmux server env: $(tmux show-environment -g ALETHIA_EDITION 2>/dev/null || echo 'not set')" >&2
      echo "  Bring it up again (pnpm env:up); if it recurs, tmux kill-server on the box." >&2
      exit 1
      ;;
    esac

    echo "    logs:  pnpm env:logs        (sign-in codes are printed here)"
    exit 0
  fi
  sleep 2
done

echo "✗ $SLUG did not answer on :$CPORT within 5 min — check: tmux attach -t $SESSION" >&2
exit 1
