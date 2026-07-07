<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Elench — Agent Harness & Verification Layer

**Elench** (Greek _elenchus_ — proof by cross-examination) is Alethia's verification layer and
agent harness. The thesis: don't just generate infrastructure — **prove what it does**. Every change,
human- or agent-initiated, runs through a deterministic gate and leaves a signed evidence receipt;
drift re-checks keep proving it after apply.

This document is the map. Deep detail lives in `packages/core/verify/README.md`,
`packages/core/drift/README.md`, and `apps/console/lib/ai/TOOLS.md`.

---

## Positioning (the honest claim)

> A self-hostable, zero-trust BYOC control plane that provisions your infra **and gives you a signed,
> per-apply evidence receipt of what was checked** — and keeps re-checking it — open to your own agents.

Lead with the **receipt**, not the run (generation/OPA/drift are table-stakes; the verifiable
provision-time receipt + bring-your-own-agent combination is the differentiator). Keyless/least-privilege
are *reported* hygiene facts, not over-claimed proofs. Verdicts are "reproducible **given the same
plan**", never "proof of compliance" (that needs an auditor). See the architecture plan for the full
research- and red-team-backed rationale.

---

## Architecture at a glance

```
 consumers:  in-app agent UI   Claude Code / ChatGPT / Codex / Gemini (via MCP)
                  │ native AI SDK            │ remote MCP (read-only)
            ┌─────▼──────────────────────────▼─────┐
            │ tool registry SSOT (audience-scoped)  │   lib/ai/tools/registry.ts
            └─────┬──────────────────────────┬──────┘
                  │ calls                     │ projects to
            PDP-gated server actions   read-only MCP route (app/api/mcp/route.ts)
                  │
            ┌─────▼───────────────────────────────────────────┐
            │ VERIFICATION ENGINE (packages/core/verify)        │
            │  Evaluate(plan) → Report  ── fail-closed gate     │
            │  controls: AWS · GCP · Azure  + Access Analyzer   │
            │  signed receipt · override/exception · ReVerify   │
            └─────┬───────────────────────────────┬────────────┘
                  │ runs in                        │ feeds
            Go runner (deploy.go: plan→VERIFY→apply)   console Plan tab
                  │
            drift (packages/core/drift): plan -refresh-only → Posture
```

---

## What's implemented (and tested)

### Verification engine — `packages/core/verify`
- **Deterministic gate** over the OpenTofu plan JSON, run between `tofu plan` and `tofu apply` in
  `provisioner.RunDeployV2`. **Fail-closed**: a hard control failure blocks apply unless an authorized
  `verify.Override` waives it. Honest `not_evaluable` for anything the plan can't show (computed bodies,
  managed-policy-by-ARN) — never a silent pass.
- **Controls (catalog `elench-controls-0.1.0`), provider-selected:**
  - AWS — `KEYLESS-001`, `OIDC-001` (rejects `StringLike` wildcard `sub`), `LEASTPRIV-001`.
  - GCP — `GCP-KEYLESS-001`, `GCP-WIF-001`, `GCP-LEASTPRIV-001`.
  - Azure — `AZURE-KEYLESS-001`, `AZURE-FED-001`, `AZURE-LEASTPRIV-001`.
  - `ACCESS-ANALYZER-001` (opt-in) — AWS IAM Access Analyzer automated-reasoning corroboration.
- **Signed evidence receipt** — `verify.Receipt` + ed25519 `SignedReceipt`; offline `Verify`;
  tamper-evident; records exceptions. Key via `ALETHIA_RECEIPT_SIGNING_KEY`; unsigned fallback.
- **AI remediation, safely** — `ReVerify` (a candidate fix is accepted only if it resolves the failures
  with no regression) + `RunRemediationLoop` (bounded; the LLM + re-plan are an injected `Remediator`).
- **CLI** — `cmd/elench-verify`: `tofu show -json plan | elench-verify` (exit 2 on block) for CI / the
  corpus go/no-go measurement.

### AI-audit, safely (LLM = explain/propose; the gate decides)
- `ReVerify` / `RunRemediationLoop` (above) gate any proposed fix.
- `lib/ai/explain-findings` — turns failing controls into plain-English explanation + suggested
  remediation via an **injected** model call (unit-tested with a fake; `explainJobFindings` supplies
  the real AI-gateway call). The model is advisory; malformed output degrades to a generic message.
- `lib/agent/executor` — the agent stateless-executor core: builds a scoped system prompt from an
  `agent_identities` row (persona/mission) and narrows the tool set to the agent's `tool_scope`
  (least privilege per agent). The turn itself is run by the AI SDK with memory loaded just-in-time.

### Drift — `packages/core/drift`
- `Analyze(plan)` turns a `plan -refresh-only -json` into a per-env `Posture` (in_sync / drifted / kind).
  Honest `UnmanagedKnown=false` (refresh-only can't see unmanaged resources).

### Tool exposure — `apps/console/lib/ai/tools` + `app/api/mcp/route.ts`
- **Registry SSOT** classifies every tool by **audience** (`in-app` / `external` / `both`) with an
  anti-drift test. `buildExternalAgentTools()` is the read-only projection.
- The **remote MCP route** (OAuth 2.1 via Better Auth + actor binding) serves that projection — HITL,
  canvas, and job-queuing writes (`scan_repo`) never reach an external agent.

### Surfacing
- Runner forwards `verify_result` + `verify_receipt` on `execution_metadata`; the console renders
  per-control results + a downloadable receipt in the agent **Plan tab**.

---

## How to run / test

```bash
# Verification engine (unit + override + receipt + remediation + multi-cloud; race-clean)
go test ./packages/core/verify/... ./packages/core/drift/...

# Run the gate on a real plan (CI / measurement)
go build -o elench-verify ./packages/core/verify/cmd/elench-verify
tofu show -json tfplan | ./elench-verify           # exit 2 if it blocks

# Phase-0 go/no-go over a real corpus (needs your plans)
ELENCH_CORPUS_DIR=/path/to/plan-jsons go test ./packages/core/verify -run TestCorpus -v
#   add labels.json {"file.json":"pass"|"fail"} to get false-PASS / false-DENY rates

# Tool registry + MCP route composition (read-only surface)
pnpm -F console exec vitest run tests/lib/ai

# Enable Access Analyzer corroboration on AWS apply jobs (needs AWS creds at runtime)
export ALETHIA_VERIFY_ACCESS_ANALYZER=1
```

---

## Status & what remains

| Phase | Item | State |
|-------|------|-------|
| 0 | Gate-correctness (AWS/GCP/Azure controls, fail-closed, CLI) | **Done, tested** |
| 1 | Signed receipt; override **enforcement** (`Unwaived`) | **Done, tested** |
| 1 | Override **authorization** — `recordVerifyOverride` (PDP-gated) → `jobs.verify_override` (migration 0043) → runner `buildVerifyOverride` → gate | **Done, tested** |
| 2 | Registry SSOT + read-only MCP route | **Done, tested** |
| 2 | Drift **core** (`Analyze`) | **Done, tested** |
| 2 | Drift **end-to-end** — `DETECT_DRIFT` (migration 0044) → `tofu PlanRefreshOnly` → `RunDriftDetection` → runner → `execution_metadata.drift_posture`; `detectDrift` action; tiered **scheduler** (`lib/drift/schedule` + `dispatch`) + cron route (`/api/internal/drift/sweep`, `ALETHIA_CRON_SECRET`) | **Done, tested** (only the platform cron trigger is ops config) |
| 3 | `ReVerify` + `RunRemediationLoop` + Access Analyzer seam/control/adapter | **Done, tested** |
| 3 | AI-audit **explanation** (`lib/ai/explain-findings` + `explainJobFindings` action) + agent **executor core** (`lib/agent/executor`: system prompt + per-agent tool scoping) | **Done, tested** (injected model) |
| 3 | Agent runtime — CRUD actions (`createAgent`/`listAgents`/`getAgent`) + **agent-scoped chat route** (`/api/agent/[agentId]`, reuses the tested executor core + memory namespace) | **Done** (integration code at codebase parity; cores unit-tested) |
| 3 | LLM `Remediator` impl (the re-plan call) + live Access Analyzer exercise / customer-TF sandbox audit | Pending — needs LLM/AWS/sandbox runtime |
| 3 | Agent identity/memory **data layer** — `agent_identities` + `agent_memory` tables (migration 0045) + tenant-isolation path guard (`lib/agent/memory-path.ts`) | **Done, tested** (the stateless executor on top needs an LLM) |
| 4 | Supervisor / colony — `lib/agent/supervisor` (Magentic ledger + delegation + stall→re-plan) **+ LLM sub-agent runner** (`lib/agent/llm-subagent`) **+ live `runColonyTasks` action** | **Done, tested** (11 tests; live model call is the AI SDK's, logic tested via injected fakes) |

**Live integrations exercised against real services ✅** (all gated, skipped in normal CI):
- **LLM / agent / colony** — `tests/lib/agent/llm-live.test.ts` (`ELENCH_LIVE=1`): supervisor → LLM
  sub-agent runner → **real Claude model** → parse → completion. Passed (Claude returned valid JSON,
  task marked done). Same path as `runColonyTasks` / agent chat route / explanation action.
- **AWS IAM Access Analyzer** — `packages/core/accessanalyzer/analyzer_live_test.go` (`ELENCH_LIVE_AWS=1`):
  **real `CheckAccessNotGranted` API** via the adapter. Passed (admin policy → grants
  `[iam:CreateAccessKey kms:Decrypt]`; scoped policy → grants none).
- **Verify gate on a real OpenTofu plan** — generated `tofu plan` of an admin IAM policy →
  `tofu show -json` → `elench-verify` → **blocked** (`LEASTPRIV-001`, exit 2); the fixed (scoped)
  plan → **pass** (exit 0).
- **Remediation re-verify on real plans** — `packages/core/verify/remediate_live_test.go`
  (`ELENCH_PLAN_BAD`/`ELENCH_PLAN_FIXED`): `ReVerify(bad, fixed)` over two real tofu plans → resolved
  `LEASTPRIV-001`, `accepted=true`.

Not exercised here: only the full runner *provisioning job loop* (claim → execute → deploy a real
cluster), which requires a live multi-minute cloud deployment with the runner daemon + state backend —
an operational deployment, not a test. Every component it composes (verify gate, drift, receipts) is
exercised above against real tofu output.

All three **schema-bearing items are now implemented and tested** — migrations 0043 (override),
0044 (drift job type), 0045 (agent identity/memory) were hand-authored idempotent (the documented
0039/0041/0042 precedent, since `db:generate` is blocked by unrelated working-tree drift) and each
**validated by applying in an isolated throwaway Postgres**. What remains needs an external runtime
or is ops/by-design:
- **Agent stateless executor**: the LLM loop that loads persona+memory (data layer + isolation guard
  done) and runs a turn. Needs `AI_GATEWAY_API_KEY`.
- **LLM remediation**: implement `verify.Remediator` (propose a fix via the AI gateway → re-plan →
  return the candidate plan); `RunRemediationLoop` already gates acceptance. Needs `AI_GATEWAY_API_KEY`.
- **Live Access Analyzer**: already wired (`ALETHIA_VERIFY_ACCESS_ANALYZER=1`); needs an AWS role with
  `access-analyzer:CheckAccessNotGranted` at runtime to exercise end-to-end.
- **Supervisor/colony**: frozen by plan A4 until a metered parallel-read case exists.

(The drift scheduler is now built; only the platform cron that POSTs `/api/internal/drift/sweep` on a
cadence is deployment config.)

---

## Engine notes
- The verify engine is **pure-Go** behind an engine-agnostic `Evaluate` seam (builds/tests offline);
  OPA/Rego bundles (customer-authorable controls) can swap in behind the same `Report` contract.
- The pure `verify` package carries **no cloud SDK**; the AWS Access Analyzer client lives in
  `packages/core/accessanalyzer` and is injected via `verify.EvaluateWithOptions`.
