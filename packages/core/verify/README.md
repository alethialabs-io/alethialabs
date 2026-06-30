<!--
SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# `verify` — the elench verification gate (Phase 0)

The deterministic policy gate that runs **between `tofu plan` and `tofu apply`** in the
provisioner. It evaluates the OpenTofu **plan JSON** against a small set of authored
security controls and produces a structured, honest `Report`.

This is the engineering core of Alethia's "proof, not just generation" headline: a real
apply is **fail-closed** — it will not run while a hard control is failing — and every
result is per-control, named, and versioned, so it can later be sealed into a signed
evidence receipt (Phase 1).

## Why "honest" is load-bearing

A plan JSON does **not** contain everything. Policy bodies can be computed (`after_unknown`)
until apply; AWS-managed policies are referenced only by ARN (no body in the plan); a role
or policy created in a *different* state/module is invisible here. The cardinal rule of this
package: **never report a pass on something we could not inspect.** Such cases are reported as
`not_evaluable` with a plain-language `coverage` note. A silent pass on an un-inspectable
resource is exactly the false-PASS the verification claim must never make.

## Controls (catalog `elench-controls-0.1.0`)

`Evaluate` detects the plan's cloud and runs that provider's control set (a mixed/unknown plan runs
all of them, so nothing is silently skipped). Each control records its `provider` so a uniform UI can't
imply coverage a control doesn't have.

**AWS**

| ID | Title | Hard-fail on |
|----|-------|--------------|
| `KEYLESS-001` | No static IAM access keys | creating an `aws_iam_access_key` (use OIDC federation instead) |
| `OIDC-001` | Federated trust bound to a specific subject | a federated (`sts:AssumeRoleWithWebIdentity`) role whose trust **lacks a `:sub` condition**, or binds `sub` only with a **`StringLike` wildcard** (the "any repo can assume" footgun) |
| `LEASTPRIV-001` | No over-broad IAM grants (named patterns) | `Action:"*"` + `Resource:"*"`; `Allow` + `NotAction`; attaching `AdministratorAccess`/`PowerUserAccess`/`IAMFullAccess`. **Warns** on sensitive service wildcards (`iam:*`,`kms:*`,…) with `Resource:"*"`. **Not-evaluable** when the policy body is computed or only referenced by ARN. |

**GCP**

| ID | Title | Hard-fail on |
|----|-------|--------------|
| `GCP-KEYLESS-001` | No static service-account keys | creating a `google_service_account_key` (use Workload Identity) |
| `GCP-WIF-001` | WIF providers are attribute-conditioned | a `google_iam_workload_identity_pool_provider` with an empty `attribute_condition` |
| `GCP-LEASTPRIV-001` | No project-wide primitive roles | binding `roles/owner` (fail) — **warns** on `roles/editor` — via `google_project_iam_member`/`_binding` |

**Azure**

| ID | Title | Hard-fail on |
|----|-------|--------------|
| `AZURE-KEYLESS-001` | No static app/SP secrets | creating an `azuread_application_password`/`azuread_service_principal_password` (use a federated identity credential) |
| `AZURE-FED-001` | Federated credentials bind a subject | an `azuread_application_federated_identity_credential` with an empty or wildcard `subject` |
| `AZURE-LEASTPRIV-001` | No Owner/Contributor assignments | an `azurerm_role_assignment` of `Owner` (fail) — **warns** on `Contributor` — scope annotated |

Statuses: `pass` · `fail` (blocks apply) · `warn` (recorded, does not block) · `not_evaluable`.
Overall verdict precedence: `fail` → `warn` → `not_evaluable` → `pass`.

### Known blind spots (stated, not hidden)

- Computed (`after_unknown`) policy/trust bodies → `not_evaluable`.
- AWS-managed (non-admin) policies attached by ARN → coverage gap (body not in plan).
- Resources created in another state/module, permission boundaries, and SCPs are out of view.
- **AWS is deepest** (policy-body inspection, Access-Analyzer corroboration planned). GCP/Azure cover
  the static-credential, federation-binding, and primitive-role/owner cases; `provider` on each control
  and the report makes the per-cloud coverage explicit so a uniform UI can't imply more than was checked.

## How it wires in

- `provisioner.RunDeployV2` (`packages/core/provisioner/deploy.go`) calls `verify.Evaluate`
  right after the plan JSON is produced, attaches the `*verify.Report` to `PlanResult`, and —
  on a **non-dry-run** apply — returns an error before `tf.Apply` if any hard control is failing
  and unwaived.
- The runner (`apps/runner/internal/agent/runner.go`) puts the report on
  `execution_metadata["verify_result"]` for both PLAN and DEPLOY jobs.
- The console renders it in the **Plan** tab of the agent artifact panel
  (`apps/console/components/agent/artifact-panel.tsx`); the TS mirror of the type is
  `VerifyReport` in `apps/console/types/jsonb.types.ts`.

## Overrides (exceptions)

`verify.Override` waives specific failing control IDs so a fail-closed apply can proceed
**deliberately** (rather than disabling the gate). It is time-boxed (`Expiry`) and carries a
`Reason`/`By`. Phase 0 threads it through `DeployParams.VerifyOverride` and records it in the
logs; **Phase 1** adds the authorization workflow and seals the waiver into the evidence receipt
as a recorded exception.

## Evidence receipt (Phase 1)

After the gate decides (and any override is applied), the provisioner seals a
**`Receipt`** for the apply: the plan SHA-256, OpenTofu/provider/catalog versions, the
full per-control `Report`, any recorded exception, the runner identity, and an RFC3339
timestamp. `Sign` produces a **`SignedReceipt`** — an ed25519 detached signature over the
receipt's canonical JSON; `(*SignedReceipt).Verify(pub)` re-derives the canonical bytes and
checks the signature, so any change to the receipt body or signature is detected offline.

```go
r := verify.BuildReceipt(verify.BuildReceiptParams{Report: rep, PlanBytes: planBytes, ...})
priv, keyID, ok, _ := verify.SigningKeyFromEnv()      // ALETHIA_RECEIPT_SIGNING_KEY (base64 ed25519)
signed, _ := verify.Sign(r, priv, keyID)              // attach to PlanResult / execution_metadata
_ = signed.Verify(pub)                                // offline verification by anyone with the pubkey
```

The runner forwards the receipt on `execution_metadata["verify_receipt"]`; the console renders
it (signed/unsigned, plan hash, exception) with a download in the Plan tab.

**Honest framing / root of trust.** A receipt signed by Alethia's own runner only attests
"Alethia asserted this". For it to carry weight with a customer's auditor, sign with a key the
**customer controls** and/or anchor the signature in a **transparency log (Rekor)** — that is a
deployment decision; `SigningKeyFromEnv` is the seam. When no key is configured the receipt is
attached **unsigned** (`algorithm: "none"`) rather than blocking the apply — signing is additive
evidence, not a precondition for provisioning. Verdicts are described as *reproducible given the
same plan*, never as proof of compliance.

## AWS IAM Access Analyzer corroboration (opt-in)

Beyond the pattern checks, the gate can corroborate IAM policies with **AWS IAM Access Analyzer's
automated reasoning** — a *provable* statement about what a policy could grant, run pre-apply without
deploying. `verify.PolicyChecker` is the seam (kept SDK-free in this package); the AWS-backed
implementation is `packages/core/accessanalyzer` (`CheckAccessNotGranted` per action). Control
`ACCESS-ANALYZER-001` fails when a planned policy could grant any action in `DefaultDeniedActions`
(overridable); a checker error becomes `not_evaluable`, never a silent pass.

It is **off by default** (no AWS calls). The runner enables it for AWS jobs when
`ALETHIA_VERIFY_ACCESS_ANALYZER=1`, building the checker from the assumed-role config:

```go
opts := verify.Options{PolicyChecker: accessanalyzer.NewFromConfig(cfg)}
rep, _ := verify.EvaluateWithOptions(ctx, plan, opts)
```

The control logic is unit-tested with a fake checker; live API calls are integration-only (need creds).

## AI-assisted remediation — the safety spine

The division of labor is strict: the **deterministic gate is the trusted verdict; an LLM may only
propose**. `ReVerify(ctx, original, candidatePlan)` is the gate that makes an AI remediation loop
safe — it evaluates a candidate (post-fix) plan and reports which original failures it `Resolved`,
which are `StillFailing`, and which it made `NewlyFailing` (a regression). `Accepted` is true **only**
when every original failure is resolved and nothing new fails. An LLM-proposed fix is offered to the
user only if it passes this gate — the model is never trusted to self-judge, and the loop cannot make
the plan worse. (The LLM call itself is a higher layer; this package owns the deterministic decision.)

`RunRemediationLoop(ctx, original, remediator, maxAttempts)` is the **bounded** harness around it: it
asks a `Remediator` (the injected LLM + re-plan, implemented in the console/runner) for a candidate
plan each round, re-verifies against the original, and stops the moment one is `Accepted` or attempts
run out — so "AI proposes, the gate disposes" can never loop forever or apply an unverified fix.

## Adding / changing a control

1. Add a `control…` function in `verify.go` returning a `ControlResult`. Use `resolveStatus` so
   the pass / fail / warn / not_evaluable / vacuous-pass precedence stays consistent.
2. Reuse the policy helpers in `policy.go` (`parseIAMPolicy`, `attrUnknown`, `toStringSlice`, …) —
   they already handle string-vs-array IAM fields and unknown values.
3. Add a fixture under `testdata/` and a case in `verify_test.go` (always include a
   `not_evaluable` case for any control that reads a body that can be computed).
4. **Bump `CatalogVersion`** in `types.go` whenever a change could alter a verdict — old receipts
   are only meaningful against the catalog that produced them.

## CLI — run the gate on any plan today

`cmd/elench-verify` runs the gate over a plan JSON outside the runner — for local checks, CI gating,
or producing the corpus measurement:

```bash
go build -o elench-verify ./packages/core/verify/cmd/elench-verify
tofu show -json tfplan | elench-verify          # human report; exit 2 if the verdict blocks
elench-verify -json plan.json                    # machine-readable report on stdout
```

Exit codes: `0` pass/warn/not_evaluable · `2` blocking (fail) · `1` usage/parse error — so it drops
straight into a CI step.

## Tests & the corpus harness

```bash
# unit tests
go test ./packages/core/verify/...

# Phase-0 go/no-go measurement over real plans (skipped if no corpus):
ELENCH_CORPUS_DIR=/path/to/plan-jsons go test ./packages/core/verify -run TestCorpus -v
```

For false-PASS / false-DENY rates, drop a `labels.json` in the corpus dir mapping each plan
filename to its expected verdict (`"pass"` / `"fail"`). The harness then flags any plan that
should have been blocked but wasn't (false-PASS) or was blocked but shouldn't have been
(false-DENY) — the signal that decides whether the gate is trustworthy enough to build the
signed-receipt work (Phase 1) on top of.

## Note on the engine

Phase 0 ships a **pure-Go** evaluator (no external policy runtime — fully testable offline). The
`Evaluate(ctx, *tfjson.Plan) (*Report, error)` seam and the `Report` contract are engine-agnostic:
Phase 1 may swap in **OPA/Rego** bundles (customer-authorable controls) and AWS IAM Access
Analyzer corroboration behind the same contract without touching any caller.
