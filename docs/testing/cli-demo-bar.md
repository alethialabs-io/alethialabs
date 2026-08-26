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

## A ceiling is two claims, not one

A `CloudManual` step used to record one fact — *no cloud API can reach this* — and fail the bar on
it forever. That is only half of what a reader needs. The other half changes: **has the human
actually done it?**

The cost of collapsing the two was measured. On 2026-08-26 the bar was FAILing on every cloud, on
every run, with **zero** CLI gaps. The entire failure was two ceilings, and both had already been
met: `e2e.alethialabs.io` was delegated and ACM had issued against it ([#1773] closed), and the
Hetzner Object Storage keys had been minted and stored ([#2332] closed). Nothing the bar could
observe had changed, so nothing it reported could change either.

Every ceiling now carries a `SatisfiedBy` probe, and the probe reads something **outside** the
table that would be false if the work had not been done:

| Probe | Reads | Why it cannot be faked |
|---|---|---|
| `zone_delegated` | an `NS` lookup on the public internet | a hosted zone you created answers with an **empty** name-server set; only a parent delegation answers with one |
| `env_truthy` | a presence boolean rendered from a repo secret | the workflow passes `secrets.X != ''`, never the secret; and the probe demands **truthy**, because `"false"` is exactly what a *missing* secret renders |

A satisfied ceiling **passes** the bar and is **still printed** — a prospect deserves to know the
manual step exists before they hit it. An outstanding one fails and prints both what the probe read
and what would satisfy it, so the proof bundle carries a remedy rather than only a complaint.

Every direction fails closed: unset, empty, whitespace, `"false"`, an empty answer, a resolver error
and a timeout all read as **unsatisfied**. `ScoreCLIDemo` stays pure and never runs a probe, so a
caller that forgets to evaluate gets the strict answer, never a laxer one.

## Status — 2026-08-26

Scored against `alethia` built from `dev`. Every `CLIDriven` claim below is **executed**, not
asserted: the run half runs `alethia <cmd> --help` for each and fails on a non-zero exit.

| Cloud | CLI-driven | CLI gaps | Ceilings | of which satisfied | Console by design | Verdict |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **AWS** | 19 | 0 | 1 | 1 | 1 | ✅ |
| **GCP** | 19 | 0 | 2 | 1 | 1 | ❌ [#1871] |
| **Azure** | 19 | 0 | 1 | 1 | 1 | ✅ |
| **Alibaba** | 19 | 0 | 2 | 1 | 1 | ❌ [#2333] |
| **Hetzner** | 19 | 0 | 2 | 2 | 1 | ✅ |

The verdict column is what the scored table plus the current satisfaction state resolves to; the
**recorded** proof is whichever run next dispatches this bar, as always.

**19 of 20 applicable steps are CLI-driven on every cloud, and the CLI gap column is zero.** What
still fails the bar is a ceiling nobody has met yet — GCP's billing-budgets publisher binding, which
genuinely does not exist, and Alibaba's Container Registry sweep, which **recurs** after every full
bar rather than retiring once.

That distinction is the one worth carrying into a demo. Nothing red here is ours: every remaining ❌
is a thing the cloud does not offer an API for **and** that has not been done by hand, not a thing
Alethia has not built.

[#1773]: https://github.com/alethialabs-io/alethialabs/issues/1773
[#2332]: https://github.com/alethialabs-io/alethialabs/issues/2332
[#1871]: https://github.com/alethialabs-io/alethialabs/issues/1871
[#2333]: https://github.com/alethialabs-io/alethialabs/issues/2333

### The CLI gap that closed — [#2331]

**`alethia verify receipt` shipped.** It pulls a job's signed evidence receipt, checks its ed25519
signature, and exits non-zero when it cannot — so a customer can gate their own pipeline on it.
`alethia verify show` prints the per-control report behind the verdict, `not_evaluable` controls and
any `RecordedException` included.

The signature is checked against a key the control plane **vouches for** — the organization's own
recorded signing key, or the platform key — and not merely against the public key the receipt
carries about itself. That distinction is the entire value of the command: a receipt always
verifies under its own embedded key, whoever made it, so self-verification would have proved only
that the document was not altered in transit. `GET /api/cli/signing-keys` serves the trusted set,
and `--key` / `--key-file` pin a key supplied out of band for an auditor who trusts nothing the
control plane says about itself.

Proof is a headline differentiator (#845 asks the demo to *surface the verify receipt*), and
`docs/compliance/soc2-e2e-matrix.md` is explicit that the receipt ledger — not the test suite — is
the operating-effectiveness record an auditor samples. The answer to "let me verify one" is now a
command, not "open the console".

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

The run half asserts every verdict in both directions. A `CLIDriven` step must resolve
(`alethia <cmd> --help` exits 0), and a `CLIGap` step must NOT — so a gap cannot be quietly left in
the report after somebody closes it, and a claim cannot be quietly left in after somebody renames
the command. #2331 is the ratchet working as designed: shipping `alethia verify receipt` turned
`TestT2CLIDemoReachability` red on purpose, and going green again required editing this table.

`TestCLIDemoBarFailsOnlyOnCloudCeilings` pins the same thing from the other side, and its two
assertions are deliberately opposed:

- **zero `CLIGap`s** — the CLI debt is cleared, so a new gap must be a deliberate, visible edit
  with an issue and a row here, never a silent regression;
- **still not `Passed()`** — nobody declares the bar met while a ceiling forces a human into a
  cloud console mid-demo.

Deleting it is how somebody states, on the record, that the bar is met.

[#1773]: https://github.com/alethialabs-io/alethialabs/issues/1773
[#1871]: https://github.com/alethialabs-io/alethialabs/issues/1871
[#2331]: https://github.com/alethialabs-io/alethialabs/issues/2331
[#2332]: https://github.com/alethialabs-io/alethialabs/issues/2332
[#2333]: https://github.com/alethialabs-io/alethialabs/issues/2333
