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
# ── A NEGATED KEYWORD IS NOT A KEYWORD (#3855) ────────────────────────────────────────────────
# The lookbehinds reject "does not close #n", "doesn't close #n", "never closes #n", "cannot close
# #n". Without them, a PR body EXPLAINING why it does not close an issue reads as a closing PR —
# which here means `has_closing_pr` answers true and `claim-work.sh` silently refuses to hand the
# unit out, forever, with nothing to see. The same defect in the CLOSING direction lives in
# .github/workflows/close-on-dev-merge.yml, where it wrongly closed #3855 TWICE in one day; that
# one was noticed because an issue visibly shut, and this one would not have been.
#
# Keep IDENTICAL to the pattern in that workflow — scripts/check-closing-keyword-parsers.mjs fails
# the build when they drift. These run through jq's Oniguruma, which supports lookbehind; plain
# ERE `grep` does not, which is why neither site uses grep any more.
BOARD_PR_CLOSING_KW='(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) +'

# ── A NEGATED KEYWORD IS NOT A KEYWORD (#3855) ────────────────────────────────────────────────
# Composed ONTO the vocabulary above by the matchers, never baked INTO it. That split is
# load-bearing and I got it wrong first: `BOARD_PR_CLOSING_KW` is a VOCABULARY, and two other
# readers parse it as a plain alternation to extract the keyword LIST —
# `coordinate.sh:closing_keywords_json()` strips `^(`/`)$` and splits on `|`, and
# `scripts/ci/check-pr-scope.mjs:102` matches `/^BOARD_PR_CLOSING_KW='\(([^)]+)\)/`. Prefixing the
# lookbehinds directly made the first capture `?<!not `, which
# `scope-overlap.mjs:579 closingRefsIn` then compiled into
# `/\b(?:?<!not)\s+#(\d+)\b/gi` → "SyntaxError: Nothing to repeat", taking the whole
# `Authz / open-core guards` job down. Four consumers, two contracts: keep them apart.
#
# What it rejects: "does not close #n", "doesn't close #n", "never closes #n", "cannot close #n".
# Without it a PR body EXPLAINING why it does not close an issue reads as a closing PR — here that
# makes `has_closing_pr` answer true, so `claim-work.sh` silently refuses to hand the unit out,
# forever, with nothing to see. The same defect in the CLOSING direction lives in
# .github/workflows/close-on-dev-merge.yml, where it wrongly closed #3855 TWICE in one day; that
# one was noticed because an issue visibly shut, and this one would not have been.
#
# Keep IDENTICAL to the guard in that workflow — scripts/check-closing-keyword-parsers.mjs fails
# the build when they drift. These run through jq's Oniguruma, which supports lookbehind; plain
# ERE `grep` does not, which is why neither site uses grep any more.
# Three families, and they are here because each one CLOSED A REAL ISSUE:
#   negation        "does not close #n" / "doesn't" / "never closes" / "cannot close"
#                   → #3855, twice on 2026-09-22 (#4919 16:54Z, #4924 21:41Z)
#   relative clause "that is what closes #n" — grammatically a closing reference; only the
#                   surrounding meaning says otherwise
#                   → #3348, closed by #4940's own sentence explaining it used `Refs` not `Closes`
# The third family cannot be a lookbehind at all — see BOARD_PR_STRIP_CODE below.
BOARD_PR_NEGATION_GUARD='(?<!not )(?<!n.t )(?<!never )(?<!what )(?<!that )(?<!which )'

# ── A QUOTED KEYWORD IS NOT AN ASSERTED ONE ───────────────────────────────────────────────────
# Strips fenced blocks and inline code before matching. A keyword inside backticks is being
# NAMED, not used — and unlike the two families above this is mechanically decidable, so it is
# preprocessing rather than a guess.
#
# It is here because #4110 was closed by this line in #4935's body:
#
#     ## ⚠️ Changed from `Closes #4110` to `Refs #4110` — deliberately
#
# …the note explaining that the reference had been changed FROM `Closes` so the issue would STAY
# OPEN. The PR said `Refs`. The prose quoting the old form closed it anyway.
#
# Fenced first, then inline: a ``` block may contain single backticks, and stripping inline spans
# first would leave the fence's content exposed.
BOARD_PR_STRIP_CODE='gsub("(?s)```.*?```"; " ") | gsub("`[^`\n]*`"; " ")'

# ── A CLOSING KEYWORD MUST START ITS LINE ─────────────────────────────────────────────────────
# This is the structural rule the three guards above were converging on one family at a time, and
# it SUBSUMES all of them. Every false positive that closed an issue on 2026-09-22/23 was prose
# ABOUT closing, and every one of them was MID-SENTENCE:
#
#   #3855  "This does not close #3855."                       (#4919, #4924)
#   #3348  "That is what closes #3348, which is why…"         (#4940)
#   #4110  "Changed from `Closes #4110` to `Refs #4110`"      (#4935)
#   #3348  "they closed #3348 and #4110 while this branch…"   (#4945 — the PR FIXING this)
#
# The fourth arrived eleven seconds after the third fix merged, from the very paragraph documenting
# the defect. A PR that explains this bug is GUARANTEED to contain the strings, so lookbehinds are
# whack-a-mole by construction.
#
# MEASURED before adopting, over the last 60 merged dev PRs: 28 closing refs sit on their own line,
# 10 appear only inline — and of those 10, exactly TWO are genuine ("Closes #4910. Also fixes…",
# "Closes #4114. Part of #2766."), both LINE-INITIAL with prose after. The other eight are the
# false positives above. So line-initial keeps 30 of 30 real references and rejects 8 of 8 false
# ones on real data, rather than on an argument.
#
# The anchor allows leading whitespace, list markers and bold, because that is how they are written:
# `- Closes #n`, `**Closes #n**`. It does NOT allow a table cell (`| … |`) or mid-sentence text.
#
# ⚠️ `(?m)` IS REQUIRED AND IT MEANS MULTILINE HERE. Classic Oniguruma documents `(?m)` as DOTALL,
# but jq's build uses Perl semantics — verified both ways: with `(?m)` a line-initial match on line
# 2 is found, without it `^` anchors to the string start only and finds nothing; and `(?m)a.b` does
# NOT match "a\nb", so it is not dotall. `(?s)` is dotall, which is what STRIP_CODE uses.
#
# Callers must therefore join title and body with a NEWLINE, not a space, or a title-borne
# `Closes #n` stops being line-initial. Both call sites below do.
#
# `[*][*]` rather than `\*\*` on purpose: these patterns are embedded in a jq STRING literal, and
# `\*` is not a valid jq string escape — it fails to compile the whole program. A character class
# needs no backslash and cannot be mangled by the next person adding an escaping layer.
BOARD_PR_LINE_ANCHOR='(?m)^[ \t]*(?:[-*>][ \t]*)*(?:[*][*])?'
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
               | select((.title + \"\\n\" + .body) | $BOARD_PR_STRIP_CODE
                          | test(\"(?i)($kws) *#$n\\\\b\"))] | length" \
    2>/dev/null
}

# has_closing_pr <issue-number>: true (exit 0) if an OPEN or MERGED PR CLOSES this issue — work in
# flight on another box, or an issue whose PR merged but GitHub never auto-closed (a "Closes #n"
# that didn't link). Searches title AND body.
has_closing_pr() { # <n> -> 0 = a PR closes it (or we couldn't tell) · 1 = definitely none
  local n="$1" out
  if ! out="$(_board_pr_matching "$n" '.state=="OPEN" or .state=="MERGED"' "$BOARD_PR_LINE_ANCHOR$BOARD_PR_NEGATION_GUARD$BOARD_PR_CLOSING_KW")"; then
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
    --jq "[.[] | select((.title + \"\\n\" + .body) | $BOARD_PR_STRIP_CODE
              | test(\"(?i)($BOARD_PR_LINE_ANCHOR$BOARD_PR_NEGATION_GUARD$BOARD_PR_CLOSING_KW|$BOARD_PR_LINKING_KW) *#$n\\\\b\"))]
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

# ── THE LEASE HALF OF "STALLED", so a caller does not have to reimplement it ─────────────────────
#
# `stalled_pr_ref` above answers "is the PR holding this unit stuck". That is only half of what
# `.claude/COORDINATION.md` means by a stalled unit: the other half is that the ISSUE LEASE is long
# dead. Until #4428 the lease half lived only inline in coordinate.sh, so anything else that wanted
# the composite had to grow a second copy of it — which is what this file exists to prevent.
#
# ⚠ THERE IS STILL ONE DUPLICATE HERE, and it is pre-existing rather than introduced: coordinate.sh
# carries `to_epoch` (:285) which is `_board_pr_epoch` (:111 of this file) character for character,
# and its own inline lease read. Adopting these two functions there removes both — #4480, filed rather
# than done in this unit, because the reclaim path is the one place a subtle change hands a live
# instance's work to a second one, and it should not be refactored without a human watching.

# board_lease_age_seconds <issue-number>: how old the unit's most recent lease stamp is, in seconds.
#
# Prints NOTHING when the age cannot be determined — no lease comment, or a timestamp neither `date`
# accepts. That is the same instinct as `board_pr_is_stalled`'s unparseable-timestamp arm and as
# coordinate.sh's "unreadable lease timestamp — leaving the claim in place": when we cannot tell how
# old a claim is, we must not be the one to say it is dead.
#
# `stamped_at` is preferred over `claimed_at` because `--heartbeat` re-stamps only the former; a unit
# being actively built refreshes `stamped_at` and keeps `claimed_at` from its first claim.
board_lease_age_seconds() { # <n> -> prints seconds, or nothing
  local n="$1" body stamp now
  body="$(gh issue view "$n" --json comments \
    --jq '[.comments[].body|select(startswith("```lease"))]|last // ""' 2>/dev/null)" || return 0
  [ -z "$body" ] && return 0
  stamp="$(printf '%s\n' "$body" | sed -n 's/^stamped_at: //p' | tail -1)"
  [ -z "$stamp" ] && stamp="$(printf '%s\n' "$body" | sed -n 's/^claimed_at: //p' | tail -1)"
  [ -z "$stamp" ] && return 0
  local epoch
  epoch="$(_board_pr_epoch "$stamp")"
  [ -z "$epoch" ] && return 0
  now="$(date -u +%s)"
  printf '%s' $(( now - epoch ))
}

# board_unit_is_stalled <n> <lease-ttl> <pr-idle-ttl>: BOTH halves, as COORDINATION.md defines them —
# the lease is older than the lease TTL, AND a PR holding the unit is itself stuck.
#
# FAIL-CLOSED, and the direction matters: "not stalled" is the answer whenever either half cannot be
# established. A caller uses this to justify overriding a guard that exists to prevent the #1247
# double-claim, so an unknown must never read as permission.
board_unit_is_stalled() { # <n> <lease-ttl> <pr-idle-ttl> -> 0 = stalled · 1 = not, or cannot tell
  local n="$1" lease_ttl="$2" pr_ttl="$3" age
  age="$(board_lease_age_seconds "$n")"
  [ -z "$age" ] && return 1
  [ "$age" -gt "$lease_ttl" ] || return 1
  [ -n "$(stalled_pr_ref "$n" "$pr_ttl")" ] || return 1
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

# ── A BODY THAT ASSERTS A PROTECTION THE ISSUE DOES NOT CARRY ────────────────────────────────────
#
# WHY. #4112 opens with "NOT AGENT-BUILDABLE. Creating repositories … `needs:human` keeps this out
# of `claim-work.sh`'s autonomous picking." Its labels were `wave:hygiene, lane:docs, class:backend`.
# The protection its own first sentence asserts DOES NOT EXIST, so the unit sat at the TOP of
# `claim-work.sh --class backend`'s ready queue inviting an agent to "create" three repositories
# that already existed, were public, and were unlicensed.
#
# This is the "a wrong COMMENT on correct code" class, on the board instead of in a file: the prose
# and the mechanism disagree, no check reads the prose, and the prose is what the author trusted.
# `claim-work.sh` filters on LABELS and never reads a word of the body, so the assertion is
# unenforced by construction — and it fails OPEN, which is the dangerous direction.
#
# ── THE BOUND, and it is the whole reason this is cheap ──
#
# Only units `claim-work.sh` can actually pick are asked: an OPEN issue carrying a `class:` label.
# That bound is not tidiness, it is what removes the noise. Measured against the 43 open issues on
# 2026-09-22, a plain "does the body contain the string" match over the whole board produced two
# false positives and both were outside the bound — #4264 ("`needs:human` removed", about #4273)
# and #2945 (an overnight report summarising "all 33 open `needs:human` units"), neither of which
# carries a `class:` label and neither of which claim-work can hand to anybody.
#
# ── WHAT IS MATCHED, AND WHAT IS DELIBERATELY NOT ──
#
# The label name IN BACKTICKS, plus the prose form NOT AGENT-BUILDABLE. Backticks are a STRUCTURAL
# signal, not a stylistic one: an author writing `needs:human` is naming a LABEL, while one writing
# "epic" is almost always writing English. On the same 43-issue board the bare word `epic` appeared
# in six board-unit bodies and ALL SIX were prose — "Part of the release-gate epic: #4264", "the
# epic's bar", "epic #1419" — while backticked `epic` appeared in none.
#
#   · `blocked` is NOT matched. Two reasons, and either alone is sufficient. It is already
#     mechanised in both directions by coordinate.sh's `unblock` pass, which RECOMPUTES the label
#     from the body's `blocked-by:` line every run — a prose check would be a second, weaker opinion
#     about a question that already has an authoritative one. And it is noisy even backticked: #3612
#     writes "#3662 → #3663 → #3664 are all correctly `blocked`", which is a statement about three
#     OTHER issues' labels.
#   · `epic` is NOT matched. Zero measured signal (no board unit backticks it) against a real noise
#     source (six bare-word prose uses), so it would be a matcher with nothing to find and something
#     to get wrong. If an umbrella issue ever does assert `epic` in backticks without carrying it,
#     add it here WITH the measurement — do not add it on the theory that the set should be
#     symmetric with claim-work.sh's filter. The self-test pins that filter instead, so a new
#     exclusion label there cannot slip past unnoticed.
#
# ── WHY IT OVER-REPORTS ON PURPOSE ──
#
# An author CAN discuss another unit's `needs:human` on a board unit of their own, and this will
# flag it. Suppressing that — for instance by ignoring any line that also names a `#<n>` — was
# considered and REJECTED: it can only remove findings, and the thing it would remove first is a
# body that names its blocker on the same line as its protection. This is an ADVISORY line in a
# report and a warning at claim time; it blocks nothing. A false positive costs a reader one
# second, a false negative is #4112 happening again.
#
# Reads the board as one `gh issue list --json number,title,labels,body` array on STDIN.
# Prints one `<number>\t<asserted>\t<labels>` row per finding. No finding prints nothing.
# Returns 0 when it examined the board (found or not) and 4 when it could NOT examine it — the
# caller must render those two differently, because "nothing found" and "never ran" are the same
# silence otherwise.
#
# The assertions, as an `|`-alternation of EXTENDED regexes. Kept as a constant because the matcher
# below and the self-test must not be able to disagree about what counts as an assertion.
BOARD_PROTECTION_ASSERTIONS='`needs:human`|NOT AGENT-BUILDABLE'
# Which label each assertion claims. Same order, same count — the self-test asserts both.
BOARD_PROTECTION_LABELS='needs:human|needs:human'

board_asserted_protection() { # stdin: board JSON -> rows on stdout · 0 = examined · 4 = could not
  command -v jq >/dev/null 2>&1 || return 4
  jq -r --arg pats "$BOARD_PROTECTION_ASSERTIONS" --arg labs "$BOARD_PROTECTION_LABELS" '
    # A FENCED BLOCK IS NOT AN ASSERTION. Same hazard, same cure as coordinate.sh
    # `blocked_by_from_body`: .claude/skills/decompose/SKILL.md prints a seeding snippet at column
    # zero inside a ```bash fence, so a body that pastes it would otherwise acquire a phantom
    # assertion. CLOSED fences only — an unterminated one leaves the rest of the body in play,
    # which can only over-report, and over-reporting is the safe direction here.
    # A CLOSED fence is dropped; an UNTERMINATED one is given back. That asymmetry is the whole
    # point and a plain open/closed toggle gets it backwards: a toggle drops everything after one
    # stray backtick run, which SUPPRESSES findings — the fail-CLOSED direction, silently. So the
    # lines inside a fence are buffered, discarded when the closer arrives, and appended back if it
    # never does. Keeping them can only over-report, which is visible.
    def strip_fences:
      split("\n")
      | reduce .[] as $l ({open: false, pending: [], out: []};
          if ($l | test("^[[:space:]]*(```|~~~)")) then
            (if .open then {open: false, pending: [], out: .out}
             else {open: true, pending: [$l], out: .out} end)
          elif .open then {open: true, pending: (.pending + [$l]), out: .out}
          else {open: false, pending: .pending, out: (.out + [$l])} end)
      | (if .open then (.out + .pending) else .out end)
      | join("\n");
    ($pats | split("|")) as $P | ($labs | split("|")) as $L
    | if type != "array" then empty else .[] end
    | select(.body != null)
    # THE BOUND: only what claim-work.sh could hand to somebody.
    | select(.labels | map(.name) | any(startswith("class:")))
    | . as $i | ($i.body | strip_fences) as $prose
    | (.labels | map(.name)) as $names
    # `range(…) as $ix`, NOT a bare `.`. The arguments of `test` are evaluated against the OWN input
    # of test, so `$P[.]` there indexes the array with the BODY STRING and dies — which the
    # `2>/dev/null` below would turn into a silent rc=4 "could not examine" on every single run.
    # (No apostrophes in this block: the whole jq program is one single-quoted shell word.)
    | [ range(0; $P | length) as $ix
        | select($prose | test($P[$ix]; "i"))
        | select($names | index($L[$ix]) | not)
        | {a: $P[$ix], l: $L[$ix]} ] as $hits
    | select($hits | length > 0)
    # Four TAB-separated fields: number · what the body asserts · the label(s) it thereby claims ·
    # the labels it actually carries. Both callers read them positionally.
    | "\($i.number)\t\($hits | map(.a) | unique | join(", "))\t\($hits | map(.l) | unique | join(", "))\t\($names | join(","))"
  ' 2>/dev/null || return 4
}
