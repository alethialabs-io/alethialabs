<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# The elench half of the demo — prompts and beats

Four blocks. **Three of them need no cloud, no runner and no spend**, so they work when the live
demo is on fire and they work on a plane.

Every output in Blocks 1–3 was executed against this tree and pasted verbatim. Block 4 talks to
production and currently has a **known defect** — read its warning before you plan to show it.

Run these from a checkout, after:

```bash
go build -o elench-verify ./packages/core/verify/cmd/elench-verify
```

---

## The honesty lines — say these, they are the point

Say them *before* someone asks. A technical audience is looking for the overclaim, and not finding
one is the thing they remember.

- **"Reproducible given the same plan"** — never "proof of compliance". Compliance needs an auditor;
  this is a deterministic gate that leaves evidence.
- **`not_evaluable` is not a pass.** When a policy body is computed until apply, the control says so
  and the verdict carries it. A gate that silently passed what it could not read would be worse than
  no gate.
- **A vcluster is a control-plane boundary, not a hard workload boundary.** Its pods schedule on the
  host's nodes.
- **Keyless is four of five clouds.** Hetzner publishes no OIDC provider, so it takes a token. Being
  exact about the one exception is what makes the other four believable.

---

## Block 1 — The refused apply ★★

**The strongest thing you can show, and it is free.** A gate that only ever says yes is a logo.

```bash
elench-verify < packages/core/verify/testdata/fail_static_key_admin.json; echo "exit=$?"
```

```
verdict: fail   (aws, catalog elench-controls-0.5.2)
summary: pass=1 fail=2 warn=0 not_evaluable=0

[fail] KEYLESS-001 — No static IAM access keys
         aws_iam_access_key.ci: creates a long-lived static IAM access key; use OIDC federation (IRSA/WIF/AssumeRoleWithWebIdentity) instead
[pass] OIDC-001 — Federated trust is bound to a specific subject
         coverage: no resources in scope for this control in this plan
[fail] LEASTPRIV-001 — No over-broad IAM grants (named patterns)
         aws_iam_role_policy_attachment.admin: attaches over-broad AWS-managed policy AdministratorAccess
exit=2
```

**The line:** that is a plan that will not be applied. Not a warning in a log nobody reads — a
non-zero exit, in front of `tofu apply`, naming the resource and the reason.

Then the same binary on a clean plan:

```bash
elench-verify < packages/core/verify/testdata/pass_keyless_least_priv.json; echo "exit=$?"
# verdict: pass   (aws, catalog elench-controls-0.5.2)
# summary: pass=3 fail=0 warn=0 not_evaluable=0
# exit=0
```

## Block 2 — The thing it refuses to guess ★

Show this if they are sharp. It is the answer to "so it just greps the plan?"

```bash
elench-verify < packages/core/verify/testdata/not_evaluable_computed_policy.json; echo "exit=$?"
```

```
verdict: not_evaluable   (aws, catalog elench-controls-0.5.2)
summary: pass=2 fail=0 warn=0 not_evaluable=1

[not_evaluable] LEASTPRIV-001 — No over-broad IAM grants (named patterns)
         coverage: aws_iam_policy.dynamic: policy body computed until apply
exit=0
```

**The line:** the policy body does not exist until apply, so the control reports that it could not
read it rather than passing it. The verdict is a fourth state, not a rounding of pass.

Other fixtures worth having loaded: `fail_wildcard_sub.json` (a federated trust that would accept any
subject), `warn_sensitive_wildcard.json`, and the GCP/Azure pairs — same binary, provider detected
from the plan.

## Block 3 — A real cloud apply's receipt ★★

Everything above is a fixture. This is a real Hetzner cluster that existed:

```bash
cat demos/proofs/hetzner/20260827T210204Z/VERDICT.txt
```

```
hetzner: ✅ apply(18 added)→node Ready (T2-asserted)→ArgoCD Healthy+Synced (T2-asserted)→destroyed(1)
receipt:   signed=true sha256=ce439087472b
duration:  931s
```

Then the receipt itself — `demos/proofs/hetzner/20260827T210204Z/receipt.json`:

- `algorithm: ed25519`, `key_id: 642eab927ae43b69`, with the public key alongside it
- the signed body carries `plan_sha256`, `tofu_version`, `catalog_version`, the runner identity, the
  timestamp, and the full per-control report
- **verdict: `warn`** — `HCLOUD-NET-001` flags tcp/6443 and tcp/50001 open to the world

**The line to use, and do not soften it:** this is our own nightly, and it says `warn`. The receipt
records what was true, not what we would like to have been true. A receipt that always said `pass`
would be worth nothing.

### A caveat that was true until 2026-08-29, and may still be true on prod

Every committed receipt in `demos/proofs/` reads `SCOPE-001: not_evaluable`, on every cloud. That was
**not** a finding about the infrastructure — it was our own bug: `terraform_data`, the built-in no-op
resource all five templates use for their precondition guards, was not on the engine's
supported-no-controls allowlist, so the fail-closed backstop fired on every plan the product itself
produces. Fixed on `dev`; **until that promotion reaches prod, a live plan still shows
`not_evaluable`**, and the six findings will all be `terraform_data.*_guard`.

If you demo a live plan before the promotion, own it in one sentence — "that's our own guard resource,
and the gate refusing to reason about something it doesn't recognise is the behaviour we want" — and
move on. It is a better story than pretending it isn't there.

Against a live job, the same evidence through the CLI:

```bash
alethia verify show    --job <job-id>          # the per-control table
alethia verify receipt --job <job-id>          # checks the signature, prints the trust level
alethia verify receipt --job <job-id> --key <a-wrong-public-key>   # watch it refuse
```

A real one, from a production Azure plan on 2026-08-29 (job `0d9850b1`):

```
Verify: not_evaluable (azure, catalog elench-controls-0.5.2) — 3 pass, 0 fail, 0 warn, 1 not evaluable

AZURE-KEYLESS-001    pass   high   No static application/service-principal…
AZURE-FED-001        pass   high   Federated credentials bind a specific s…
AZURE-LEASTPRIV-001  pass   high   No Owner/Contributor role assignments
SCOPE-001            not_evaluable  high   Plan is within the engine's evaluable scope
```

Three real controls passing on a real subscription — no static credential, the federated credential
bound to a specific subject, and no Owner/Contributor assignment. That is the keyless claim, checked
rather than asserted.

Trust levels are explicit — `pinned` > `org` > `platform` > `self` > `none` — and the command exits
non-zero on a bad signature, so it gates a pipeline rather than decorating one.

## Block 4 — Point his own agent at the control plane ★★★

This is the beat for a programmer, and it is the one nobody else demos. Alethia exposes a
**read-only MCP server**, OAuth-gated, projecting the same tools the in-app agent uses — bounded by
*your* grants, because every tool calls a server action that runs the same authorization check.

```bash
claude mcp add --transport http alethia https://alethialabs.io/api/mcp
```

> ⚠️ **Verify this end-to-end before you demo it (#3318).** As of 2026-08-29 the endpoint answers
> `401` with a `resource_metadata` pointer to a document that is not served — it returns the console's
> HTML shell — so a client that follows RFC 9728 discovery fails to connect. The authorization-server
> half (`/api/auth/.well-known/oauth-authorization-server`) is fine, so a client that skips
> protected-resource discovery may still work. **Run the flow yourself first; if it does not connect,
> cut this block** and close on Block 3, which needs no network at all.

It will open a browser for OAuth. Then, in Claude Code:

> *"Using the alethia tools: list my projects, then for the most recently deployed one show the plan
> result and the drift posture. Is anything out of sync?"*

> *"Pull the last five jobs and tell me which failed and at which stage."*

> *"What would this project cost per month, and which resource dominates?"*

**The lines:**
- No new authority model — the agent is bounded by the actor's grants, not by a second permission
  system that has to be kept in sync.
- **Read-only at launch, deliberately.** Tools that queue jobs or edit the canvas are classified
  `in-app` and never reach an external agent. There is a CI test that fails if a new tool ships
  without an explicit audience.
- Bring your own agent. This is Claude Code; it is an ordinary MCP endpoint.

**Before the demo:** run the OAuth flow once so you are not doing it live, and have one project with
a real deploy behind it so the answers are not all empty.

---

## If you have four minutes and no cloud

Blocks 1 → 2 → 3, in that order. Refusal, then the thing it will not guess, then a real cluster's
signed receipt with an honest warning in it. That is the whole argument, and none of it can break.
