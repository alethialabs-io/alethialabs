#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs ON the box. Owns /opt/alethia/envs.json — the per-branch environment registry.
#
#   env-registry.sh alloc   <slug> <owner>   # existing env, or a new port set + database
#   env-registry.sh touch   <slug>           # bump lastSeen (what keeps env:reap away)
#   env-registry.sh store   <slug> <id>      # record this env's OpenFGA store id
#   env-registry.sh release <slug>           # give the ports and the row back
#   env-registry.sh list                     # the raw JSON
#   env-registry.sh idle-minutes             # minutes since the most recent lastSeen,
#                                            # or `none` / `unknown` when there isn't one
#
# WHY THIS LIVES ON THE BOX rather than in scripts/env.sh: the registry is state
# SHARED between laptops and between concurrent Claude sessions, so the
# read-modify-write has to be serialised where the file is. `flock` on a sibling
# lockfile does that. Doing the same arithmetic client-side would let two `env:up`s a
# second apart read the same JSON and both pick :3100 — which is exactly the class of
# bug the repo's /tmp dir-locks exist to prevent locally.
#
# Writes are tmp+rename so a reader never sees a half-written file, which is why
# `list` can skip the lock.
set -euo pipefail

# ALETHIA_BOX_ROOT is overridable ONLY so the allocation logic can be exercised off
# the box (`env-registry.sh --self-test`). Port arithmetic under a lock is the part
# most likely to be subtly wrong and the most painful to debug over SSH, so it gets
# a test that runs anywhere. In production this is always /opt/alethia.
BOX_ROOT="${ALETHIA_BOX_ROOT:-/opt/alethia}"
REG="$BOX_ROOT/envs.json"
LOCK="$BOX_ROOT/envs.lock"

# shellcheck disable=SC1091
[ -f "$BOX_ROOT/box.env" ] && . "$BOX_ROOT/box.env"

# The cap is a memory budget, not a policy: each `next dev` holds ~2 GB, so on a 16 GB
# box the fourth environment is the one that starts swapping and turns every timing
# assertion into a coin flip. Set from tofu's env_cap via cloud-init.
CAP="${ALETHIA_ENV_CAP:-3}"

# Console ports and storage (SeaweedFS S3) ports are allocated in lockstep, one pair
# per env. Six slots so `env_cap` can be raised on a bigger box without touching this.
CONSOLE_POOL=(3100 3200 3300 3400 3500 3600)
STORAGE_POOL=(8341 8342 8343 8344 8345 8346)

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

lock() {
  if ! command -v flock >/dev/null 2>&1; then
    # flock is Linux-only and this script's whole purpose is serialising a
    # read-modify-write, so a missing flock must NEVER degrade to "carry on
    # unlocked" — that would reintroduce the exact double-allocation this file
    # exists to prevent. The single-threaded self-test is the one allowed
    # exception, and it is identified by having relocated the registry.
    if [ -n "${ALETHIA_BOX_ROOT:-}" ]; then return 0; fi
    echo "✗ flock is required to serialise registry writes and is not installed." >&2
    exit 5
  fi
  exec 9>"$LOCK"
  flock 9
}

ensure() { [ -s "$REG" ] || echo '{}' >"$REG"; }

# stdin -> registry, atomically.
save() {
  cat >"$REG.tmp"
  mv "$REG.tmp" "$REG"
}

cmd_alloc() {
  local slug="$1" owner="$2" cport sport count db i
  lock
  ensure

  cport="$(jq -r --arg s "$slug" '.[$s].consolePort // empty' "$REG")"
  if [ -n "$cport" ]; then
    # Idempotent: an env:up on a branch that already has one is a refresh, never a
    # second allocation. This is what makes env:up safe to run repeatedly.
    jq --arg s "$slug" --arg o "$owner" --arg n "$(now)" \
      '.[$s].owner = $o | .[$s].lastSeen = $n' "$REG" | save
    jq -c --arg s "$slug" '.[$s] + {slug: $s, created: false}' "$REG"
    return 0
  fi

  count="$(jq 'length' "$REG")"
  if [ "$count" -ge "$CAP" ]; then
    # Nothing is evicted automatically. A silent swap on a shared box means someone
    # else's 40-minute run dies with no message — the cap refuses instead, and names
    # who to ask.
    {
      echo "The box is full: $count/$CAP environments, and none of them are yours."
      echo
      jq -r 'to_entries[] | "  \(.key)\tconsole :\(.value.consolePort)\t\(.value.owner)\tlast seen \(.value.lastSeen)"' "$REG"
      echo
      echo "Nothing is evicted automatically. Ask a holder to run  pnpm env:down,"
      echo "or raise env_cap in infra/sandbox if the box has the memory for it."
    } >&2
    exit 3
  fi

  for i in "${!CONSOLE_POOL[@]}"; do
    local c="${CONSOLE_POOL[$i]}"
    if [ "$(jq --argjson p "$c" 'any(.[]; .consolePort == $p)' "$REG")" = "false" ]; then
      cport="$c"
      sport="${STORAGE_POOL[$i]}"
      break
    fi
  done
  [ -n "$cport" ] || {
    echo "no free port pair despite $count/$CAP rows — registry is inconsistent" >&2
    exit 4
  }

  # Postgres identifiers take underscores, DNS labels take hyphens; the slug is the
  # hyphen form and this is its one translation point.
  db="alethia_${slug//-/_}"
  jq --arg s "$slug" --argjson c "$cport" --argjson p "$sport" --arg d "$db" \
    --arg o "$owner" --arg n "$(now)" \
    '.[$s] = {consolePort: $c, storagePort: $p, database: $d, storeId: "", owner: $o, createdAt: $n, lastSeen: $n}' \
    "$REG" | save
  jq -c --arg s "$slug" '.[$s] + {slug: $s, created: true}' "$REG"
}

cmd_touch() {
  local slug="$1"
  lock
  ensure
  jq --arg s "$slug" --arg n "$(now)" \
    'if has($s) then .[$s].lastSeen = $n else . end' "$REG" | save
}

cmd_store() {
  local slug="$1" id="$2"
  lock
  ensure
  jq --arg s "$slug" --arg i "$id" \
    'if has($s) then .[$s].storeId = $i else . end' "$REG" | save
}

cmd_release() {
  local slug="$1"
  lock
  ensure
  jq --arg s "$slug" 'del(.[$s])' "$REG" | save
}

# An ISO-8601 Zulu stamp as epoch seconds, or nothing at all if it will not parse.
#
# Two dialects because this has to answer the same way in both places it is asked. The box is
# Linux (`date -d`); `env:reap --dry-run` runs this very function against a fixture registry on
# a Mac (`date -j -f`). Answering only on the box is how the empty-registry branch below went
# months without being exercised — its self-test skipped itself on the machine it was written on.
parse_iso_utc() { # <iso-8601 Zulu> → epoch seconds on stdout, or nothing
  date -u -d "$1" +%s 2>/dev/null ||
    date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null ||
    true
}

# How long the box has been idle — what env:reap thresholds on.
#
# The answer is EITHER a count of minutes OR a word naming an absence, and the words are the
# point. This used to answer the no-rows case with `999999`, a sentinel for "no data" written
# in the units of a quantity — and scripts/env.sh compared it against the 90-minute threshold.
# 999999 is not less than 90, so a box holding no env rows read as maximally idle and the
# unattended timer deleted it on its FIRST tick, whatever was running on it. That happened on
# 2026-09-02 to a host carrying a Go toolchain, ~25 minutes old (#3922).
#
# The branch below already stated the rule the sentinel broke: absence must not read as "idle
# forever", because that reaps a box someone is using. Both branches answer "I cannot tell how
# long this has been idle"; they now answer it the same way.
#
# An absence is therefore no longer a number, which is the property that makes the class of bug
# impossible rather than merely fixed: a caller that compares this answer as a duration now
# fails loudly instead of silently reaping.
#
#   none      the registry parsed and holds no rows. Nothing has ever been measured, so there
#             is no idle age — NOT "idle since the beginning of time". A box with no env row
#             can be doing real work; compiling out of a scratch directory takes no env slot.
#   unknown   a lastSeen exists but this box cannot parse it.
#   <N>       minutes since the most recent lastSeen.
cmd_idle_minutes() {
  ensure
  local latest then_s now_s
  latest="$(jq -r '[.[].lastSeen] | max // empty' "$REG")"
  if [ -z "$latest" ]; then
    echo none
    return 0
  fi
  then_s="$(parse_iso_utc "$latest")"
  if [ -z "$then_s" ]; then
    echo unknown
    return 0
  fi
  now_s="$(date -u +%s)"
  echo $(((now_s - then_s) / 60))
}

# ── Self-test ─────────────────────────────────────────────────────────────────────
# Runs entirely in a tempdir; touches no real registry, and skips nothing: `parse_iso_utc`
# reads both date dialects so the idle-minutes cases assert on a Mac as well as on the box.
self_test() {
  local tmp pass=0 fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  export ALETHIA_BOX_ROOT="$tmp"
  export ALETHIA_ENV_CAP=3
  local me="${BASH_SOURCE[0]}"

  check() {
    if [ "$2" = "$3" ]; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      echo "  ✗ $1: expected '$3', got '$2'"
    fi
  }

  # First alloc takes the first slot of BOTH pools, in lockstep.
  local a
  a="$(bash "$me" alloc alpha me@host)"
  check "alpha console port" "$(jq -r .consolePort <<<"$a")" "3100"
  check "alpha storage port" "$(jq -r .storagePort <<<"$a")" "8341"
  check "alpha database" "$(jq -r .database <<<"$a")" "alethia_alpha"
  check "alpha is new" "$(jq -r .created <<<"$a")" "true"

  # A hyphenated slug must translate to underscores for Postgres but stay hyphenated
  # for DNS — this is the one translation point and it has been wrong before.
  local b
  b="$(bash "$me" alloc cache-engine-aws me@host)"
  check "second console port" "$(jq -r .consolePort <<<"$b")" "3200"
  check "hyphen -> underscore" "$(jq -r .database <<<"$b")" "alethia_cache_engine_aws"

  # Re-alloc is a refresh, NOT a second allocation — this is what makes env:up safe
  # to run repeatedly.
  local again
  again="$(bash "$me" alloc alpha someone@else)"
  check "realloc same port" "$(jq -r .consolePort <<<"$again")" "3100"
  check "realloc not created" "$(jq -r .created <<<"$again")" "false"
  check "realloc rebinds owner" "$(jq -r .owner <<<"$again")" "someone@else"
  check "still 2 rows" "$(bash "$me" list | jq 'length')" "2"

  # The cap refuses rather than evicting.
  bash "$me" alloc gamma me@host >/dev/null
  local rc=0
  bash "$me" alloc delta me@host >/dev/null 2>&1 || rc=$?
  check "4th alloc refused at cap 3" "$rc" "3"

  # Release frees the port for reuse, and the freed slot is the one handed out next.
  bash "$me" release alpha
  local reused
  reused="$(bash "$me" alloc delta me@host)"
  check "freed port reused" "$(jq -r .consolePort <<<"$reused")" "3100"
  check "freed storage reused" "$(jq -r .storagePort <<<"$reused")" "8341"

  bash "$me" store delta 01ABC
  check "store id recorded" "$(bash "$me" list | jq -r '.delta.storeId')" "01ABC"

  # ── idle-minutes: a quantity, or a word. Never a quantity STANDING FOR a word (#3922). ──
  # These run everywhere now. The empty-registry case was previously asserted to be 999999
  # and the timestamp cases were skipped on macOS, so on the machine this file is written on
  # the whole function was covered by one assertion of the defect itself.
  bash "$me" release cache-engine-aws
  bash "$me" release gamma
  bash "$me" release delta
  check "empty registry reports absence, not a duration" "$(bash "$me" idle-minutes)" "none"

  # The property, stated separately from the word: whatever absence is called, it must not be
  # something a caller can compare against a minute threshold and get an answer to.
  case "$(bash "$me" idle-minutes)" in
  '' | *[!0-9]*) check "an absent idle age is not a number" "not-a-number" "not-a-number" ;;
  *) check "an absent idle age is not a number" "$(bash "$me" idle-minutes)" "not-a-number" ;;
  esac

  # An unparseable lastSeen must ALSO fail safe, and say a different thing: "I could not read
  # the stamp" and "there was no stamp" are different facts about the box.
  echo '{"x":{"consolePort":3100,"lastSeen":"not-a-date"}}' >"$tmp/envs.json"
  check "bad timestamp reports unknown" "$(bash "$me" idle-minutes)" "unknown"

  # …and a stamp it CAN read is still a number, on either date dialect.
  local recent old
  recent="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  old="$(date -u -v-6H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '6 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
  echo "{\"x\":{\"consolePort\":3100,\"lastSeen\":\"$recent\"}}" >"$tmp/envs.json"
  check "a fresh stamp is 0 minutes idle" "$(bash "$me" idle-minutes)" "0"
  echo "{\"x\":{\"consolePort\":3100,\"lastSeen\":\"$old\"}}" >"$tmp/envs.json"
  check "a six-hour-old stamp is 360 minutes idle" "$(bash "$me" idle-minutes)" "360"

  # The newest row wins, so one live env keeps the box off the reaper's list.
  echo "{\"x\":{\"lastSeen\":\"$old\"},\"y\":{\"lastSeen\":\"$recent\"}}" >"$tmp/envs.json"
  check "idle age is the MOST RECENT env's" "$(bash "$me" idle-minutes)" "0"

  echo "  ${pass} passed, ${fail} failed"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
--self-test) self_test ;;
alloc) cmd_alloc "${2:?slug}" "${3:?owner}" ;;
touch) cmd_touch "${2:?slug}" ;;
store) cmd_store "${2:?slug}" "${3:?store id}" ;;
release) cmd_release "${2:?slug}" ;;
list)
  ensure
  cat "$REG"
  ;;
idle-minutes) cmd_idle_minutes ;;
*)
  echo "usage: env-registry.sh {alloc <slug> <owner>|touch <slug>|store <slug> <id>|release <slug>|list|idle-minutes}" >&2
  exit 1
  ;;
esac
