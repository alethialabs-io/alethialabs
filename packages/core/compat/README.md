<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# `compat` — the version-compatibility matrix + preflight engine (seam)

Cluster Kubernetes, the platform components (ArgoCD / Talos / Cilium / hcloud CCM +
CSI), and the add-on charts are **independently versioned** with real compatibility
constraints — constraints that today are discovered **only at apply time, per config**.
The overnight real-apply proved the cost: ArgoCD chart 7.1.3 (v2.11) couldn't diff
Deployments on a K8s 1.33+ cluster (`.status.terminatingReplicas`, [#1165]) → `sync=Unknown`
and GitOps never converged. That knowledge lived only as scattered code comments.

This package makes it **data** — a declarative matrix (`matrix.json`) — and a pure engine
that evaluates a proposed config against it into a structured `Report`. It is the
interface-first **seam** of epic #1186: the loader, the types, and the engine, seeded with
the known couplings. Downstream units enrich the data and wire the two gates.

## Single source of truth, two projections

`matrix.json` is embedded here for the Go engine (`//go:embed`) and code-generated into
TypeScript (`apps/console/scripts/gen-matrix.mjs` → `apps/console/lib/compat/generated/matrix.ts`)
for the console — the same discipline the `catalog` package uses, so Go and TS never drift.
The Kubernetes-version SSOT itself stays in `packages/core/catalog/catalog.json`; this matrix
**references** those version families, it does not redefine them.

## Why "honest" is load-bearing

The matrix does **not** know everything: an add-on's upstream `kubeVersion` window may not be
recorded yet, or a component version may be one we've never pinned. The cardinal rule (borrowed
verbatim from [`verify`](../verify/README.md)): **never report a pass on something we could not
judge.** Such cases are `not_evaluable` with a plain-language `coverage` note — never a vacuous
pass. A version with **no recorded window** (both bounds empty) is `not_evaluable`; an empty
*single* bound is unbounded on that side (a real, evaluable constraint).

## The Report contract

`compat.Report` mirrors `verify.Report` 1:1 — `Status` (`pass` / `fail` / `warn` /
`not_evaluable`), `Severity`, `Finding`, `ControlResult`, `Summary`, plus `Override` and
`Report.Unwaived`. The shapes are **redeclared** here, not imported: the two engines stay
disjoint and independently versioned (`compat-matrix-0.1.0` vs `elench-controls-0.4.0`). The
Go type names match `verify` (`compat.Report`); the generated TS mirror is `CompatReport`
(no package namespace).

`Evaluate(Subject) *Report` is pure and deterministic — same config → same verdict, no I/O,
no clock — and emits granular per-coupling controls:

| Control ID | Checks |
| --- | --- |
| `COMPAT-K8S-CLOUD-<PROVIDER>` | the cluster K8s minor is offered by the cloud |
| `COMPAT-COMPONENT-<ID>` | the K8s minor is within the component version's window |
| `COMPAT-ADDON-<ID>` | the K8s minor is within the add-on's window |

`Verdict` rolls up by precedence **fail > warn > not_evaluable > pass** (an empty report is
`not_evaluable`).

## The two gates (downstream)

The matrix feeds a **two-gate** design (epic #1186), neither wired by this seam:

- **Warn at config** (non-blocking) — `buildConfigSnapshot` surfaces `warn`/`fail` in the UI so
  a mismatch is guided away before save.
- **Block at apply** (fail-closed, override-only) — a blocking `Report` surfaces as `COMPAT-001`
  (the reserved `ControlGateID`) through the same `Unwaived`/`Override` machinery `verify` uses,
  plus `terraform_data` preconditions. Only an authorized, time-boxed `Override` lets a real
  apply proceed.

## Seeded couplings

`matrix.json` seeds the known couplings from the code they previously hid in:

- **ArgoCD ↔ K8s** — `8.6.4`→`v3.1.8`→`≥1.33`; `7.1.3`→`v2.11`→`≤1.32` (`argocd/versions.go`, #1165).
- **Talos ↔ K8s** — `v1.13.6`→`1.31–1.36` (`cloud/hetzner_provider.go`, `hetzner/variables.tf`).
- **Cilium ↔ K8s** — `1.19.6`→`≤1.35` (`hetzner/cilium.tf`).
- **hcloud-CSI ↔ K8s** — `2.22.0`→`1.34–1.36` (`hetzner/csi.tf`).
- **K8s ↔ cloud** — supported minors per managed cloud (mirrored from the catalog).
- **Add-on ↔ K8s** — the 19 charts, seeded with **empty windows** (no upstream data yet →
  honest `not_evaluable`); deriving real windows is #1213/#1216.
- **Static build couplings** — infracost / OpenTofu Go const ↔ Dockerfile ARG, carried as data
  (the SSOT a CI guard asserts against); no per-config subject, so the engine emits no control.

## Regenerate

```sh
node apps/console/scripts/gen-matrix.mjs   # → apps/console/lib/compat/generated/matrix.ts (committed)
```

The `gen:matrix` package script + CI drift-check are #1217.

[#1165]: https://github.com/alethialabs-io/alethialabs/issues/1165
