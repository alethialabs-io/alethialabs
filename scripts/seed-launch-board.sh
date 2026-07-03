#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Seed the 30-day Launch Sprint as GitHub Milestones + Issues from spec/mvp/19-launch-sprint.md.
# Run AFTER the repo is public at alethialabs-io. Creates 4 weekly milestones (with due dates)
# and the headline issues per week. A public roadmap doubles as build-in-public marketing.
#
# SAFE BY DEFAULT: prints what it would do (dry run). Pass --apply to actually create.
#
#   REPO=alethialabs-io/alethialabs START=2026-07-01 scripts/seed-launch-board.sh           # dry run
#   REPO=alethialabs-io/alethialabs START=2026-07-01 scripts/seed-launch-board.sh --apply    # create
#
set -euo pipefail

REPO="${REPO:-alethialabs-io/alethialabs}"
START="${START:-$(date +%F)}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Portable "START + N days" → YYYY-MM-DD (works on macOS BSD date and GNU date).
add_days() {
  local n="$1"
  if date -v+1d >/dev/null 2>&1; then date -j -v+"${n}"d -f %Y-%m-%d "$START" +%F
  else date -d "$START +${n} days" +%F; fi
}

note() { printf '\033[2m%s\033[0m\n' "$*"; }
run()  { if [ "$APPLY" -eq 1 ]; then eval "$@"; else echo "DRY » $*"; fi; }

if [ "$APPLY" -eq 1 ]; then
  command -v gh >/dev/null || { echo "gh not found"; exit 1; }
  gh repo view "$REPO" >/dev/null 2>&1 || { echo "Cannot see $REPO (is it public + are you authed?)"; exit 1; }
  # labels (ignore 'already exists')
  for l in launch product billing content week-1 week-2 week-3 week-4; do
    gh label create "$l" -R "$REPO" >/dev/null 2>&1 || true
  done
fi

note "Repo=$REPO  Start=$START  Mode=$([ $APPLY -eq 1 ] && echo APPLY || echo DRY-RUN)"

# --- milestones: title | day-offset | description ---
create_milestone() {
  local title="$1" due; due="$(add_days "$2")"
  run "gh api repos/$REPO/milestones -f title='$title' -f state=open -f due_on='${due}T23:59:59Z' -f description='$3' >/dev/null"
  echo "milestone: $title (due $due)"
}
create_milestone "Week 1 — Harden + prep" 7  "Hero flow flawless (E1), self-host one-click (E5), demo GIF, billing scaffold, launch prep."
create_milestone "Week 2 — Go public + checkout" 14 "Public repo migration, soft launch (r/selfhosted + awesome-list), Stripe checkout, comparison pages."
create_milestone "Week 3 — Launch + self-serve live" 21 "Show HN + r/devops + r/kubernetes, 48h engagement, self-serve checkout live. Target 200-500 stars."
create_milestone "Week 4 — Convert to MRR" 30 "Founding subs + 1-2 paid design-partner pilots; first MRR; community quick win."

# --- issues: milestone-title :: labels :: title ---
issue() {
  local ms="$1" labels="$2" title="$3" body="${4:-See spec/mvp/19-launch-sprint.md.}"
  run "gh issue create -R '$REPO' -m '$ms' -l '$labels' -t '$title' -b '$body' >/dev/null"
  echo "  issue → [$ms] $title"
}

# Week 1
issue "Week 1 — Harden + prep" "product,week-1" "E1: make GitOps failures loud + surface gitops_status + proof run"
issue "Week 1 — Harden + prep" "product,week-1" "E5: self-host one-click (docker compose + tested install.sh) ≤10 min"
issue "Week 1 — Harden + prep" "launch,week-1"  "Record 60-90s hero-flow demo GIF/video"
issue "Week 1 — Harden + prep" "billing,week-1" "Stripe account + Founding plan products/prices; workspace.plan schema"
issue "Week 1 — Harden + prep" "launch,week-1"  "Repo-migration checklist + URL-repoint audit for alethialabs-io"
issue "Week 1 — Harden + prep" "content,week-1" "Draft Show HN + r/selfhosted posts + vs-Porter comparison"
# Week 2
issue "Week 2 — Go public + checkout" "launch,week-2"  "Migrate repo to public alethialabs-io; repoint URLs; verify installer/Homebrew/docs"
issue "Week 2 — Go public + checkout" "launch,week-2"  "README polish (hero, demo GIF, badges, topics) + run seed-launch-board"
issue "Week 2 — Go public + checkout" "launch,week-2"  "Soft launch: r/selfhosted post + awesome-selfhosted PR; fix top-3 rough edges"
issue "Week 2 — Go public + checkout" "billing,week-2" "Stripe Checkout + webhook → set workspace.plan; gate 1-2 features via ee/ entitlements"
issue "Week 2 — Go public + checkout" "content,week-2" "Publish vs-Porter + vs-Qovery comparison pages"
# Week 3
issue "Week 3 — Launch + self-serve live" "launch,week-3"  "Show HN (Tue/Wed AM) + r/devops + r/kubernetes (staggered) + BIP thread"
issue "Week 3 — Launch + self-serve live" "launch,week-3"  "48h hands-on comment engagement (the star engine)"
issue "Week 3 — Launch + self-serve live" "billing,week-3" "Self-serve checkout LIVE; Upgrade CTA in console + pricing page (real card test)"
issue "Week 3 — Launch + self-serve live" "content,week-3" "vs-Spacelift page + SEO post: provision EKS without storing credentials"
# Week 4
issue "Week 4 — Convert to MRR" "billing,week-4" "Convert launch traffic → paid Founding subscriptions (founder/lifetime discount)"
issue "Week 4 — Convert to MRR" "billing,week-4" "Close 1-2 manual paid design-partner pilots (invoice)"
issue "Week 4 — Convert to MRR" "product,week-4" "Ship 1 community-requested quick win; reply to all issues"

note "$([ $APPLY -eq 1 ] && echo 'Done — board seeded.' || echo 'Dry run complete. Re-run with --apply to create.')"
