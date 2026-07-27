#!/usr/bin/env bash
# shellcheck shell=bash
#
# Board ↔ PR guards — "is somebody already on this unit?"
#
# WHY THIS EXISTS. On 2026-07-27 `claim-work.sh --class backend` handed out #1389 while another
# instance was actively building its one remaining tier on open PR #1408 (2 commits, worktree held
# live). Only the claimer happening to recognise the issue prevented a duplicate build — the failure
# mode of #1247. The guard missed it because it matched CLOSING keywords only, and #1408 opens with
# "Part of #1389": correct phrasing, because it delivers one cloud's tier of a multi-cloud unit
# rather than the whole issue. Multi-tier units are the norm on this board, so this was a systematic
# hole, not an edge case.
#
# WHY ONE SHARED FILE, against the repo's copy-paste-the-lock convention. `has_closing_pr` was
# duplicated VERBATIM in claim-work.sh and coordinate.sh. That is the same shape that let the xacct
# gate diverge across three copies: one protocol, several call sites, and a drift between them is a
# silent false-ALLOW — which here means two instances building the same thing. So, exactly like
# scripts/lib/wt-lease.sh, it lives here once.
#
# FAIL-CLOSED IS THE CONTRACT. Every predicate here answers "is this taken?" and returns TAKEN when
# it cannot tell (gh rate limit, expired auth, network blip). A guard that silently evaporates under
# load is worse than no guard, because it is trusted. Skipping a claimable unit costs one cycle;
# claiming a taken one costs two instances' work.

# The two keyword sets, as constants because the gh query AND the offline matcher below must use the
# SAME regex — a drift between "what we skip on" and "what we test" would make the self-test lie.
#
# CLOSING: this PR finishes the issue. GitHub's nine keywords, spelled out.
#
# This was `(close|fix|resolve)(s|d)?` until the self-test below caught it: that expands to
# fix/fixs/fixd, so **"Fixes #n" and "Fixed #n" never matched** — the single most common closing
# phrasing on GitHub was invisible to the guard, leaving units claimable while a PR was closing
# them. coordinate.sh's close-shipped path already had the correct enumeration; the guard carried
# the broken shorthand. One protocol, two copies, one of them wrong — the reason this file exists.
BOARD_PR_CLOSING_KW='(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) +'
# LINKING: this PR is BUILDING the issue without finishing it — the phrasing a PR uses when it
# delivers one tier of a multi-tier unit (#1414 "Part of #1268", #1408 "Part of #1389"). Kept to an
# explicit list on purpose: matching a bare "#1389" anywhere would let an incidental "similar to
# #1389" lock a unit forever.
BOARD_PR_LINKING_KW='(part of|partof|towards?|contributes? to|implements?|builds on|stacked on)( +epic)? +'

# board_pr_links <text> <issue-number> <kw-alternation>: does this text link the issue with one of
# these keywords? Pure (no network) so the self-test can pin the discrimination offline.
# `\b` after the number so #84 does not match #842.
board_pr_links() { # <text> <n> <kw> -> 0 = links · 1 = does not
  jq -ne --arg t "$1" --arg re "(?i)($3) *#$2\\b" '$t | test($re)' >/dev/null 2>&1
}

# _board_pr_matching <issue-number> <states-jq-filter> <keyword-alternation>
# Counts PRs whose body or title links the issue with one of the given keywords. Prints the count,
# or fails (non-zero) when the query itself failed — callers translate that into "taken".
_board_pr_matching() { # <n> <state-filter> <kw-alternation> -> prints count | returns 1 on query failure
  local n="$1" states="$2" kws="$3"
  gh pr list --state all --limit 20 --search "#$n" --json number,state,body,title \
    --jq "[.[] | select($states)
               | select((.body + \" \" + .title) | test(\"(?i)($kws) *#$n\\\\b\"))] | length" \
    2>/dev/null
}

# has_closing_pr <issue-number>: true (exit 0) if an OPEN or MERGED PR CLOSES this issue — work in
# flight on another box, or an issue whose PR merged but GitHub never auto-closed (a "Closes #n"
# that didn't link). Searches title AND body.
has_closing_pr() { # <n> -> 0 = a PR closes it (or we couldn't tell) · 1 = definitely none
  local n="$1" out
  if ! out="$(_board_pr_matching "$n" '.state=="OPEN" or .state=="MERGED"' "$BOARD_PR_CLOSING_KW")"; then
    echo "⚠ could not check PRs for #$n (gh failed) — treating as taken." >&2
    return 0
  fi
  [ "${out:-0}" -gt 0 ]
}

# has_active_pr <issue-number>: true if an OPEN PR is BUILDING this issue without claiming to close
# it — the "Part of #n" case has_closing_pr cannot see.
#
# Scope choices, each deliberate:
#   * OPEN only. A merged "Part of #n" PR delivered one tier and left the rest open — that is
#     genuinely claimable work, and has_closing_pr already covers the merged-closing case.
#   * DRAFTS COUNT. #1408 is a draft; a draft with commits is exactly the in-flight state to catch.
#   * A KEYWORD LIST, not any mention. Matching a bare "#1389" anywhere would let an incidental
#     "similar to #1389" lock a unit forever. These are the phrasings the board actually uses to
#     mean "I am building this" (see #1414 "Part of #1268", #1464 "Part of epic #1419").
#
# KNOWN TRADE-OFF: an abandoned open draft saying "Part of #n" makes #n unclaimable by the
# autonomous loop until that PR is closed. That is the correct direction to fail, and
# `claim-work.sh --issue <n>` stays an override for a human taking over.
has_active_pr() { # <n> -> 0 = an open PR is building it (or we couldn't tell) · 1 = definitely none
  local n="$1" out
  if ! out="$(_board_pr_matching "$n" '.state=="OPEN"' "$BOARD_PR_LINKING_KW")"; then
    echo "⚠ could not check in-flight PRs for #$n (gh failed) — treating as taken." >&2
    return 0
  fi
  [ "${out:-0}" -gt 0 ]
}

# board_pr_is_stalled <mergeable> <updated-at-epoch> <now-epoch> <idle-ttl>: is this OPEN PR stuck
# rather than in flight? Pure (no network) so the self-test can pin it offline.
#
# Two independent signals, either one is enough:
#   * CONFLICTING — it cannot merge until somebody rebases it. Mergify will not touch it.
#   * idle beyond <idle-ttl> — nobody has pushed, commented or re-run anything.
#
# This DECIDES NOTHING about claiming. It exists so a unit that is blocked behind a dead PR can be
# NAMED, because that state is otherwise completely silent: the board shows `claimed`, the guards
# correctly refuse to hand it out, and the instance that claimed it is gone. See the caller in
# coordinate.sh — the fix for "invisible" is a louder report, NOT a weaker guard.
# ISO-8601 → epoch, GNU and BSD `date`. Deliberately private and duplicated from coordinate.sh's
# `to_epoch` rather than shared: this file is sourced by several scripts and must not depend on a
# function the CALLER happens to define, which would break the moment a new caller sources it. The
# no-duplication rule at the top of this file is about the PROTOCOL (the keyword sets and the
# predicates); a date parse carries no policy and cannot drift into a false-ALLOW.
_board_pr_epoch() { # <iso8601> -> prints epoch seconds, or nothing
  date -u -d "$1" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null || true
}

board_pr_is_stalled() { # <mergeable> <updated_epoch> <now_epoch> <ttl> -> 0 = stalled · 1 = looks alive
  local mergeable="$1" updated="$2" now="$3" ttl="$4"
  [ "$mergeable" = "CONFLICTING" ] && return 0
  # Unparseable/missing timestamp → NOT stalled. Same instinct as the lease's unreadable-stamp path:
  # when we cannot tell, say nothing rather than accuse a live PR of being dead.
  case "$updated" in ''|*[!0-9]*) return 1 ;; esac
  [ $(( now - updated )) -gt "$ttl" ]
}

# stalled_pr_ref <issue-number> <idle-ttl>: describe the first OPEN PR linked to this issue that is
# stalled by board_pr_is_stalled — e.g. "#1461 (CONFLICTING, idle 8h)". Empty when every linked PR
# looks alive, or when we cannot tell. Best-effort and non-fatal: this is a DIAGNOSTIC, so a gh
# failure here must never change a caller's decision (contrast the fail-closed predicates above,
# which answer "is this taken?").
stalled_pr_ref() { # <n> <ttl> -> prints e.g. "#1461 (CONFLICTING, idle 8h)" or nothing
  local n="$1" ttl="$2" now rows
  now="$(date -u +%s)"
  rows="$(gh pr list --state open --limit 20 --search "#$n" --json number,mergeable,updatedAt,body,title \
    --jq "[.[] | select((.body + \" \" + .title)
              | test(\"(?i)($BOARD_PR_CLOSING_KW|$BOARD_PR_LINKING_KW) *#$n\\\\b\"))]
          | .[] | \"\\(.number)\\t\\(.mergeable)\\t\\(.updatedAt)\"" 2>/dev/null)" || return 0
  [ -z "$rows" ] && return 0
  local pr mergeable ts upd idle
  while IFS=$'\t' read -r pr mergeable ts; do
    [ -z "$pr" ] && continue
    upd="$(_board_pr_epoch "$ts")"
    if board_pr_is_stalled "$mergeable" "${upd:-}" "$now" "$ttl"; then
      idle=$(( (now - ${upd:-now}) / 3600 ))
      printf '#%s (%s, idle %sh)' "$pr" "$mergeable" "$idle"
      return 0
    fi
  done <<EOF
$rows
EOF
  return 0
}

# active_pr_ref <issue-number>: the "#<pr> (<state>)" of the first OPEN PR building this issue, for
# a diagnostic that names what to go look at. Best-effort — empty when unknown, never fails the
# caller (the DECISION belongs to has_active_pr; this is only how we describe it).
active_pr_ref() { # <n> -> prints e.g. "#1408 (draft)" or nothing
  local n="$1"
  gh pr list --state open --limit 20 --search "#$n" --json number,isDraft,body,title \
    --jq "[.[] | select((.body + \" \" + .title) | test(\"(?i)($BOARD_PR_LINKING_KW) *#$n\\\\b\"))]
          | .[0] | if . == null then \"\" else \"#\\(.number) (\\(if .isDraft then \"draft\" else \"open\" end))\" end" \
    2>/dev/null || true
}
