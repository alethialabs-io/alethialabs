<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# The Monday demo — programme ledger

**Demo: Monday 2026-08-31, 10:00. Audience: one programmer, screen share.**

This file is the entry point for every session working the demo. It exists for the same reason
[`PROGRAMME.md`](../PROGRAMME.md) exists: the work spans more context than one session holds, and
re-deriving the state by exploring the tree produces a second, unreviewed answer that disagrees with
this one.

**It ranks and it records. It never claims.** A row in §2 is a claim only when it names an artifact
that exists in the tree.

---

## §0 · Resume protocol — run these before anything else

```bash
git -C /Users/borislavborisov/work/Alethia/app pull --ff-only   # hooks + CLAUDE.md load from there
cat demos/MONDAY.md                                             # this file: state, then next
pnpm wt:who                                                     # ~160 worktrees live; do not collide
ls demos/monday-evidence/                                       # what has actually been proven
```

Then take the **first row in §2 with no verdict** and do that. Do not re-plan, do not re-explore, do
not pick a different row because it looks easier.

**The discipline that makes a context clear free:** update §2 *before* the context fills, not after.
A row written after the fact is a row written from memory, and memory is what this file replaces.

Work happens in `../wt-monday-demo` (branch `feat/monday-demo`). Never commit in `app/`.

---

## §1 · The spec

### The topology

Five environments, two isolation ladders, one project. This is the whole pitch: **the isolation level
is a placement decision, not a procurement decision.**

| Environment | Stage | Placement | Namespace | Lands on |
|---|---|---|---|---|
| `prod` | production | `dedicated` | — (owns the Fabric) | Fabric `prod` |
| `staging` | staging | `vcluster` | `boutique-staging` | Fabric `platform` |
| `dev-1` | development | `namespace` | `boutique-dev-1` | Fabric `platform` |
| `dev-2` | development | `namespace` | `boutique-dev-2` | Fabric `platform` |
| `dev-3` | development | `namespace` | `boutique-dev-3` | Fabric `platform` |

**Headline shape (2 Fabrics):** `prod` alone on its own cluster; `platform` owns a second cluster that
carries staging and the three dev tiers. Two clusters, five environments, four isolation levels.

**Fallback shape (1 Fabric):** drop the `platform` env; `prod` owns the only Fabric and everything
else attaches to it with `--fabric prod`. One cluster, five environments. Cheaper, faster, and it is
arguably the sharper pitch — but it means "prod is isolated" is no longer true, so do not say it.

### The rule that makes both shapes work

A `dedicated` environment **owns** a Fabric and is the only thing that can bring a cluster into
being. A `namespace` or `vcluster` environment must be placed onto a Fabric whose cluster **already
exists**. So the order is always: create with a dedicated env → `plan` → `apply` → *then*
`project env add … --fabric <that fabric>` for the shared tiers.

The `--env` matrix on `project create` **cannot** express this (see §4, R1). Use `project env add`.

### Clouds

- **AWS** — `us-east-1`, EKS, `t3.xlarge`. ~18 min to a cluster, ~$0.60/hr per Fabric. The headline.
- **Hetzner** — `nbg1`, Talos on hcloud VMs. ~12 min to a cluster, ~€0.10/hr. Rehearsals, and the
  second-cloud beat.

### Budget

**~$20 authorised for the whole weekend.** Rehearse on Hetzner, spend on AWS only where it buys
something the demo needs. Teardown is verified in the cloud after every pass, not assumed from the
CLI — NAT gateways and load balancers survive a partial destroy and keep billing.

Running spend is tracked in §2. If it passes $15, stop and say so.

### Surface

Demo on **alethialabs.io** (serves `main`). A sandbox `dev` env is the hot spare, because a fix that
lands on `dev` does not reach prod without a maintainer-run `dev → staging → main` promotion.

---

## §2 · Live state

Append-only. Never rewrite a row; add a superseding one that names what it replaces and why.

Verdicts: `PASS` (artifact exists) · `FAIL` (artifact exists, shows the failure) · `BLOCKED` (names
the blocker) · *(blank)* = not yet attempted.

| # | Pass | Verdict | Evidence | When |
|---|---|---|---|---|
| 1 | Ledger + worktree stood up | PASS | `demos/MONDAY.md` (this file) | 2026-08-29 |
| 2 | Runbook/tutorial command defects fixed | | | |
| 3 | `--env` matrix shared-Fabric hole: issue filed + fix | | | |
| 4 | Corrected 5-env runbook written | | | |
| 5 | Elench prompt pack written | | | |
| 6 | Isolation ladder proven on Hetzner (1 Fabric) | | | |
| 7 | Isolation ladder proven on Hetzner (2 Fabrics) | | | |
| 8 | Isolation ladder proven on AWS | | | |
| 9 | Browser pass — anonymous surface | | | |
| 10 | Browser pass — signed-in to Deploy CTA | | | |
| 11 | Browser pass — full provisioning journey | | | |
| 12 | Browser pass — post-deploy day-2 surfaces | | | |
| 13 | `enterprise-demo` overlays PR | | | |
| 14 | Hetzner Robot warm-pool issue filed | | | |
| 15 | Timed dress rehearsal + abort drill | | | |

**Spend to date: $0.00.**

---

## §3 · Needs the maintainer

Things no agent session can do. Keep this list short and current — it is read on Sunday and acted on
once.

| # | What | Why it cannot be done here | Status |
|---|---|---|---|
| M1 | Sign in to alethialabs.io in Chrome | The OTP goes to your email; an agent cannot read it. Blocks every authenticated browser pass. | **OPEN — blocks passes 10–12** |
| M2 | Promote `dev → staging → main` | Prod serves `main`; `Deploy Console` fires on push there. Any fix from §2 that must appear in the demo needs this. | OPEN — decide Sunday |
| M3 | Confirm the AWS account + Hetzner project to demo from | Hetzner tokens are project-scoped and can do anything in that project; do not demo from the project the sandbox box lives in. | OPEN |
| M4 | Confirm the runner placement | Assumed: a registered runner on the existing sandbox box (zero new spend). | OPEN |

---

## §4 · Open risks

- **R1 · The `--env` matrix builds an unprovisionable project.**
  `apps/console/lib/queries/projects.ts` creates one Fabric per `dedicated` env plus a single Fabric
  literally named `"shared"` for every `namespace`/`vcluster` env — and a `dedicated` env always gets
  a Fabric named after *itself*, so it can never own `"shared"`.
  `packages/core/provisioner/deploy_namespace.go` then fails closed: *"the Fabric's cluster must be
  provisioned (a 'dedicated' env owning the Fabric) before a namespace env can be placed onto it."*
  **Consequence:** the headline command in `demos/RUNBOOK.md` §2 and in the customer-facing
  `enterprise-demo.mdx` Step 1 produces a project that can never apply, and the tutorial's claim that
  "dev is the tier that brings the cluster into being" is false. Tracked as row 3.

- **R2 · `namespace` and `vcluster` placement have never run on a real cloud.**
  Every committed bundle in `demos/proofs/*/*/summary.txt` reads `fabric-demo: n/a`. Only `dedicated`
  is proven. The isolation ladder is the demo, and it is the unproven part — which is why rows 6–8
  come before everything cosmetic.

- **R3 · Fixes need a promotion to reach the demo surface.** See M2.

- **R4 · The sandbox box is shared and reapable.** Idle is measured from *environment* last-seen, so a
  box holding only a runner reaps on the first tick. The reaper must be off for the demo window.

- **R5 · A vcluster is not a hard workload boundary.** `packages/core/provisioner/vcluster.go` says so
  explicitly. It is a control-plane boundary. Say that on stage — being precise about the one thing
  that is not a hard boundary is what makes the rest credible.

---

## §5 · Where things live

| Thing | Path |
|---|---|
| The talk track and beats | [`demos/RUNBOOK.md`](./RUNBOOK.md) |
| Customer-facing tutorial | `apps/docs/content/docs/tutorials/enterprise-demo.mdx` (+ per-cloud pages) |
| Elench prompt pack | [`demos/elench-prompts.md`](./elench-prompts.md) |
| Browser + CLI pass evidence | `demos/monday-evidence/` |
| Real-apply proof bundles | `demos/proofs/<cloud>/<stamp>/` |
| The demo application | <https://github.com/alethialabs-io/enterprise-demo> |
| Placement model | `apps/docs/content/docs/concepts/fabrics-and-placement.mdx` |

**Do not quote `demos/DEMO-READINESS.md`** — it is a superseded historical ledger and says so itself.
