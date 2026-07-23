---
name: decompose
description: Turn a maintainer-authored feature/wave spec into a well-formed GitHub-Issues coordination board — an interface-first seams issue plus disjoint-scope lane issues — as a dry-run proposal the maintainer approves before any issue is created. Use when a maintainer wants to decompose a wave/feature spec onto the board, "seed the board", "break this spec into issues", or bootstrap a wave.
license: MIT
metadata:
  author: alethia
  source: alethialabs-io/skills (mirror the source-of-truth per .claude/skills/README.md)
  version: "1.0.0"
---

# Decompose a spec into a claimable board

Decomposition used to be 100% manual: the maintainer hand-authored the seams issue and every fine
lane, and hand-checked that no two claimable units shared a `scope:` glob. This skill does the draft
+ the mechanical check, then **hands a proposal back to the maintainer to approve** — the maintainer
keeps the judgement call, gets the typing time back. Read `.claude/COORDINATION.md` first (§"The board
(hybrid)", §"The two work classes", §"Bootstrapping a wave") — this skill emits exactly that contract.

**Never create issues before the maintainer approves the dry-run proposal.** The flow is
draft → validate → show → WAIT → (on approval) seed.

## 1. Read the spec

The input is a maintainer's feature/wave design doc — usually in the private **`dataroom`** repo under
`spec/features/`, or a doc pasted into the conversation. Identify:

- **The wave** it belongs to (`wave:W1`…`wave:W7`, or `wave:hygiene`) — the doc or `00-NORTH-STAR.md`
  says which.
- **The shared contract** — the types / DB schema / interface every lane depends on. This becomes the
  single **seams** issue.
- **The independent lanes** — server actions, runner, core/tofu, canvas, tests, docs — each owning a
  **disjoint** set of files. These become the fine issues, each `blocked-by:` the seams issue.

If the spec is thin or ambiguous, **grill it first** (the `grilling` skill) — a vague spec decomposes
into overlapping lanes, which is exactly the tangle this board prevents.

## 2. Draft the proposal (interface-first)

Produce a JSON array of proposed issues — the shape the validator consumes. One **seams** unit (title
says "seams", empty `blockedBy`), then fine lanes each `blockedBy` the seams unit, each with a
**disjoint** `scope`:

```json
[
  {
    "id": 1,
    "title": "seams: project_placement shared types + schema contract",
    "labels": ["wave:W1", "lane:schema", "class:backend"],
    "scope": ["apps/console/lib/db/schema/project_placement.ts", "apps/console/types/jsonb.types.ts"],
    "blockedBy": []
  },
  {
    "id": 2,
    "title": "placement server actions",
    "labels": ["wave:W1", "lane:server", "class:backend"],
    "scope": ["apps/console/app/server/actions/placement/**"],
    "blockedBy": [1]
  },
  {
    "id": 3,
    "title": "placement canvas node config sheet",
    "labels": ["wave:W1", "lane:canvas", "class:ui"],
    "scope": ["apps/console/components/canvas/placement/**"],
    "blockedBy": [1]
  }
]
```

Rules the validator enforces (get them right up front):

- **One seams issue, `class:backend`, no `blocked-by`.** It lands fast so every lane unblocks. It owns
  the shared types/schema/contract — nothing else does.
- **Every lane is `blocked-by:` the seams issue** (reference it by its proposal `id`; the validator
  rewires these to real issue numbers on seed).
- **Disjoint scopes.** No two **co-claimable** units (siblings — neither blocks the other) may share a
  file glob. A lane may narrow a file the seams issue also owns (they are never claimable at once), but
  two sibling lanes must never overlap. Split by resource group / directory — `lib/db/schema/foo.ts`,
  `app/server/actions/foo/**`, `internal/agent/foo/**`, `components/.../foo/**`.
- **Correct labels** from the board set: one `wave:*`, one `class:*`, and a `lane:*`
  (`schema`/`server`/`runner`/`core`/`canvas`/`tests`/`docs`). Add `mutex:migration` to the single lane
  that runs `pnpm -F console db:generate`. Do NOT set `claimed`/`blocked` — those are runtime labels.
- **Routing:** infra/backend work is `class:backend` (autonomous). Anything visual is `class:ui` — its
  deliverable is a data-model-grounded **design spec** (per `alethia-design`), human-gated, not an
  autonomous merge. Because the backend lanes define the model first, UI specs always have a stable
  model to consume.

## 3. Validate — refuse to seed on any collision

Pipe the proposal through the validator. It checks the anti-tangle invariant (no two co-claimable units
share a scope glob — overlap/prefix-subsumption, not just exact match), that every non-seams unit has a
`blocked-by`, that labels are from the known set, and that the `blocked-by` graph is acyclic:

```
echo "$PROPOSAL_JSON" | node scripts/decompose-validate.mjs
# or: node scripts/decompose-validate.mjs proposal.json
```

**If it prints `✗ FAIL`, do NOT seed.** Fix the proposal (split the overlapping scopes into disjoint
lanes, add the missing `blocked-by`, correct the label) and re-validate until it prints `✓ PASS`. The
validator is the same guard a human would run by eye — a failure means the board would tangle.

## 4. Show the maintainer and WAIT

Present the full proposal for approval — do not create anything yet. Show:

- Each unit's **title · labels · scope globs**.
- The **blocked-by DAG** (seams at the root; lanes hanging off it).
- The validator's `✓ PASS` line.

Then **stop and wait for explicit approval.** The maintainer may re-scope a lane, re-label, or split
one further — re-validate after any edit. This is the human judgement the skill preserves.

## 5. Seed (only on approval)

Once the maintainer approves, ensure the labels exist and create the issues — **seams first**, capture
its number, then the lanes referencing that real number:

```bash
scripts/coordinate.sh --init-labels        # idempotent; ensures the board label set exists

# Seams issue first — no blocked-by. Capture its number.
SEAMS=$(gh issue create \
  --title "seams: project_placement shared types + schema contract" \
  --label "wave:W1" --label "lane:schema" --label "class:backend" \
  --body "$(cat <<'EOF'
<one-line intent; link the wave doc>

Wave doc: dataroom spec/features/<doc>.md

scope: apps/console/lib/db/schema/project_placement.ts apps/console/types/jsonb.types.ts
EOF
)" | grep -oE '[0-9]+$')

# Each lane — blocked-by the seams number, disjoint scope.
gh issue create \
  --title "placement server actions" \
  --label "wave:W1" --label "lane:server" --label "class:backend" \
  --body "$(cat <<EOF
<one-line intent>

Wave doc: dataroom spec/features/<doc>.md

blocked-by: #$SEAMS
scope: apps/console/app/server/actions/placement/**
EOF
)"
# … repeat per lane; class:ui lanes also carry --label "needs:design".
```

The issue **body** must carry the two machine-read lines exactly (this is what `claim-work.sh` and
`coordinate.sh` parse):

- `blocked-by: #<n> #<n>` — the seams issue (and any other prerequisites). Omit on the seams issue.
- `scope: <glob> <glob>` — the disjoint file globs this unit owns.

After seeding, run `scripts/coordinate.sh` once so it computes the `blocked` labels from each
`blocked-by:` line (lanes show `blocked` until the seams issue closes). Then merge the seams issue fast
→ downstream unblocks → instances `scripts/claim-work.sh` and go.

## Alethia notes

- **Provenance:** skills are mirrored from `alethialabs-io/skills` (see `.claude/skills/README.md`) —
  land durable edits there and `bash scripts/sync-skills.sh` back, so every worktree/instance loads the
  same version.
- **This operationalizes** the "wayfind / never start coding without a plan" working-discipline rule and
  the `.claude/COORDINATION.md` bootstrap — the board **is** the wayfinder; this skill fills it.
- **The invariant is load-bearing.** A single shared `scope:` glob between two claimable units is how the
  mega-commit tangle happened (the "Shared-checkout entanglement" incident — one `git add -A` swept three
  features into one commit). The validator exists so a bad board is caught before it is seeded, not after.
