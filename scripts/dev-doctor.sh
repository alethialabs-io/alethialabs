#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# `pnpm dev:doctor` — measure local health: disk, Docker, worktrees, and the box.
#
# THE POINT OF THIS FILE IS THAT IT MEASURES RATHER THAN ASSERTS.
#
# On 2026-07-27 a cleanup projected "85-90 GB freed" from deleting 35 worktrees and
# actually freed ~7 GB. The projection came from summing per-directory `du`, which
# double-counts every inode shared between trees. pnpm stores packages once and links
# them into each `node_modules`, and this repo has NO .npmrc pinning the method, so
# pnpm's default (`auto`: clone-on-write on APFS, hardlink elsewhere) means most of a
# worktree's apparent size is shared with the store and with its siblings.
#
# So: a single `du` pass across ALL worktrees at once, which counts each shared inode
# exactly once and reports the real recoverable total, plus the naive sum alongside so
# the gap is visible instead of misleading.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARENT="$(dirname "$ROOT")"

hr() { printf '\n\033[1m%s\033[0m\n' "$1"; }
human() { # <kilobytes>
  awk -v k="$1" 'BEGIN {
    split("K M G T", u, " ");
    i = 1; while (k >= 1024 && i < 4) { k /= 1024; i++ }
    printf "%.1f%s", k, u[i]
  }'
}

hr "Disk"
# macOS: / is the read-only system volume and flatters the number; the volume that
# fills is /System/Volumes/Data.
target=/
[ -d /System/Volumes/Data ] && target=/System/Volumes/Data
df -h "$target" | awk 'NR==1 || NR==2'

hr "Worktrees"
mapfile -t trees < <(git -C "$ROOT" worktree list --porcelain 2>/dev/null |
  awk '/^worktree /{print $2}')
echo "  ${#trees[@]} worktree(s)"

hydrated=0
for t in "${trees[@]}"; do
  if [ -d "$t/node_modules" ]; then hydrated=$((hydrated + 1)); fi
done
echo "  ${hydrated} hydrated (have node_modules)"
if [ "$hydrated" -gt 1 ]; then
  cat <<'NOTE'
  ⚠ Worktrees are meant to be DE-HYDRATED now — they run on the box (pnpm env:up), and
    their checks run there too (pnpm env:check). Only the main checkout needs a local
    install, for the editor and vitest.
NOTE
fi

hr "Worktree disk — apparent vs real"
if [ "${#trees[@]}" -gt 0 ]; then
  echo "  measuring (one pass over all trees; this takes a moment)…"
  # ONE du invocation over every tree: shared inodes are counted once.
  real_k="$(du -sck "${trees[@]}" 2>/dev/null | awk 'END {print $1}')"
  naive_k=0
  for t in "${trees[@]}"; do
    k="$(du -sk "$t" 2>/dev/null | awk '{print $1}')"
    naive_k=$((naive_k + ${k:-0}))
  done
  echo "  sum of per-tree du : $(human "$naive_k")   ← what a naive estimate reports"
  echo "  one du over all    : $(human "$real_k")   ← hardlinks counted once"
  if [ "${naive_k:-0}" -gt 0 ] && [ "${real_k:-0}" -gt 0 ]; then
    awk -v n="$naive_k" -v r="$real_k" 'BEGIN {
      if (n > r * 1.1) printf "  hardlink sharing   : %.0f%% of the apparent size is shared inodes\n", (1 - r/n) * 100
      else print  "  hardlink sharing   : none detected"
    }'
  fi
  # Be honest about what this number is NOT. `du` de-duplicates hardlinks (same inode)
  # but CANNOT see APFS copy-on-write clones, which are distinct inodes sharing extents
  # — and pnpm's default `auto` import method uses cloning on APFS. So on macOS the
  # figure above is an UPPER BOUND on what you would actually reclaim, not a forecast.
  # Treating it as a forecast is what produced the "85-90 GB" projection that freed ~7.
  if [ -d /System/Volumes/Data ]; then
    cat <<'NOTE'
  ⚠ macOS/APFS: du cannot see copy-on-write clones (pnpm's default import method), so
    the figure above is an UPPER BOUND, not a forecast. The only ground truth is `df`
    before and after. Do not quote it as "space this will free".
NOTE
  fi
fi

hr "pnpm store"
if command -v pnpm >/dev/null 2>&1; then
  store="$(pnpm store path 2>/dev/null || true)"
  if [ -n "$store" ] && [ -d "$store" ]; then
    echo "  $store  $(du -sh "$store" 2>/dev/null | awk '{print $1}')"
    echo "  prune unreferenced packages:  pnpm store prune"
  fi
fi
if [ -f "$ROOT/.npmrc" ]; then
  echo "  .npmrc: $(grep -E 'package-import-method' "$ROOT/.npmrc" || echo 'no package-import-method set')"
else
  echo "  no .npmrc — pnpm uses package-import-method=auto (APFS clone / hardlink)."
fi

hr "Go caches"
if command -v go >/dev/null 2>&1; then
  for v in GOCACHE GOMODCACHE; do
    d="$(go env "$v" 2>/dev/null)"
    [ -d "$d" ] && echo "  $v  $(du -sh "$d" 2>/dev/null | awk '{print $1}')  ($d)"
  done
  echo "  clear build cache:  go clean -cache"
fi

hr "Docker"
if docker info >/dev/null 2>&1; then
  docker system df 2>/dev/null
  orphans="$(docker ps -aq --filter status=exited 2>/dev/null | wc -l | tr -d ' ')"
  echo "  ${orphans} exited container(s)"
  # Deliberately NOT run for you: the compose stack is shared across windows and
  # pruning images can disrupt another session mid-build.
  echo "  reclaim (review first):  docker builder prune  ·  docker image prune"
else
  echo "  docker not responding"
fi

hr "Sandbox box"
if command -v tofu >/dev/null 2>&1; then
  ip="$(tofu -chdir="$ROOT/infra/sandbox" output -raw server_ipv4 2>/dev/null |
    grep -Eo '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || true)"
  if [ -n "$ip" ]; then
    echo "  up at $ip   ·   pnpm env:status for environments and capacity"
  else
    echo "  down or not created   ·   pnpm env:box"
  fi
else
  echo "  tofu not installed — cannot read infra/sandbox state"
fi

hr "Stray local runtimes"
# These are what the box exists to replace; seeing them here means something bypassed
# the guard (or predates it).
found=0
for port in 3000 3002 3010 3011 3100; do
  pid="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null | head -1)"
  if [ -n "$pid" ]; then
    echo "  :$port held by pid $pid  ($(ps -p "$pid" -o comm= 2>/dev/null || echo '?'))"
    found=1
  fi
done
[ "$found" = 0 ] && echo "  none — nothing is serving the app locally, which is the intent."

echo ""
