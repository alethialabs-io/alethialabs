<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# `drift` — continuous drift posture (the "keep proving it" half)

Turns the `resource_drift` section of an OpenTofu **`plan -refresh-only -json`** into a
compact, storable per-environment `Posture` (`in_sync`, `drifted` count, per-resource
`kind` ∈ modified/deleted/other). Pure and deterministic — `Analyze(*tfjson.Plan) *Posture`.

A scheduled refresh-only job (cadence tiered by environment criticality, to bound provider-API
cost) runs `tofu plan -refresh-only`, calls `Analyze`, and stores the posture row; the result
feeds the same evidence timeline as the apply-time gate so the headline — "and keeps proving
it" — is literally true.

**Not every refresh delta is drift.** A provider routinely returns a value its own create never
recorded — an unset collection coming back empty, a deprecated field newly hydrated. Reporting
those means a *clean* apply reads as 28% drifted on day zero, which is how a detection feature
loses its reader (#2358: 9 of 32 Azure resources, minutes after `Apply complete!`). `normalize.go`
classifies them out on two rules, and both are deliberately narrow:

| Rule | Fires on | Why it cannot hide a real change |
|---|---|---|
| `empty_collection` | `null`/absent ↔ an **empty** list or map, either direction, any depth | A collection's meaning is its element set; `null` and `[]` both have ∅. Hiding something real needs an element to appear or disappear — and then the other side is non-empty and the rule does not fire. Scalars are excluded: `""`, `0`, `false` are not interchangeable with null. |
| `undeclared_collection` | `null`/absent → a **non-empty** collection, at depth 0, on an attribute the configuration does not declare, not sensitive | If state records null after a successful create, the provider's own Read returned null then. A later populated read is the provider's behaviour changing, not the infrastructure. |

Only a pure `update` is ever dismissible, both sides must parse as objects, and there must be at
least one differing leaf — so a change carrying no readable diff stays drift rather than being
dismissed vacuously. A resource is dismissed only when **every** differing leaf qualifies; one real
delta anywhere keeps the whole resource.

Dismissals are **counted and named**, not dropped: `Normalized` / `NormalizedDetails` record what
was examined and why it was set aside, carrying attribute *paths* and never *values* (plan JSON
values are plaintext secrets). "32 examined, 9 dismissed as representational, here they are" is a
control that can be shown to have operated; a bare `0 drifted` is not.

What `undeclared_collection` deliberately stops catching, and permanently: an out-of-band change to
an undeclared, non-sensitive, top-level collection whose state value is null — a subnet added
through the cloud console, say. That sits inside a boundary this package already declares, since
such a resource is *unmanaged* and the next paragraph says plainly that we cannot see those.

**Honest coverage.** A refresh-only plan only sees resources in state, so it detects *modified*
and *deleted-out-of-band* managed resources. It **cannot** see **unmanaged** resources (in the
cloud, not in state) — that needs a cloud inventory source (AWS Config / Cloud Asset Inventory),
tracked separately. `Posture.UnmanagedKnown` is `false` here so a consumer never implies we
checked for unmanaged resources when we did not.

```bash
go test ./packages/core/drift/...
```

Not yet wired: the scheduled job type + per-env posture storage/UI (Phase 2 infra). This package
is the tested, deterministic core those will call.
