<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The CLI-only demo bar

Living status for one question: **can the whole product be driven from the terminal?**

Every other board here tracks whether the *platform* works. This one tracks whether the *product is
reachable* — whether a prospect gets from an empty account to a running, verified, torn-down cluster
using `alethia` alone. Until `test/e2e/t2_cli_demo.go` existed, nothing asserted it, and the
console-only gaps were discoverable only by trying them one at a time in front of an audience.

Harness: `test/e2e/t2_cli_demo.go` (the table) · `t2_cli_demo_pure_test.go` (shape, every PR, free) ·
`t2_cli_demo_run_test.go` (`e2e_t2` — checks the table against a REAL binary). Gate:
`E2E_CLI_DEMO` repo variable, with `E2E_CLI_BIN` naming the binary under test.

## The bar

A cloud clears the bar when **every applicable step is CLI-driven**. Two verdicts fail it and one
does not:

| Verdict | Meaning | Scores |
|---|---|---|
| `CLIDriven` | completes through `alethia`, no console | ✅ |
| `CLIGap` | the product does it; the CLI cannot reach it — **our debt** | ❌ FAIL |
| `CloudManual` | no API exists cloud-side; a human must open a console | ❌ FAIL |
| `ConsoleOnly` | deliberately human-in-the-loop; must name why | — set aside |

`CLIGap` and `CloudManual` both fail **by maintainer ruling**: a prospect cannot tell whose fault the
click is, and neither can their procurement team. They are recorded apart because the remedies
differ — the same reason `MaxConfigStateProof` keeps `.Excluded` and `.Deferred` in separate lists.

## Status — 2026-08-11

Scored against `alethia` built from `dev` at `1fbb6ad9`. Every `CLIDriven` claim below was
**executed**, not asserted: the run half runs `alethia <cmd> --help` for each and fails on a
non-zero exit.

| Cloud | CLI-driven | CLI gaps | Cloud ceilings | Console by design | Verdict |
|---|:---:|:---:|:---:|:---:|:---:|
| **AWS** | 18 | 1 | 1 | 1 | ❌ |
| **GCP** | 18 | 1 | 2 | 1 | ❌ |
| **Azure** | 18 | 1 | 1 | 1 | ❌ |
| **Alibaba** | 18 | 1 | 2 | 1 | ❌ |
| **Hetzner** | 18 | 1 | 2 | 1 | ❌ |

**18 of 20 applicable steps are CLI-driven on every cloud.** The two that are not are the same two
everywhere, plus one extra ceiling on GCP, Alibaba and Hetzner.

### The one CLI gap — [#2331]

**`alethia verify receipt` does not exist.** `alethia jobs get` renders a one-line verdict summary
from `execution_metadata["verify_result"]` (`apps/cli/cmd/jobs_get.go:81`). There is no way from the
terminal to pull the receipt, check its ed25519 signature, confirm it is sealed to `PlanSHA256`, or
read the per-control report and any `RecordedException`.

Proof is a headline differentiator (#845 asks the demo to *surface the verify receipt*), and
`docs/compliance/soc2-e2e-matrix.md` is explicit that the receipt ledger — not the test suite — is
the operating-effectiveness record an auditor samples. Today the answer to "let me verify one" is
"open the console".

### The cloud ceilings

| Ceiling | Clouds | Issue |
|---|---|---|
| Public DNS zone delegation — a registrar action, outside every cloud's API. The full bar proves the `dns` kind but **not** the cert path, on any cloud | all | [#1773] |
| Hetzner Object Storage keys — Hetzner ships no API that mints them | hetzner | [#2332] |
| GCP billing-budgets publisher binding — an out-of-band Cloud Console grant | gcp | [#1871] |
| Alibaba prepaid CR EE release — `payment_type = "Subscription"`, not released by `tofu destroy`, and teardown reports clean anyway | alibaba | [#2333] |

### The one deliberate console step

**Promotion approval.** `alethia promotion` is list/get only, and the approve verb is deliberately
absent: a gate whose whole value is that a named human saw and accepted a change must not be
scriptable, or it stops being a control. `alethia ops approve` exists for break-glass and is audited
as such.

This is the only verdict in the table that is a design decision rather than a gap. It is also the
verdict an author would reach for to turn a red table green, so it carries the burden of proof — if
it ever stops being true it becomes a `CLIGap`, not a quietly-edited `Why`.

## Two things this bar does NOT claim

- **It does not provision.** The question is reachability, and reachability is answered by the
  command surface; the provisioning half is already proven by the base T2 spine, and re-driving it
  through the CLI would double the bill to re-prove it.
- **MCP is not a demo driver.** `apps/console/app/api/mcp/route.ts` exposes only read/both tools —
  HITL proposals, canvas tools and job-queuing writes are excluded by construction. MCP is a
  **read/verify** surface. Any claim that the product is "drivable from MCP" must say that.

## The ratchet

The run half asserts each gap is **still real**: `alethia verify receipt --help` must NOT resolve.
The day somebody ships it, `TestT2CLIDemoReachability` goes red and the table has to record the win.
A fixed gap left in the report understates the product to the exact audience the report is written
for, so closing one is a deliberate, visible edit — never something that silently happens.

`TestCLIDemoBarIsNotYetMet` pins the same thing from the other side: it fails if a cloud starts
passing. Deleting it is how somebody states, on the record, that the bar is met.

[#1773]: https://github.com/alethialabs-io/alethialabs/issues/1773
[#1871]: https://github.com/alethialabs-io/alethialabs/issues/1871
[#2331]: https://github.com/alethialabs-io/alethialabs/issues/2331
[#2332]: https://github.com/alethialabs-io/alethialabs/issues/2332
[#2333]: https://github.com/alethialabs-io/alethialabs/issues/2333
