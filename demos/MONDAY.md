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
| 2 | Runbook/tutorial command defects fixed | PASS | commit `ce483135` — `config export` default + `-p` shorthands | 2026-08-29 |
| 3 | `--env` matrix shared-Fabric hole fixed | PASS | `planFabricPlacement` + `tests/lib/queries/fabric-placement.test.ts` | 2026-08-29 |
| 4 | Corrected 5-env runbook written | PASS | `demos/RUNBOOK.md` | 2026-08-29 |
| 5 | Elench prompt pack written | PASS | `demos/elench-prompts.md` — Blocks 1–3 outputs are real runs | 2026-08-29 |
| 5a | MCP OAuth discovery broken in prod | FAIL | [#3318](https://github.com/alethialabs-io/alethialabs/issues/3318) — found by probing, Block 4 carries the caveat | 2026-08-29 |
| 6 | AWS ladder proof attempted | **BLOCKED** | [#3348](https://github.com/alethialabs-io/alethialabs/issues/3348) — the prod runner is `self` with no ambient AWS creds; the PLAN job fails before tofu runs | 2026-08-29 |
| 6a | Azure plan on the SAME runner | PASS | job `0d9850b1` — keyless federated identity activated, tofu init clean. Azure/Alibaba/token clouds have no operator gate | 2026-08-29 |
| 6b | Elench gate could never pass its own templates | FIXED | `terraform_data` denied SCOPE-001 on all 5 clouds; every committed receipt shows it | 2026-08-29 |
| 7 | Isolation ladder proven (cloud TBD — Azure is the only unblocked one) | | | |
| 8 | Isolation ladder proven on a second cloud | | | |
| 9 | Browser pass — signed-in surface (overview · clusters · new project) | PASS | `demos/monday-evidence/20260829-new-project-placement-defaults.png`; 2 defects found → rows 9a/9b | 2026-08-29 |
| 9a | Overview "Recent jobs · last 24h" showed month-old jobs | FIXED | commit `c645c8d2` — no time window exists anywhere; label now "latest 5" | 2026-08-29 |
| 9b | New-project default shape hits the orphan-Fabric bug on PROD | CONFIRMED | screenshot: production+staging `Dedicated`, dev+preview `Namespace` — needs M2 to reach prod | 2026-08-29 |
| 9c | Drift detection dead on a prod env for 5+ weeks | FAIL | [#3351](https://github.com/alethialabs-io/alethialabs/issues/3351) — 5 weekly FAILEDs are the first thing on the org overview | 2026-08-29 |
| 10 | Browser pass — signed-in to Deploy CTA | | | |
| 11 | Browser pass — full provisioning journey | | | |
| 12 | Browser pass — post-deploy day-2 surfaces | | | |
| 13 | `enterprise-demo` overlays PR | | | |
| 14 | Hetzner Robot warm-pool issue filed | PASS | [#3321](https://github.com/alethialabs-io/alethialabs/issues/3321) — held against the #3268 NO-GO | 2026-08-29 |
| 15 | Timed dress rehearsal + abort drill | | | |

**Spend to date: $0.00.** (One unplanned event: the sandbox box was OOM-wedged and rebooted — see
R4a. No cloud spend, but it cost the other instance's env for ~10 minutes.)

---

## §3 · Needs the maintainer

Things no agent session can do. Keep this list short and current — it is read on Sunday and acted on
once.

| # | What | Why it cannot be done here | Status |
|---|---|---|---|
| M1 | Sign in to alethialabs.io in Chrome | The OTP goes to your email; an agent cannot read it. | **DONE** — a live session was already present 2026-08-29 (org `tovr`, HOBBY plan). If it lapses, sign in again and the passes resume. |
| M2 | Promote `dev → staging → main` | Prod serves `main`; `Deploy Console` fires on push there. | **OPEN — now load-bearing.** Prod carries the orphan-Fabric bug (row 9b) and the false "last 24h" label. Without the promotion, a project created through the console's DEFAULT template on alethialabs.io still cannot deploy its `dev`/`preview` tiers. |
| M3 | Confirm the AWS account + Hetzner project to demo from | Hetzner tokens are project-scoped and can do anything in that project; do not demo from the project the sandbox box lives in. | OPEN |
| M4 | Confirm the runner placement | Assumed: a registered runner on the existing sandbox box (zero new spend). | SUPERSEDED by M5 |
| M5 | **Decide how the demo gets a runner that can provision AWS** | #3348: the prod runner is `self`, so AWS and GCP cannot federate. Either set `ALETHIA_RUNNER_OPERATOR=managed` on the control-plane runner (a security decision — it lets that VM mint assertions into customer roles), or stand up a fleet pool, or demo on **Azure**, which works today. | **OPEN — blocks any AWS demo** |
| M7 | **Connect Hetzner** — one command, then the ladder proof is unblocked | Hetzner is token-based (`ActivateTokenCloud`), so it has **no operator gate** and is not affected by #3348. It is the cheapest path to the proof (~€0.10/hr). The agent is blocked from handling the token itself. Run, using the `alethia-e2e` project (it is empty — the runbook says never demo from the project the sandbox box lives in):<br>`hcloud context use alethia-e2e`<br>`hcloud context active` → then paste that project's token:<br>`alethia connector hetzner --token-stdin` | **OPEN — cheapest unblock** |
| M6 | Merge `enterprise-demo` PR #6 | The overlays PR targets `main` in a single-branch repo; the merge guard refuses `main` from an agent session. | OPEN — needed only for the 5-tier shape |

---

## §4 · Open risks

- **R1 · FIXED on `feat/monday-demo`, not yet on prod.** The `--env` matrix used to create one Fabric
  per `dedicated` env plus an orphan Fabric named `"shared"` for every `namespace`/`vcluster` env —
  one no environment owned, so `deploy_namespace.go` failed closed on everything placed there. The
  headline command in both `demos/RUNBOOK.md` and the customer-facing tutorial built a project that
  could never apply. `planFabricPlacement` now hosts shared placements on a dedicated env's Fabric and
  refuses a matrix with no dedicated env at all.
  **Still open:** this is on `dev` only. Until M2 promotes it, **alethialabs.io still has the bug** —
  so if a browser pass creates a project through the console's default catalog (production+staging
  dedicated, dev+preview namespace), the two namespace tiers will land on an orphan Fabric. Create
  demo projects with an explicit dedicated env until the promotion lands.

- **R0 · Nothing can provision on AWS or GCP in production (#3348).** The deployed runner runs as
  `self` (`docker-compose.yml` sets `ALETHIA_RUNNER_MODE: self-hosted`) and has no ambient cloud
  credentials, so `AssumeRole` falls through to EC2 IMDS and 404s. **Azure, Alibaba and the token
  clouds are unaffected** — they have no operator gate and always federate keylessly, which a live
  Azure plan on the same runner confirmed. There are also **no fleet pools**, so no managed runner
  exists to claim the job instead. This is the single biggest risk to Monday and it needs a
  maintainer decision (see M5).

- **R2 · `namespace` and `vcluster` placement have never run on a real cloud.**
  Every committed bundle in `demos/proofs/*/*/summary.txt` reads `fabric-demo: n/a`. Only `dedicated`
  is proven. The isolation ladder is the demo, and it is the unproven part — which is why rows 6–8
  come before everything cosmetic.

- **R3 · Fixes need a promotion to reach the demo surface.** See M2.

- **R4a · Two concurrent `pnpm install`s OOM the box.** 2026-08-29: running an install in
  `/opt/alethia/scratch` while `env:check` installed in `/opt/alethia/envs` exhausted the box's 16 GB
  (an env alone needs 5–7). It stayed `running` in hcloud but answered no ping and no SSH, and took
  the other instance's env down with it. Recovered with `hcloud server reboot 163787940` — but note
  `hcloud` has **no active context by default**; `hcloud context use alethia-sandbox` first, or you
  will be looking at a different project's servers and conclude the box is gone.
  **Run one install at a time on the box.**

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
