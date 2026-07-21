<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

## Controls (catalog `elench-controls-0.4.0`)

`Evaluate` detects **every** recognized cloud present in the plan and runs the **union** of those
providers' control sets — a single OpenTofu plan can mix clouds (an AWS EKS cluster alongside an Azure
role assignment, a cross-cloud migration, …), and picking one provider would silently skip the others'
keyless / least-privilege / OIDC-sub checks. Each control already filters to its own resource types, so
it is scoped to only that provider's resources. A plan with **no** recognized cloud runs all control
sets (the fail-closed default — never zero checks). `Report.Provider` is the detected set: a single
cloud by name (`aws`), a multi-cloud plan as a `+`-joined set (`aws+azure`), or `unknown`. Each control
records its own `provider` so a uniform UI can't imply coverage a control doesn't have.

**The fail-closed scope backstop (`SCOPE-001`).** Every control filters to its own resource types, so a
plan whose resources belong to no controlled provider would otherwise run every control set to a
"nothing in scope" vacuous **pass** — a silent hole for any provider the gate can't reason about (a
typo'd/custom provider, or AWS Cloud Control `awscc_`, whose resources the `aws_` controls never match).
`SCOPE-001` closes it: a plan is **evaluable** iff every managed resource belongs to a provider that is
either **controlled** (`aws`/`google`/`azurerm`/`azuread`/`hcloud`) or on the **supported-no-controls
allowlist** — clouds with no control surface *by design* (**Cloudflare** is token-auth with no
server/firewall posture the gate yet inspects), the **cluster-layer** providers that co-occur in every real
cluster plan and carry no cloud-authority surface (`talos`/`imager`/`minio`/`helm`/`kubernetes`/
`kubectl` — they configure the cluster, not a cloud IAM identity), plus the utility providers that
create no cloud authority (`random`/`tls`/`null`/`local`/`time`/`external`). Those legitimately stay a
**pass** — Alethia's shipped Hetzner/Talos template is `hcloud`+`talos`+`imager`+`minio`+`helm`, so
without the cluster-layer group a real Hetzner provision would wrongly flip to not_evaluable (the
`hcloud` half now runs its own **posture** control set — see the Hetzner table below — rather than being
a vacuous pass). Any
resource from a provider outside that union makes the report **`not_evaluable`** (with an honest
per-resource note naming the unrecognized provider) rather than a pass — the gate never implies it
checked infrastructure it cannot see. It does **not** blanket-deny: a controlled cloud's real violation
still hard-fails (fail precedence over not_evaluable), and an unrecognized provider only demotes an
otherwise-clean plan from pass to not_evaluable. The control is emitted only when it fires (a
fully-recognized plan keeps its exact control list) and is deliberately kept out of the corpus
fail-coverage/mutation gates since it never emits `fail`.

**This is an evidence-integrity backstop, not a deny-gate.** `not_evaluable` is non-blocking (like
every other honest `not_evaluable` — computed IAM policies, opaque role-def ids): it stops the gate
forging a *verified/pass* receipt on a plan it could not inspect, but it does **not** by itself block
`tofu apply` (only a hard `fail` does). So an all-unrecognized-provider plan still applies — with an
honest "not evaluated" receipt rather than a false pass. **Alibaba** (`alicloud`) now has an authored
control set (RAM/RRSA — see the table below), so it is a **controlled** provider, not on the
no-controls allowlist: an Alibaba plan is genuinely inspected.

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

**Alibaba** — *RAM/RRSA authority, mirrors the AWS set.* Alibaba has a real RAM/OIDC surface: RRSA
(RAM Roles for Service Accounts) is its OIDC workload-identity mechanism (analogue of AWS IRSA / GCP
WIF), so its controls assert keyless / bound-subject / least-privilege just like AWS. The RAM trust +
policy documents share AWS IAM's `Effect/Action/Resource/Principal/Condition` shape (`Version:"1"`), so
the AWS parser + `subjectIsBound` are reused — the only Alibaba difference is the trust **action**
(`sts:AssumeRole`, not `sts:AssumeRoleWithWebIdentity`).

*Real-plan shape (verified against OpenTofu 1.12.3 + aliyun/alicloud v1.285.0; every `alibaba_*` corpus
fixture is a real `tofu show -json` capture):* the writable trust attribute is `assume_role_policy_document`
and the writable policy body is `policy_document`; the provider ALSO emits a **computed read-only
`document` mirror** (`after_unknown:true` on a create plan), so the controls read the writable attribute
first and never mis-read the computed mirror as `not_evaluable` (`document` is the fallback for older
provider versions where it was the writable attr).

| ID | Title | Hard-fail on |
|----|-------|--------------|
| `ALI-KEYLESS-001` | No static RAM access keys | creating an `alicloud_ram_access_key` (use RRSA / AssumeRoleWithOIDC instead) |
| `ALI-OIDC-001` | RRSA trust bound to a specific subject | an `alicloud_ram_role` whose Federated (RRSA) trust **lacks an `oidc:sub` condition**, or binds it only with a **`StringLike` wildcard** (any pod from the issuer can assume). Service-principal roles are out of scope; a computed trust doc → **not_evaluable**. |
| `ALI-LEASTPRIV-001` | No over-broad RAM grants (named patterns) | an `alicloud_ram_policy` granting `Action:"*"` on `Resource:"*"` or using `Allow` + `NotAction` (everything-but-a-few); or a **role/user/group** policy attachment (`alicloud_ram_{role,user,group}_policy_attachment`) of an admin-family System policy — `AdministratorAccess`, or `AliyunRAMFullAccess` (control of RAM itself = admin one hop away, the IAMFullAccess analogue). **Warns** on a service-level wildcard (`ecs:*`,…) with `Resource:"*"`. **Not-evaluable** when the policy body is computed until apply, or for a **non-admin System** attachment (its body is never in the plan — an honest coverage gap, mirroring AWS's managed-policy-by-ARN handling; this is also where `AliyunSTSAssumeRoleAccess` deliberately lands — the AssumeRole *call* is still gated by each target role's trust policy, which `ALI-OIDC-001` audits). |

**Hetzner** — *posture, not authority.* Hetzner is token-auth: the API token is the ceiling, there is
no OIDC/federation/IAM surface to bind, so the keyless/OIDC-sub/least-priv controls do not apply. What a
Hetzner plan *can* misconfigure is its network/firewall, so its control set asserts that. Hetzner is the
only cloud with a real nightly apply, so these are tuned to keep the **shipped template warns-only**.

*Real-plan shape (verified against OpenTofu 1.12.3 + hcloud 1.66.0; every `hetzner_*` corpus fixture is
a real `tofu show -json` capture):* `firewall_ids` is a set-typed computed attribute — on a create plan
it serializes as `after:null` + `after_unknown:true` for BOTH a firewalled and a bare server, so
`HCLOUD-FW-001` judges from the plan's **`configuration`** section (`expressions.firewall_ids.references`).
And a fully-known firewall `rule` list appears in `after_unknown` as per-element **all-false** maps
(`source_ips: [false,false]`) — only a `true` leaf means unknown; treating any list as unknown would make
the controls inert on every real plan (the exact defect an adversarial grill caught in v1).

| ID | Title | Hard-fail on |
|----|-------|--------------|
| `HCLOUD-FW-001` | Every server is behind a firewall | an `hcloud_server` with **no firewall anywhere**: no known `firewall_ids` value, no configuration reference to an `hcloud_firewall`, and no `hcloud_firewall_attachment` whose config `server_ids` references it — a bare public node. **Pass** when the (computed) `firewall_ids` is proven by a config reference / non-empty literal, or an attachment covers it. **Not_evaluable** (never a false brick): `firewall_ids` from an unresolvable expression (var/local), attachments selecting by `label_selectors`, any firewall using `apply_to` (label-based BYO), or a plan with no configuration section at all. A **decoy** attachment covering only *other* servers does **not** neutralize the fail. |
| `HCLOUD-NET-001` | No world-open SSH; management ports flagged | a firewall rule opening **tcp** SSH (`22`, or an `any`-port tcp rule subsuming 22) to the whole internet — where "whole internet" is a **union** judgment: `0.0.0.0/0`, `::/0`, or a split-CIDR spelling (`0.0.0.0/1` + `128.0.0.0/1`) that adds up to full coverage. Talos runs no SSH daemon, so world-open 22 is always wrong. **Warns** (by design, does not block) on world-open tcp Kubernetes API `6443` / Talos apid `50000`/`50001` (open on purpose today — the runner reaches the API/apid externally; K8s mTLS + Talos machine identity is the auth layer), on any other world-open inbound rule (other tcp ports, **udp/icmp — never misjudged as SSH**), and on tcp/22 from a very broad partial source (v4 ≤ /8, v6 ≤ /16). Rules with computed source/port → **not_evaluable**. |

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

**Customer-controlled root of trust (#884).** The `Signer` seam (`signer.go`) lets an org's receipts
be signed by a key the **customer** custodies — non-repudiation *against Alethia*, not just a
platform self-attestation. Custody model **A**: the key lives in the customer's cloud (KMS-native
ed25519 on AWS/GCP; a secret store elsewhere) and Alethia holds **no usable key at rest** — only a
**reference + the public key** (`org_signing_key` table, console-side). The runner invokes it under
the customer's revocable, audited keyless grant at sign time. `SignReceiptWith(receipt, signer)`
embeds the signer's public key (`SignedReceipt.PublicKey`) so a downloaded receipt is
**self-verifiable** offline (`VerifySelf`); but *"is this the org's key?"* is answered against the
retained `key_id→public_key` history (`VerifyTrusted`), never by trusting the embedded key. A
registered key is `pending_verification` until a runner **proof-of-possession** job confirms real
control of `key_ref`; a project on a cloud that doesn't match the active key falls back to the
platform key / unsigned, **surfaced honestly**. Concrete per-cloud signers and the proof job are
follow-ons.

**Transparency-log anchor (#885).** A signed receipt is tamper-evident but a verifier has no
third-party proof it *existed in a permanent record*. `RekorAnchor` (`rekor.go`) closes that: the
receipt's digest is entered into a **Rekor** transparency log as a `hashedrekord` (hash-only — the
receipt body, which references customer plan data, is never uploaded) and the returned inclusion
proof is stored **on the receipt** (`SignedReceipt.Rekor`), making a downloaded receipt
offline-verifiable by any third party with no callback. Because `hashedrekord` verifies a bare
digest and PureEd25519 does not (rekor#851), the logged signature is a **dedicated platform
ECDSA-P256 "anchor signature"** over `sha256(canonical receipt)`, SEPARATE from the ed25519 receipt
signature. `VerifyAnchor(receipt, anchor, logKey)` re-checks the whole chain offline (anchor-sig
binding → logged-entry binding → the log's signed inclusion promise (SET) → the RFC 6962 Merkle
audit path). Anchoring runs **console-side** and opt-in (`ALETHIA_REKOR_ANCHOR_ENABLED`), fail-open
(never blocks an apply). Split-view detection (a consistency monitor / witness) and an RFC 3161
timestamp are the named "keep proving it" follow-ons; the signed checkpoint is stored for them.

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
