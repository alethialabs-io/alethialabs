<!--
SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
